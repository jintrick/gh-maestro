'use strict';
// run-council.js — council の決定論的フェーズ機械（orchestrator 向けコーディネートスクリプト）
//
// LLM 進行役を持たない。orchestrator が直接起動し、参加者モデルたちの意見・投票を
// GitHub Discussions 上で取りまとめる:
//   council設定解決 → 事前確認(fail-closed) → 議論用worktree確保 → Discussion作成 →
//   調査結果ファイルの自動検知→そのまま初回コメント投稿→context_appendix展開 →
//   意見/投票フェーズの進行・再試行・停止 → finalize-council.js（意見/投票/要約投稿）→
//   worktree片付け。
//
// 進行判断・再試行・停止の全ロジックはここに集約する（決定論的。LLM の自由文判断は挟まない）。
// 調査の要不要判断は run-council.js のスコープ外（orchestrator がその都度判断）。
//
// 外部副作用の冪等化は state ファイル（council-<session>.json）で行う:
//   - createDiscussion は state に記録済みなら再実行しない（--resume 時に既存を再利用）
//   - 完了フェーズはスキップし、未完フェーズのみ参加者を再起動する
//   - 欠席扱い済み参加者は再起動しない
//
// 終了コード: 0=完了 / 1=usage / 2=事前確認・config不正（fail-closed。GitHub書き込みなし）/
//             3=フェーズ停止（そのフェーズで1名も成功せず全滅）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { resolveAgentConfig, resolveCouncilConfig, validateNonInteractiveTokens } = require('./shared/resolve-config');
const { parseFlags, hasHelpFlag, resolveWorkspace } = require('./shared/workspace');
const {
  resolveSession,
  councilStatePath,
  councilInvestigationPath,
  resolveWorkspaceHead,
  ensureCouncilWorktree,
  removeCouncilWorktree,
} = require('./shared/council-worktree');
const { runPhaseJobs } = require('./run-council-jobs');
const { finalizeCouncil, buildStoppedState } = require('./finalize-council');
const { acquireLeaseLock, releaseLeaseLock } = require('./shared/worker-lease');
const {
  hasDiscussionsEnabled,
  discussionCategories,
  createDiscussion,
  addDiscussionComment,
} = require('./shared/discussion-graphql');

const USAGE = 'Usage: node scripts/run-council.js [--session <id>] [--group <group>] --title <text> --body-file <agenda.md>\n'
  + '             [--context-file <ctx.md>] [--workspace <WS>] [--resume]';

const VALUE_FLAGS = ['--session', '--group', '--title', '--body-file', '--context-file', '--workspace'];
const BOOLEAN_FLAGS = ['--resume'];

const MAX_PARTICIPANT_ATTEMPTS = 2; // 参加者ごとの再試行上限（retry_policy.max_attempts と同じ値）

function printUsage(stream) {
  stream.write(`${USAGE}\n`);
  stream.write('\n');
  stream.write('Arguments:\n');
  stream.write('  --title <text>       議題タイトル（必須。セッションID自動生成の入力）\n');
  stream.write('  --body-file <path>   議題本文（Markdownファイル。必須。Discussion 本文になる）\n');
  stream.write('  --session <id>       セッションID（任意。新規時は --title から自動生成。--resume 時のみ必須）\n');
  stream.write('  --group <group>      参加グループ（council.groups のキー。省略時は default）\n');
  stream.write('  --context-file <path> 補足コンテクスト（任意。context_appendix に併記し Discussion にも投稿）\n');
  stream.write('  --workspace <path>   メインワークスペース（任意。省略時は env/CWD から解決）\n');
  stream.write('  --resume             前回の途中停止から再開する（--session 必須。完了済みなら即 exit 0）\n');
  stream.write('\n');
  stream.write('Progress markers (stdout):\n');
  stream.write('  COUNCIL_SESSION <id> / COUNCIL_WT_READY <path> / COUNCIL_PREFLIGHT_OK ... / COUNCIL_CREATED <url>\n');
  stream.write('  COUNCIL_INVEST_POSTED <true|false> / COUNCIL_PHASE_START <phase> / COUNCIL_PHASE_DONE <phase> <ok>/<total> absent=<n>\n');
  stream.write('  COUNCIL_FINISHED 0 / COUNCIL_WT_REMOVED <path> / COUNCIL_STOPPED <phase> <reason>\n');
  stream.write('\n');
  stream.write('Exit codes:\n');
  stream.write('  0  完了（少なくとも1名成功で全フェーズ完走＋要約投稿済み・worktree片付け済み）\n');
  stream.write('  1  usage エラー\n');
  stream.write('  2  事前確認・config 不正（fail-closed。GitHub への書き込みなし）\n');
  stream.write('  3  フェーズ停止（そのフェーズで1名も成功せず全滅。state に永続化済み）\n');
}

