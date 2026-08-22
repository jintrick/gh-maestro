'use strict';
// finalize-council.js — council の最終化（投票集計・テンプレート要約生成・
// Discussion 投稿・state 構築）
// run-council.js から require されるモジュール（独立 CLI 起動はしない。
// skill-asset-help の --help 対象外）。前例: finalize-review.js
//
// LLM は集計・要約生成に一切関与しない。tallyVotes / buildSummaryMarkdown は純粋関数で
// 乱数・時間依存を持たない（開催日は呼び出し元が渡す）。Discussion への投稿と state
// 書き出しは副作用のため、呼び出し元（run-council.js）が postComment / writeState を
// 注入する。

const { _validateAgainstSchema } = require('./json-schema');
const councilSchemas = require('../council-schemas.json');

// ── 投票集計（純粋関数・決定論的） ─────────────────────────────────────────────

/**
 * choice / agrees_with を参加者ごとに集計する。
 * - 支持票: 他の参加者の vote.choice がこの参加者を指す数
 * - 賛同票: vote.agrees_with にこの参加者が含まれる延べ数
 *
 * 順序は「支持票数の降順、同票は participantOrder（グループ定義順）で安定」。
 * 乱数・時間依存なし（計画: 決定論的でなければならない箇所）。
 *
 * @param {object} opts
 * @param {object[]} opts.votes            - スキーマ検証済みの投票
 * @param {string[]} opts.participantOrder - 投票対象の参加者ID一覧（グループ定義順）
 * @returns {{ entries: object[], totalVotes: number }}
 */
function tallyVotes({ votes, participantOrder }) {
  const order = (participantOrder || []).map((id) => String(id));
  const support = new Map(order.map((id) => [id, 0]));
  const agree = new Map(order.map((id) => [id, 0]));
  const voters = new Map(order.map((id) => [id, []]));
  const agreers = new Map(order.map((id) => [id, []]));

  for (const v of votes || []) {
    if (support.has(v.choice)) {
      support.set(v.choice, support.get(v.choice) + 1);
      voters.get(v.choice).push(v.participant_id);
    }
    for (const id of v.agrees_with || []) {
      if (agree.has(id)) {
        agree.set(id, agree.get(id) + 1);
        agreers.get(id).push(v.participant_id);
      }
    }
  }

  const orderIndex = new Map(order.map((id, i) => [id, i]));
  const entries = order.map((pid) => ({
    participant_id: pid,
    supportVotes: support.get(pid),
    agreeVotes: agree.get(pid),
    voters: voters.get(pid),
    agreers: agreers.get(pid),
  }));

  // 支持票数の降順。同票はグループ定義順（orderIndex）で安定
  entries.sort((a, b) => {
    if (b.supportVotes !== a.supportVotes) return b.supportVotes - a.supportVotes;
    return orderIndex.get(a.participant_id) - orderIndex.get(b.participant_id);
  });

  // 順位はソート後の連番（1始まり）。同票はグループ定義順で安定に順序づけ済み
  entries.forEach((e, i) => { e.rank = i + 1; });

  return { entries, totalVotes: (votes || []).length };
}

// ── コメント本文 ────────────────────────────────────────────────────────────────

/**
 * 意見1件の Discussion コメント本文を生成する。
 * @param {object} op - { participant_id, opinion, stance, key_points?, risks? }
 * @returns {string}
 */
function opinionCommentBody(op) {
  const parts = [`### 意見（${op.participant_id}）`, op.opinion, `- stance: ${op.stance}`];
  if (Array.isArray(op.key_points) && op.key_points.length) {
    parts.push(`- key_points: ${op.key_points.join(' / ')}`);
  }
  if (Array.isArray(op.risks) && op.risks.length) {
    parts.push(`- risks: ${op.risks.join(' / ')}`);
  }
  return parts.join('\n\n');
}

/**
 * 投票1件の Discussion コメント本文を生成する。
 * @param {object} v - { participant_id, choice, rationale, agrees_with? }
 * @returns {string}
 */
function voteCommentBody(v) {
  const parts = [`### 投票（${v.participant_id}）`, `- choice: ${v.choice}`, `- rationale: ${v.rationale}`];
  if (Array.isArray(v.agrees_with) && v.agrees_with.length) {
    parts.push(`- agrees_with: ${v.agrees_with.join(', ')}`);
  }
  return parts.join('\n\n');
}