/**
 * 引数をパース・検証する。
 * @returns {{ code: number } | { opts: object, usageError: null }}
 */
function parseArgs(argv) {
  const { values, rest, exitFlagMiss } = parseFlags(argv, VALUE_FLAGS, BOOLEAN_FLAGS);
  if (hasHelpFlag(rest)) return { code: 0 };
  if (exitFlagMiss) return { code: 1, error: 'missing value for a flag' };
  if (!values['--title']) return { code: 1, error: '--title is required' };
  if (!values['--body-file']) return { code: 1, error: '--body-file is required' };
  if (values['--resume'] && !values['--session']) return { code: 1, error: '--resume requires --session' };
  if (rest.length > 0) return { code: 1, error: `unexpected argument: ${rest[0]}` };
  return {
    opts: {
      session: values['--session'] || undefined,
      group: values['--group'] || undefined,
      title: values['--title'],
      bodyFile: values['--body-file'],
      contextFile: values['--context-file'] || undefined,
      workspace: values['--workspace'] || undefined,
      resume: Boolean(values['--resume']),
    },
    usageError: null,
  };
}

// ── state 永続化 ───────────────────────────────────────────────────────────────

/**
 * state ファイルを読み込む。無い・壊れている場合は null（resume 判定・冪等性の根拠）。
 * @param {string} statePath
 * @returns {object|null}
 */
function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * state ファイルを書き出す。実行のたびに全進行状況を永続化し、--resume で復元できる
 * （plan: 進捗・状態は全部 state ファイルに置き、orchestrator が途中で切断しても
 * --resume で復元できる）。
 *
 * 一時ファイルへの書き込み + rename で原子的に更新する。直接 writeFileSync で
 * 上書きすると、書き込み途中のクラッシュで state が破損し --resume 不能になる
 * （rename は同じファイルシステム上でのみ原子的）。
 *
 * @param {string} statePath
 * @param {object} state
 */