// ── テンプレート要約生成（純粋関数・決定論的） ────────────────────────────────

/**
 * 人間向け要約を決定論的テンプレートで生成する（LLM意味要約なし）。
 * 欠席・失敗した参加者は必須項目として必ず記載する（計画 §人間向け要約）。
 *
 * @param {object} ctx
 * @param {string} ctx.title
 * @param {string} ctx.now              - 開催日（ISO文字列。呼び出し元が渡す）
 * @param {string[]} ctx.participantOrder - 参加モデル一覧（グループ定義順）
 * @param {object[]} ctx.opinions       - [{ participant_id, opinion, stance, commentUrl? }]
 * @param {object[]} ctx.votes          - [{ participant_id, choice, rationale, agrees_with?, commentUrl? }]
 * @param {object} ctx.tally            - tallyVotes の結果
 * @param {object[]} ctx.absentees      - [{ participant_id, phase, reason }]
 * @param {string} ctx.discussionUrl
 * @returns {string}
 */
function buildSummaryMarkdown({
  title, now, participantOrder, opinions, votes, tally, absentees, discussionUrl,
}) {
  const lines = [];
  lines.push(`# council 要約: ${title}`);
  lines.push('');
  lines.push(`- 開催日: ${now}`);
  lines.push(`- 参加モデル: ${(participantOrder || []).join(', ')}`);
  lines.push('');

  lines.push('## 意見');
  lines.push('');
  if (!opinions || opinions.length === 0) {
    lines.push('（意見なし）');
  } else {
    for (const op of opinions) {
      const link = op.commentUrl ? `（[コメント](${op.commentUrl})）` : '';
      lines.push(`- **${op.participant_id}**: ${op.stance}${link}`);
    }
  }
  lines.push('');

  lines.push('## 投票結果');
  lines.push('');
  lines.push('| 参加者 | 支持票 | 賛同票 | 投票者 |');
  lines.push('|---|---|---|---|');
  for (const e of tally.entries) {
    lines.push(`| ${e.participant_id} | ${e.supportVotes} | ${e.agreeVotes} | ${e.voters.join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('### 各参加者の投票内容');
  lines.push('');
  if (!votes || votes.length === 0) {
    lines.push('（投票なし）');
  } else {
    for (const v of votes) {
      const link = v.commentUrl ? `（[コメント](${v.commentUrl})）` : '';
      const agrees = Array.isArray(v.agrees_with) && v.agrees_with.length
        ? ` / 賛同: ${v.agrees_with.join(', ')}`
        : '';
      lines.push(`- **${v.participant_id}** → ${v.choice}: ${v.rationale}${agrees}${link}`);
    }
  }
  lines.push('');

  lines.push('## ランキング');
  lines.push('');
  if (tally.entries.length === 0) {
    lines.push('（集計対象なし）');
  } else {
    for (const e of tally.entries) {
      lines.push(`${e.rank}. **${e.participant_id}**（支持 ${e.supportVotes}票 / 賛同 ${e.agreeVotes}票）`);
    }
  }
  lines.push('');

  lines.push('## 欠席・失敗した参加者');
  lines.push('');
  if (!absentees || absentees.length === 0) {
    lines.push('- なし');
  } else {
    for (const a of absentees) {
      lines.push(`- **${a.participant_id}**（${a.phase}）: ${a.reason}`);
    }
  }
  lines.push('');

  lines.push('## Discussion');
  lines.push('');
  lines.push(`- ${discussionUrl || '（URL未確定）'}`);

  return lines.join('\n');
}

// ── 最終化の実行 ───────────────────────────────────────────────────────────────

/**
 * council の最終化を実行する: 意見・投票のコメント投稿 → 投票集計 →
 * テンプレート要約投稿 → state 構築（complete）。
 *
 * 全投票をスキーマ再検証し、1件でも違反があれば throw（フェイルクローズ: 集計しない）。
 * postComment は本文からコメントURL（string）を返し、投稿失敗時は throw する契約の
 * 注入関数。writeState は state オブジェクトを永続化する注入関数。
 *
 * 中断からの復元: 各コメント投稿の成功ごとに state.finalize をチェックポイントとして
 * 永続化する。--resume 時は finalized（state.finalize）を渡すことで、投稿済みの
 * 意見・投票・要約を再投稿せずスキップする（Discussion への重複投稿を防ぐ）。
 * 投稿と永続化は別操作のため、投稿直後にクラッシュした1件は resume 時に再投稿されうる
 * （チェックポイントは「投稿済み」を遅延記録するため。完全な冪等は GitHub 側で保てない）。
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.now
 * @param {string} opts.session
 * @param {string[]} opts.participantOrder
 * @param {object[]} [opts.opinions]
 * @param {object[]} [opts.votes]
 * @param {object[]} [opts.absentees]
 * @param {string} opts.discussionUrl
 * @param {(body: string) => Promise<string>} opts.postComment
 * @param {(state: object) => Promise<void>} opts.writeState
 * @param {object|null} [opts.finalized] - state.finalize のチェックポイント（resume 時）
 * @returns {Promise<object>} complete state
 */
async function finalizeCouncil({
  title, now, session, participantOrder,
  opinions = [], votes = [], absentees = [], discussionUrl,
  postComment, writeState, finalized = null,
}) {
  // 全投票をスキーマ検証（失敗はフェイルクローズ: 集計しない）
  const voteErrors = [];
  for (const v of votes) {
    voteErrors.push(..._validateAgainstSchema(v, councilSchemas.vote, 'vote'));
  }
  if (voteErrors.length > 0) {
    throw new Error(`finalize-council: vote schema validation failed: ${voteErrors.join('; ')}`);
  }

  // チェックポイントを復元（resume 時: 投稿済み項目はスキップ、未投稿のみ再投稿）
  const checkpoint = {
    opinions: (finalized && Array.isArray(finalized.opinions)) ? finalized.opinions : [],
    votes: (finalized && Array.isArray(finalized.votes)) ? finalized.votes : [],
    summaryCommentUrl: (finalized && typeof finalized.summaryCommentUrl === 'string')
      ? finalized.summaryCommentUrl
      : null,
  };
  const persistCheckpoint = async () => { await writeState({ finalize: { ...checkpoint } }); };

  // 意見コメント（投稿済みはスキップ。投稿成功のたびにチェックポイント永続化）
  for (const op of opinions) {
    if (checkpoint.opinions.some((x) => x.participant_id === op.participant_id)) continue;
    const url = await postComment(opinionCommentBody(op));
    checkpoint.opinions.push({ ...op, commentUrl: url });
    await persistCheckpoint();
  }

  // 投票コメント（投稿済みはスキップ。投稿成功のたびにチェックポイント永続化）
  for (const v of votes) {
    if (checkpoint.votes.some((x) => x.participant_id === v.participant_id)) continue;
    const url = await postComment(voteCommentBody(v));
    checkpoint.votes.push({ ...v, commentUrl: url });
    await persistCheckpoint();
  }

  const tally = tallyVotes({ votes, participantOrder });
  const summary = buildSummaryMarkdown({
    title, now, participantOrder,
    opinions: checkpoint.opinions, votes: checkpoint.votes,
    tally, absentees, discussionUrl,
  });
  if (!checkpoint.summaryCommentUrl) {
    checkpoint.summaryCommentUrl = await postComment(summary);
    await persistCheckpoint();
  }

  const state = {
    status: 'complete',
    session,
    title,
    discussionUrl,
    opinions: checkpoint.opinions,
    votes: checkpoint.votes,
    tally,
    summaryCommentUrl: checkpoint.summaryCommentUrl,
    absentees,
  };
  await writeState(state);
  return state;
}

/**
 * 全滅停止時の state オブジェクトを構築する（書き出しは呼び出し元）。
 * 計画: 停止状態と失敗理由を状態ファイルへ永続化する。
 *
 * @param {object} opts
 * @param {string} opts.session
 * @param {string} opts.title
 * @param {'opinion'|'vote'} opts.phase - 停止したフェーズ
 * @param {string} opts.stoppedAt       - ISO文字列
 * @param {object[]} opts.failures      - [{ participant_id, attempt, error }]
 * @returns {object}
 */
function buildStoppedState({ session, title, phase, stoppedAt, failures }) {
  return { status: 'stopped', session, title, phase, stoppedAt, failures };
}

module.exports = {
  tallyVotes,
  opinionCommentBody,
  voteCommentBody,
  buildSummaryMarkdown,
  finalizeCouncil,
  buildStoppedState,
};