function persistState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, statePath);
  } catch (e) {
    // rename 失敗時は一時ファイルを掃除（ベストエフォート）して失敗を伝える
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

// ── セッション排他ロック ───────────────────────────────────────────────────────

/**
 * council session を対象にした排他ロックの lockPath を返す store。
 * ロックファイルは <workspace>/.gh-maestro/council-<session>.lock。
 * session は assertValidSession（^[A-Za-z0-9_-]{1,64}$）済みのためパス構成要素として
 * 安全（path traversal 不可）。state ファイル（council-<session>.json）と対になる命名。
 *
 * @param {string} workspace
 * @returns {object} worker-lease の store インターフェース（lockPath のみ使用）
 */
function councilSessionLockStore(workspace) {
  return {
    lockPath(key) {
      return path.join(workspace, '.gh-maestro', `council-${key}.lock`);
    },
  };
}

/**
 * セッション排他ロックを取得する。保持者が非生存なら stale として自動回収する
 * （worker-lease.acquireLeaseLock の原子的ロック。EEXIST + PID/startTime 同一性検証）。
 * live な保持者がいる場合（同一 session の別プロセスが進行中）は throw。
 *
 * @param {string} workspace
 * @param {string} session
 */
function acquireCouncilSessionLock(workspace, session) {
  acquireLeaseLock(councilSessionLockStore(workspace), session);
}

/**
 * セッション排他ロックを解放する。自分が保持者でない場合は何もしない。
 *
 * @param {string} workspace
 * @param {string} session
 */
function releaseCouncilSessionLock(workspace, session) {
  releaseLeaseLock(councilSessionLockStore(workspace), session);
}

// ── 調査結果・補足コンテクスト ────────────────────────────────────────────────

/**
 * 調査結果ファイル（council-<session>.investigation.json）を読み込む。
 * 存在しなければ null。JSON が壊れている場合は警告して null（調査は任意入力であり、
 * 壊れた optional ファイルで council 全体を止めない。context_appendix が state に
 * 永続化済みなら、その後のフェーズはそちらで整合が保たれる）。
 * @param {string} workspace
 * @param {string} session
 * @returns {object|null}  { findings, sources }
 */
function loadInvestigation(workspace, session) {
  const invPath = councilInvestigationPath(workspace, session);
  if (!fs.existsSync(invPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(invPath, 'utf8'));
  } catch {
    process.stderr.write(`Warning: investigation file is corrupt, treating as absent: ${invPath}\n`);
    return null;
  }
}

/**
 * 調査結果コメントの本文（Discussion の初回コメント。SSOT。orchestrator の再編纂なし）。
 * @param {{ findings: string, sources?: string[] }} inv
 * @returns {string}
 */
function investigationCommentBody(inv) {
  const lines = ['## 調査結果', inv.findings];
  if (Array.isArray(inv.sources) && inv.sources.length) {
    lines.push('### 出典');
    for (const s of inv.sources) lines.push(`- ${s}`);
  }
  return lines.join('\n\n');
}

/**
 * 意見フェーズの context_appendix を構築する（判断⑤: 探索前提にせず全文埋め込み）。
 * 調査結果（自動埋め込み）＋補足コンテクスト（--context-file）を連結する。
 * どちらも無い場合は null（appendix 無し）。
 * @param {{ investigation?: object|null, contextFileText?: string|null }} opts
 * @returns {string|null}
 */
function buildContextAppendix({ investigation, contextFileText }) {
  const parts = [];
  if (investigation && typeof investigation.findings === 'string' && investigation.findings.length) {
    parts.push('## 調査結果（自動埋め込み）');
    parts.push(investigation.findings);
    if (Array.isArray(investigation.sources) && investigation.sources.length) {
      parts.push('### 出典');
      for (const s of investigation.sources) parts.push(`- ${s}`);
    }
  }
  if (contextFileText) {
    parts.push('## 補足コンテクスト');
    parts.push(contextFileText);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ── マニフェスト生成 ───────────────────────────────────────────────────────────

/**
 * 意見フェーズのマニフェストを構築する。
 * @param {{ session: string, title: string, agenda: string, contextAppendix: string|null,
 *          worktree: string, participants: object[] }} opts
 * @returns {object}
 */
function buildOpinionManifest({ session, title, agenda, contextAppendix, worktree, participants }) {
  const manifest = { phase: 'opinion', session, title, agenda, worktree, participants };
  if (contextAppendix) manifest.context_appendix = contextAppendix;
  return manifest;
}

/**
 * 投票フェーズのマニフェストを構築する。
 * opinions は「意見フェーズの成功者全員」の { participant_id, opinion }。投票ジョブは
 * これを参照して choice を選ぶ（validateParticipantOutput が choice を opinions の
 * participant_id に制約する）。participants は投票対象（意見成功者のうち未処理分）。
 * @param {{ session: string, title: string, agenda: string, worktree: string,
 *          participants: object[], opinions: object[] }} opts
 * @returns {object}
 */
function buildVoteManifest({ session, title, agenda, worktree, participants, opinions }) {
  return { phase: 'vote', session, title, agenda, worktree, participants, opinions };
}

// ── フェーズ実行（再試行・欠席・クォーラム） ─────────────────────────────────

/**
 * 再開時に「完了済み（成功）・欠席扱い済み」を除いた参加者を返す。
 * 計画: 完了済みジョブを再実行しない・欠席扱い済み参加者は再起動しない（冪等再開）。
 * @param {object|null} prior  - state.phases[phaseName]（未完了の場合のみ渡す）
 * @param {object[]} eligible  - そのフェーズの全対象参加者（グループ定義順）
 * @returns {object[]}
 */
function pendingParticipants(prior, eligible) {
  if (!prior) return eligible;
  const done = new Set();
  for (const r of Object.values(prior.results || {})) {
    if (r && r.status === 'success') done.add(r.participant_id);
  }
  for (const a of prior.absentees || []) done.add(a.participant_id);
  return eligible.filter((p) => !done.has(p.participant_id));
}

/**
 * 1フェーズを「失敗参加者のみの再起動」で進行させる（参加者ごとの再試行上限付き）。
 *
 * クォーラム判定・再試行・欠席処理の全ロジック（決定論的部分）:
 *   - 各ラウンドで未成功の参加者のみを partial manifest で再起動する
 *   - 再試行上限（maxAttempts）到達後も失敗が残る参加者は「欠席」として記録
 *   - タイムアウトは失敗として再試行対象（plan: タイムアウトは失敗として再試行対象に）
 *   - 成功者数が 0 のときのみ allFailed=true（クォーラム緩和: 少なくとも1名成功で続行）
 *
 * prior（再開時の進行状況）がある場合、既に成功・欠席済みの参加者は再起動しない。
 * 試行回数は参加者ごとに管理し、prior.results に記録された試行回数を引き継ぐ
 * （--resume 時に毎回 attempt=0 から数え直すと、参加者ごとの再試行上限を跨いで
 * 実質の再試行回数が増えてしまう。review指摘 #2）。
 * onRound は各ラウンド後の進行状況を state に永続化するフック（途中切断からの復元用）。
 *
 * @param {object} opts
 * @param {'opinion'|'vote'} opts.phaseName
 * @param {object[]} opts.participants   - そのフェーズの全対象（グループ定義順）
 * @param {(pending: object[]) => object} opts.makeManifest
 * @param {string} opts.workspace
 * @param {number} [opts.maxAttempts]    - 参加者ごとの再試行上限
 * @param {object|null} [opts.prior]     - state.phases[phaseName]（未完了時）
 * @param {(progress: object) => Promise<void>|void} [opts.onRound]
 * @returns {Promise<{ successes: object[], absentees: object[], results: object, allFailed: boolean }>}
 */
async function runPhaseWithRetry({
  phaseName, participants, makeManifest, workspace,
  maxAttempts = MAX_PARTICIPANT_ATTEMPTS, prior = null, onRound = null,
}) {
  const results = { ...(prior?.results || {}) };
  const absentees = [...(prior?.absentees || [])];

  // 参加者ごとの累積試行回数。prior.results に attempt が記録済みならそれを引き継ぐ
  // （resume 時に再試行上限を跨がない）。記録が無い参加者は0から。
  const attempts = new Map();
  for (const r of Object.values(prior?.results || {})) {
    if (r && typeof r.participant_id === 'string') {
      attempts.set(r.participant_id, Number.isInteger(r.attempt) && r.attempt > 0 ? r.attempt : 0);
    }
  }
  for (const p of participants) {
    if (!attempts.has(p.participant_id)) attempts.set(p.participant_id, 0);
  }

  let pending = pendingParticipants(prior, participants);
  while (pending.length > 0) {
    // 未成功の参加者のうち、再試行上限に達していない者だけ今回起動する
    const toRun = pending.filter((p) => (attempts.get(p.participant_id) || 0) < maxAttempts);
    if (toRun.length === 0) break;

    const manifest = makeManifest(toRun);
    const res = await runPhaseJobs({
      manifest,
      workspace,
      // 今回の試行回数 = 累積 + 1（runPhaseJobs が結果の attempt に反映する）
      attemptOf: (participantId) => (attempts.get(participantId) || 0) + 1,
    });
    if (!res.ok) {
      throw new Error(`council ${phaseName} phase: ${res.error || 'phase runner structural failure'}`);
    }
    for (const r of res.results) {
      results[r.participant_id] = r;
      attempts.set(r.participant_id, Number.isInteger(r.attempt) && r.attempt > 0 ? r.attempt : 0);
    }
    pending = pending.filter((p) => (results[p.participant_id] || {}).status !== 'success');
    if (onRound) await onRound({ phaseName, results, absentees });
  }

  // 再試行上限到達後の残りは欠席として記録する（成功した参加者のみで続行）
  for (const p of pending) {
    const r = results[p.participant_id] || {};
    if (!absentees.some((a) => a.participant_id === p.participant_id)) {
      absentees.push({
        participant_id: p.participant_id,
        phase: phaseName,
        reason: r.error || `failed after ${maxAttempts} attempt(s)`,
      });
    }
  }

  const successes = participants
    .map((p) => results[p.participant_id])
    .filter((r) => r && r.status === 'success');
  return { successes, absentees, results, allFailed: successes.length === 0 };
}

/**
 * 1フェーズを実行し、state へ進行状況を永続化する。全滅時は呼び出し元が停止処理を行う。
 * COUNCIL_PHASE_START/DONE を出力。
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {string} opts.statePath
 * @param {'opinion'|'vote'} opts.phaseName
 * @param {object[]} opts.eligible
 * @param {(pending: object[]) => object} opts.makeManifest
 * @param {string} opts.workspace
 * @returns {Promise<{ successes: object[], absentees: object[], results: object, allFailed: boolean }>}
 */
async function runPhase({ state, statePath, phaseName, eligible, makeManifest, workspace }) {
  process.stdout.write(`COUNCIL_PHASE_START ${phaseName}\n`);
  const prior = state.phases[phaseName] && state.phases[phaseName].status !== 'done'
    ? state.phases[phaseName]
    : null;
  const outcome = await runPhaseWithRetry({
    phaseName,
    participants: eligible,
    makeManifest,
    workspace,
    prior,
    onRound: async (progress) => {
      state.phases[phaseName] = { status: 'in_progress', ...progress };
      persistState(statePath, state);
    },
  });
  if (outcome.allFailed) {
    // 全滅: 'done' にしない。in_progress のまま残し、--resume で失敗分（欠席扱い済みで
    // ないもの）のみ再試行できる状態を復元する（stopAndCleanup が stopped を書き込む）。
    state.phases[phaseName] = {
      status: 'in_progress',
      results: outcome.results,
      absentees: outcome.absentees,
    };
    persistState(statePath, state);
    process.stdout.write(
      `COUNCIL_PHASE_DONE ${phaseName} 0/${eligible.length} absent=${outcome.absentees.length}\n`,
    );
    return outcome;
  }
  state.phases[phaseName] = {
    status: 'done',
    successes: outcome.successes,
    absentees: outcome.absentees,
    results: outcome.results,
  };
  persistState(statePath, state);
  process.stdout.write(
    `COUNCIL_PHASE_DONE ${phaseName} ${outcome.successes.length}/${eligible.length} absent=${outcome.absentees.length}\n`,
  );
  return outcome;
}

// ── リポジトリ・worktree 片付け ───────────────────────────────────────────────

/**
 * 対象リポジトリを workspace から解決する（spawn-assistant.js の resolveRepo と同パターン）。
 * 失敗時は null（フェイルクローズ。Discussion 操作の前提）。
 * @param {string} workspace
 * @returns {string|null}  `owner/name`
 */
function resolveRepo(workspace) {
  const r = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  const repo = String(r.stdout || '').trim();
  return repo || null;
}

/**
 * 議論用worktree を片付ける（完走・停止の両方）。片付け失敗時は state に残存を記録して
 * 非0（停止相当）を返し、orchestrator へ手動片付けを促す（plan）。
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {string} opts.statePath
 * @param {string} opts.session
 * @param {string} opts.worktreeDir
 * @param {string} opts.workspace
 * @param {number} opts.exitCode  - 片付けが成功した場合に返す終了コード（0 or 3）
 * @returns {number}
 */
function cleanupWorktree({ state, statePath, session, worktreeDir, workspace, exitCode }) {
  try {
    removeCouncilWorktree(workspace, session);
    state.worktreeRemoved = true;
    state.worktreeResidual = false;
    persistState(statePath, state);
    process.stdout.write(`COUNCIL_WT_REMOVED ${worktreeDir}\n`);
    return exitCode;
  } catch (e) {
    state.worktreeRemoved = false;
    state.worktreeResidual = true;
    persistState(statePath, state);
    process.stderr.write(`council worktree removal failed (manual cleanup needed): ${e.message}\n`);
    process.stdout.write(`COUNCIL_WT_REMOVED_FAILED ${worktreeDir}\n`);
    return 3;
  }
}

// ── 停止処理（全滅時） ─────────────────────────────────────────────────────────

/**
 * フェーズ全滅（1名も成功せず）の停止処理。stopped state を永続化し、worktree を
 * 片付けて終了コード3を返す。失敗理由は state に永続化済み（plan: 終了コード3・
 * human-escalation 相当）。
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {string} opts.statePath
 * @param {string} opts.session
 * @param {string} opts.title
 * @param {'opinion'|'vote'} opts.phaseName
 * @param {number} opts.eligibleCount - COUNCIL_STOPPED 出力用の対象数
 * @param {string} opts.worktreeDir
 * @param {string} opts.workspace
 * @returns {number}
 */
function stopAndCleanup({ state, statePath, session, title, phaseName, eligibleCount, worktreeDir, workspace }) {
  const phase = state.phases[phaseName] || {};
  const failures = (phase.absentees || []).map((a) => ({
    participant_id: a.participant_id,
    attempt: (phase.results && phase.results[a.participant_id] && phase.results[a.participant_id].attempt) || MAX_PARTICIPANT_ATTEMPTS,
    error: a.reason,
  }));
  const stopped = buildStoppedState({
    session,
    title,
    phase: phaseName,
    stoppedAt: new Date().toISOString(),
    failures,
  });
  Object.assign(state, stopped);
  persistState(statePath, state);
  process.stdout.write(`COUNCIL_STOPPED ${phaseName} 0/${eligibleCount} succeeded (all failed)\n`);
  return cleanupWorktree({ state, statePath, session, worktreeDir, workspace, exitCode: 3 });
}

// ── メイン処理 ─────────────────────────────────────────────────────────────────

/**
 * CLI のメイン処理。終了コードを返す（0=完了 / 1=usage / 2=fail-closed / 3=停止）。
 * 想定外の例外はフェイルクローズ（exit 2）に倒す。
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function runCouncil(argv) {
  try {
    return await runCouncilFlow(argv);
  } catch (e) {
    process.stderr.write(`Error: unexpected failure: ${e.message}\n`);
    return 2;
  }
}

async function runCouncilFlow(argv) {
  const parsed = parseArgs(argv);
  if (parsed.code === 0) {
    printUsage(process.stdout);
    return 0;
  }
  if (parsed.code === 1) {
    printUsage(process.stderr);
    process.stderr.write(`\nError: ${parsed.error}\n`);
    return 1;
  }
  const opts = parsed.opts;

  const workspace = resolveWorkspace(opts.workspace || null);
  if (!workspace) {
    process.stderr.write('Error: workspace could not be resolved (env/CWD探索または --workspace 指定が不正です).\n');
    return 2;
  }

  const homedir = process.env.HOME || process.env.USERPROFILE || '';

  // セッションIDは --title から自動生成（明示時は形式検証）。--resume では再開対象を特定
  const session = resolveSession({ session: opts.session, title: opts.title, workspace });
  const statePath = councilStatePath(workspace, session);

  // ── セッション単位の排他ロック ──
  // 同一 session を対象に複数の run-council.js プロセスが同時起動すると、
  // Discussion の二重作成・ジョブの二重実行・worktree の誤削除が起こり得る
  // （review指摘 #4）。state 読み込み〜worktree 片付けまでの全区間をロックで
  // 直列化する（worker-lease.js の原子的ロックを流用。stale ロックは自動回収）。
  let lockHeld = false;
  try {
    acquireCouncilSessionLock(workspace, session);
    lockHeld = true;
  } catch (e) {
    process.stderr.write(`Error: another process is running council session "${session}": ${e.message}\n`);
    return 2;
  }
  try {
    return await runCouncilLocked({ opts, workspace, homedir, session, statePath });
  } finally {
    if (lockHeld) releaseCouncilSessionLock(workspace, session);
  }
}

/**
 * runCouncilFlow の実体。セッション排他ロック取得済みの状態で、state 読み込みから
 * worktree 片付けまでの全区間を実行する（ロック解放は呼び出し元の finally が担う）。
 * @returns {Promise<number>}
 */
async function runCouncilLocked({ opts, workspace, homedir, session, statePath }) {
  const state = loadState(statePath) || {};

  // ── resume・冪等再実行の分岐 ──
  if (state.status === 'complete') {
    // 完走済み（--resume・再実行とも）: 再実行せず即 exit 0（冪等）
    process.stdout.write(`COUNCIL_ALREADY_COMPLETE ${state.discussionUrl || ''}\n`);
    // 完走済みだが前回の worktree 片付けに失敗した残存がある場合（worktreeResidual）は、
    // --resume で片付けを再試行する。それでも失敗すれば exit 0 に戻さず、手動片付けが
    // 必要というシグナル（exit 3 + COUNCIL_WT_REMOVED_FAILED）を維持する
    // （review指摘 #7: complete 分岐が exit 0 でこのシグナルを消していた）。
    if (state.worktreeResidual) {
      try {
        removeCouncilWorktree(workspace, session);
        state.worktreeResidual = false;
        state.worktreeRemoved = true;
        persistState(statePath, state);
        process.stdout.write(`COUNCIL_WT_REMOVED ${state.worktreeDir || ''}\n`);
        return 0;
      } catch (e) {
        process.stderr.write(`council worktree removal failed (manual cleanup needed): ${e.message}\n`);
        process.stdout.write(`COUNCIL_WT_REMOVED_FAILED ${state.worktreeDir || ''}\n`);
        return 3;
      }
    }
    return 0;
  }
  if (opts.resume && !state.session) {
    process.stderr.write(`Error: no prior council state for session "${session}" (start a new one by omitting --resume).\n`);
    return 2;
  }
  if (!opts.resume && state.session) {
    process.stderr.write(
      `Error: session "${session}" already has incomplete state (status=${state.status}). Pass --resume --session ${session} to resume, or omit --session for a new session.\n`,
    );
    return 2;
  }

  // ── 全滅停止（status=stopped）からの --resume: 停止フェーズを全参加者で再試行 ──
  // 停止時は停止フェーズの全参加者が absentees に記録されるため、通常の resume
  // （成功・欠席済みを除外）では pending が空になり再試行が機能しない。
  // stopped 再開では停止フェーズの progress をリセットし、全参加者・試行回数0から
  // 再実行する（再試行は orchestrator の手動判断。review指摘 #7）。
  if (state.status === 'stopped' && state.phase && state.phases) {
    delete state.phases[state.phase];
    state.status = 'running';
    persistState(statePath, state);
  }

  // ── config 解決（fail-closed。GitHub 書き込みなしで止める） ──
  const council = resolveCouncilConfig({ workspace, homedir });
  if (!council) {
    process.stderr.write('Error: council config could not be resolved (config.json "council" section is invalid; fail-closed).\n');
    return 2;
  }
  const groupKey = opts.group || 'default';
  const group = council.groups[groupKey];
  if (!group) {
    process.stderr.write(`Error: council group "${groupKey}" is not defined (fail-closed).\n`);
    return 2;
  }
  const configParticipants = group.agents.map((agentId) => ({ participant_id: agentId, agent_id: agentId }));
  // 再開時は state に永続化された参加者一覧を優先する（config 変更と再開を混線させない）
  const participants = state.participants || configParticipants;
  if (participants.length === 0) {
    process.stderr.write('Error: council group has no participants.\n');
    return 2;
  }
  const participantOrder = participants.map((p) => p.participant_id);

  // 参加者 agent の事前検証（fail-closed。起動引数に非対話化トークンが欠ける設定で進めない）
  for (const p of participants) {
    const agent = resolveAgentConfig(p.agent_id, { workspace, homedir });
    if (!agent) {
      process.stderr.write(`Error: participant agent "${p.agent_id}" could not be resolved (fail-closed).\n`);
      return 2;
    }
    const tokenCheck = validateNonInteractiveTokens(agent, agent.execArgs ?? agent.extraArgs);
    if (!tokenCheck.valid) {
      process.stderr.write(
        `Error: participant "${p.agent_id}" execArgs/extraArgs is missing non-interactive token(s): ${tokenCheck.missing.join(', ')} (fail-closed).\n`,
      );
      return 2;
    }
  }

  const repo = resolveRepo(workspace);
  if (!repo) {
    process.stderr.write('Error: repository could not be resolved from workspace (fail-closed).\n');
    return 2;
  }

  // ── 議題・補足コンテクスト読み込み ──
  let agenda;
  try {
    agenda = fs.readFileSync(opts.bodyFile, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: cannot read --body-file: ${e.message}\n`);
    return 2;
  }
  let contextFileText;
  if (opts.contextFile) {
    try {
      contextFileText = fs.readFileSync(opts.contextFile, 'utf8');
    } catch (e) {
      process.stderr.write(`Error: cannot read --context-file: ${e.message}\n`);
      return 2;
    }
  }

  // ── 事前確認（新規 Discussion 作成時のみ。それまでは GitHub 書き込みをしない） ──
  let categoryId = state.categoryId;
  if (!state.discussionId) {
    if (!hasDiscussionsEnabled(repo)) {
      process.stderr.write('Error: Discussions are not enabled on this repository (preflight failed; fail-closed).\n');
      return 2;
    }
    const categories = discussionCategories(repo);
    if (!categories || categories.length === 0) {
      process.stderr.write('Error: no discussion categories available on this repository (preflight failed; fail-closed).\n');
      return 2;
    }
    if (group.category) {
      const found = categories.find((c) => c.name === group.category);
      if (!found) {
        process.stderr.write(`Error: council group category "${group.category}" is not available on this repository (fail-closed).\n`);
        return 2;
      }
      categoryId = found.id;
    } else {
      categoryId = categories[0].id;
    }
    process.stdout.write(`COUNCIL_PREFLIGHT_OK discussionsEnabled=true, category=${categoryId}\n`);
  }

  // ── 議論用worktree の存在保証（冪等。resume時は再利用） ──
  process.stdout.write(`COUNCIL_SESSION ${session}\n`);
  const worktreeSha = state.worktreeSha || resolveWorkspaceHead(workspace);
  let worktreeDir;
  try {
    worktreeDir = ensureCouncilWorktree(workspace, session, worktreeSha);
  } catch (e) {
    process.stderr.write(`Error: council worktree setup failed: ${e.message}\n`);
    return 2;
  }
  process.stdout.write(`COUNCIL_WT_READY ${worktreeDir}\n`);

  // ── Discussion 作成（state に記録済みなら再作成しない。冪等） ──
  let discussionId = state.discussionId;
  let discussionUrl = state.discussionUrl;
  if (!discussionId) {
    const created = createDiscussion(repo, opts.title, agenda, categoryId);
    if (!created) {
      process.stderr.write('Error: createDiscussion failed (fail-closed).\n');
      return 2;
    }
    discussionId = created.id;
    discussionUrl = created.url;
    Object.assign(state, {
      status: 'running',
      session,
      title: opts.title,
      group: groupKey,
      participantOrder,
      participants,
      createdAt: new Date().toISOString(),
      discussionId,
      discussionNumber: created.number,
      discussionUrl,
      categoryId,
      worktreeSha,
      worktreeDir,
      investigationPosted: false,
      contextFilePosted: false,
      phases: {},
      worktreeRemoved: false,
    });
    persistState(statePath, state);
    process.stdout.write(`COUNCIL_CREATED ${discussionUrl}\n`);
  }

  // ── 調査結果ファイルの自動検知 → Discussion 初回コメント投稿 → context_appendix 展開 ──
  // 計画: 調査結果は Discussion が SSOT。orchestrator の要約・再編纂はしない。
  // resume 時は state に永続化済みの appendix を再利用し、未投稿分だけを投稿する。
  const investigation = state.investigationPosted ? null : loadInvestigation(workspace, session);
  const contextAppendix = state.contextAppendix || buildContextAppendix({ investigation, contextFileText });
  if (investigation && !state.investigationPosted) {
    const url = addDiscussionComment(discussionId, investigationCommentBody(investigation));
    if (!url) {
      process.stderr.write('Error: investigation comment post failed (fail-closed).\n');
      return 2;
    }
    state.investigationPosted = true;
    persistState(statePath, state);
  }
  if (contextFileText && !state.contextFilePosted) {
    const url = addDiscussionComment(discussionId, contextFileText);
    if (!url) {
      process.stderr.write('Error: context-file comment post failed (fail-closed).\n');
      return 2;
    }
    state.contextFilePosted = true;
    persistState(statePath, state);
  }
  state.contextAppendix = contextAppendix;
  persistState(statePath, state);
  process.stdout.write(`COUNCIL_INVEST_POSTED ${state.investigationPosted ? 'true' : 'false'}\n`);

  // ── 意見フェーズ（完了済みならスキップ） ──
  const makeOpinionManifest = (pending) => buildOpinionManifest({
    session,
    title: opts.title,
    agenda,
    contextAppendix: state.contextAppendix,
    worktree: worktreeDir,
    participants: pending,
  });
  if (state.phases.opinion?.status !== 'done') {
    const opinionOutcome = await runPhase({
      state, statePath, phaseName: 'opinion', eligible: participants,
      makeManifest: makeOpinionManifest, workspace,
    });
    if (opinionOutcome.allFailed) {
      return stopAndCleanup({
        state, statePath, session, title: opts.title,
        phaseName: 'opinion', eligibleCount: participants.length,
        worktreeDir, workspace,
      });
    }
  }

  // ── 投票フェーズ（完了済みならスキップ。対象は意見フェーズの成功者のみ） ──
  const opinionOutputs = (state.phases.opinion?.successes || []).map((r) => r.output);
  const opinionSuccessIds = new Set(opinionOutputs.map((op) => op.participant_id));
  const voteEligible = participants.filter((p) => opinionSuccessIds.has(p.participant_id));
  const makeVoteManifest = (pending) => buildVoteManifest({
    session,
    title: opts.title,
    agenda,
    worktree: worktreeDir,
    participants: pending,
    opinions: opinionOutputs.map((op) => ({ participant_id: op.participant_id, opinion: op.opinion })),
  });
  if (state.phases.vote?.status !== 'done') {
    if (!state.phases.opinion || state.phases.opinion.status !== 'done') {
      // 投票フェーズは意見フェーズ完了後にのみ到達する（state 不整合はフェイルクローズ）
      throw new Error('vote phase reached before opinion phase completed (state inconsistency)');
    }
    if (voteEligible.length === 0) {
      // 意見成功者が0は全滅停止済みのはず。防衛的停止
      return stopAndCleanup({
        state, statePath, session, title: opts.title,
        phaseName: 'vote', eligibleCount: 0,
        worktreeDir, workspace,
      });
    }
    const voteOutcome = await runPhase({
      state, statePath, phaseName: 'vote', eligible: voteEligible,
      makeManifest: makeVoteManifest, workspace,
    });
    if (voteOutcome.allFailed) {
      return stopAndCleanup({
        state, statePath, session, title: opts.title,
        phaseName: 'vote', eligibleCount: voteEligible.length,
        worktreeDir, workspace,
      });
    }
  }

  // ── 最終化（意見・投票コメント投稿 → 集計 → テンプレート要約投稿 → complete state） ──
  const voteOutputs = (state.phases.vote?.successes || []).map((r) => r.output);
  const allAbsentees = [
    ...(state.phases.opinion?.absentees || []),
    ...(state.phases.vote?.absentees || []),
  ];
  const postComment = async (body) => {
    const url = addDiscussionComment(discussionId, body);
    if (!url) throw new Error('council finalize: addDiscussionComment failed');
    return url;
  };
  const writeState = async (partial) => {
    Object.assign(state, partial);
    persistState(statePath, state);
  };

  await finalizeCouncil({
    title: opts.title,
    now: new Date().toISOString(),
    session,
    participantOrder,
    opinions: opinionOutputs,
    votes: voteOutputs,
    absentees: allAbsentees,
    discussionUrl,
    postComment,
    writeState,
    // resume 時は投稿済みコメントのチェックポイントを渡し、再投稿を防ぐ（review指摘 #1）
    finalized: state.finalize || null,
  });
  process.stdout.write('COUNCIL_FINISHED 0\n');
  return cleanupWorktree({ state, statePath, session, worktreeDir, workspace, exitCode: 0 });
}

module.exports = {
  parseArgs,
  printUsage,
  loadState,
  persistState,
  acquireCouncilSessionLock,
  releaseCouncilSessionLock,
  loadInvestigation,
  investigationCommentBody,
  buildContextAppendix,
  buildOpinionManifest,
  buildVoteManifest,
  pendingParticipants,
  runPhaseWithRetry,
  runPhase,
  cleanupWorktree,
  stopAndCleanup,
  resolveRepo,
  runCouncil,
  runCouncilLocked,
};

if (require.main === module) {
  runCouncil(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      // 想定外の例外もフェイルクローズ（fail-closed-safety-guards）
      process.stderr.write(`Error: unexpected failure: ${e.message}\n`);
      process.exitCode = 2;
    });
}
