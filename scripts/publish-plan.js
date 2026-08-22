#!/usr/bin/env node
// publish-plan.js — Issue の pin 済み計画コメントを管理する決定的スクリプト
//
// 対象 Issue のコメント一覧を取得し、既に pin されている計画コメントがあれば
// その本文を更新、なければ新規コメントを投稿して pin する。
// 計画コメントは本文先頭の機械可読マーカーで識別し、別目的で pin された
// コメントを誤って破壊しない。
//
// Usage:
//   node publish-plan.js --issue <N> --body-file <path> [--workspace <path>]
//   node publish-plan.js --issue <N> --stdin [--workspace <path>] <<'EOF'
//   <計画本文>
//   EOF
//
// workspace resolution order:
//   --workspace arg > GH_MAESTRO_WORKSPACE env > CWD upward search

'use strict';

const { spawnSync } = require('./shared/child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { toWinPath } = require('./shared/win-path');
const { resolveTextInput, StdinTTYError } = require('./shared/text-input');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const { PLAN_MARKER, isPlanComment } = require('./shared/plan-comment');

const USAGE = `publish-plan.js — Issue の pin 済み計画コメントを管理する

Usage:
  node publish-plan.js --issue <N> --body-file <path> [--workspace <path>]
  node publish-plan.js --issue <N> --stdin [--workspace <path>]

Options:
  --issue <N>           対象 Issue 番号（必須、正の整数）
  --body-file <path>    計画本文ファイルのパス（UTF-8）。--stdin と同時指定不可
  --stdin               標準入力から計画本文を読み込む。--body-file と同時指定不可
                        ヒアドキュメントの終端記号は必ずクォート付き（<<'EOF'）にすること
  --workspace <path>    ワークスペースのルートパス（省略時は環境変数またはCWDから上方探索で解決）

動作:
  1. 対象 Issue の全コメントから、計画マーカー（${PLAN_MARKER}）を
     持つ pin 済みコメントを検索
  2. 見つかればそのコメント本文を更新する（新規コメントは増やさない）
  3. 見つからなければ新規コメントを投稿し pin する
  4. マーカーを持たない pin 済みコメント（他目的の pin）は上書きしない

Output (stdout):
  投稿または更新されたコメントの URL を1行出力`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', ...opts });
};

let _ghListComments = (issue, repo, opts = {}) => {
  // publish-plan.js は (issue, repo) 順の独自インターフェース（後方互換）。
  return listComments(repo, issue, opts);
};

let _ghCreateComment = (issue, repo, body, opts = {}) => {
  return spawnSync('gh', ['api', `repos/${repo}/issues/${issue}/comments`,
    '-f', `body=${body}`], { encoding: 'utf8', ...opts });
};

let _ghUpdateComment = (commentId, repo, body, opts = {}) => {
  return spawnSync('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`,
    '-f', `body=${body}`], { encoding: 'utf8', ...opts });
};

let _ghPinComment = (commentId, repo, opts = {}) => {
  return spawnSync('gh', ['api', '-X', 'PUT', `repos/${repo}/issues/comments/${commentId}/pin`],
    { encoding: 'utf8', ...opts });
};

// ── ヘルパー ──────────────────────────────────────────────────────────────

// ── コアロジック ──────────────────────────────────────────────────────────

/**
 * Issue に pin 済み計画コメントがあれば更新、なければ新規投稿＋pin する。
 * 計画コメントは本文先頭の PLAN_MARKER と投稿者で識別する。
 * マーカーを持たない他目的の pin 済みコメントは上書きしない。
 *
 * @param {{ issue: string, body: string, workspace: string }} params
 * @param {object} [deps]  テスト用の依存注入
 * @param {function} [deps.ghRepoViewFn]
 * @param {function} [deps.ghListCommentsFn]
 * @param {function} [deps.ghCreateCommentFn]
 * @param {function} [deps.ghUpdateCommentFn]
 * @param {function} [deps.ghPinCommentFn]
 * @returns {{ ok: boolean, url?: string, error?: string, action?: 'created'|'updated' }}
 */
function publishPlan({ issue, body, workspace }, deps = {}) {
  const {
    ghRepoViewFn = _ghRepoView,
    ghListCommentsFn = _ghListComments,
    ghCreateCommentFn = _ghCreateComment,
    ghUpdateCommentFn = _ghUpdateComment,
    ghPinCommentFn = _ghPinComment,
  } = deps;

  const ghOpts = { cwd: workspace };
  // 本文にマーカーを付加する（呼び出し元が意識する必要をなくす）
  const markedBody = PLAN_MARKER + '\n' + body;

  // ── リポジトリ解決 ──────────────────────────────────────────────────────

  const repoResult = ghRepoViewFn(ghOpts);
  if (repoResult.status !== 0) {
    return { ok: false, error: `リポジトリを解決できません: ${repoResult.stderr || '(empty)'}` };
  }
  const repo = repoResult.stdout.trim();
  if (!repo) {
    return { ok: false, error: 'リポジトリを解決できません（空のレスポンス）' };
  }

  // ── コメント一覧を取得し pin 済み計画コメントを検索 ─────────────────────

  const listResult = ghListCommentsFn(issue, repo, ghOpts);
  if (listResult.status !== 0) {
    return { ok: false, error: `コメント一覧の取得に失敗しました: ${listResult.stderr || '(empty)'}` };
  }

  let comments;
  try {
    comments = parseCommentsResponse(listResult.stdout);
  } catch {
    return { ok: false, error: 'コメント一覧のJSONパースに失敗しました' };
  }

  if (!Array.isArray(comments)) {
    return { ok: false, error: 'コメント一覧の形式が不正です' };
  }

  // 計画マーカーを持つ pin 済みコメントを探す。
  // マーカーで識別することで、他目的で pin されたコメントを誤って上書きしない。
  const pinnedPlan = comments.find(isPlanComment);

  // ── 既存の計画 pin コメントを更新 ───────────────────────────────────────

  if (pinnedPlan) {
    const updateResult = ghUpdateCommentFn(pinnedPlan.id, repo, markedBody, ghOpts);
    if (updateResult.status !== 0) {
      return { ok: false, error: `pin済み計画コメントの更新に失敗しました: ${updateResult.stderr || '(empty)'}` };
    }

    let updated;
    try {
      updated = JSON.parse(updateResult.stdout);
    } catch {
      return { ok: false, error: '更新レスポンスのJSONパースに失敗しました' };
    }

    if (!updated.html_url) {
      return { ok: false, error: '更新レスポンスからURLを抽出できませんでした' };
    }

    return { ok: true, url: updated.html_url, action: 'updated' };
  }

  // ── 計画 pin コメントなし → 新規投稿して pin ────────────────────────────

  const createResult = ghCreateCommentFn(issue, repo, markedBody, ghOpts);
  if (createResult.status !== 0) {
    return { ok: false, error: `コメントの投稿に失敗しました: ${createResult.stderr || '(empty)'}` };
  }

  let created;
  try {
    created = JSON.parse(createResult.stdout);
  } catch {
    return { ok: false, error: 'コメント作成レスポンスのJSONパースに失敗しました' };
  }

  const commentId = created.id;
  const url = created.html_url;
  if (!commentId || !url) {
    return { ok: false, error: 'コメント作成レスポンスからID/URLを抽出できませんでした' };
  }

  // pin する。計画フローは「pin 済みであること」が前提のため、
  // pin 失敗時は ok:false とし、作成済みコメントIDをエラーに含めて再試行可能にする。
  const pinResult = ghPinCommentFn(commentId, repo, ghOpts);
  if (pinResult.status !== 0) {
    return { ok: false, error: `コメントは作成されましたがpinに失敗しました（commentId=${commentId}）。再実行で同じコメントを対象に再試行してください: ${pinResult.stderr || '(empty)'}` };
  }

  return { ok: true, url, action: 'created' };
}

module.exports = { publishPlan, PLAN_MARKER, parseCommentsResponse };

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--issue': {}, '--body-file': {}, '--workspace': {} },
      booleans: ['--stdin', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`publish-plan: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }

  const issue = values['--issue'];
  const bodyFile = values['--body-file'];
  const useStdin = values['--stdin'] === true;

  if (!issue) {
    console.error('publish-plan: --issue は必須です。');
    console.error(USAGE);
    process.exit(1);
  }

  if (!bodyFile && !useStdin) {
    console.error('publish-plan: 本文は --body-file <path> または --stdin で渡してください。');
    console.error(USAGE);
    process.exit(1);
  }

  if (bodyFile && useStdin) {
    console.error('publish-plan: --body-file と --stdin は同時に指定できません。');
    console.error(USAGE);
    process.exit(1);
  }

  if (rest.length > 0) {
    console.error('publish-plan: 不明な引数です: ' + rest.join(' '));
    console.error(USAGE);
    process.exit(1);
  }

  // Issue 番号の検証（正の整数）
  if (!/^[1-9]\d*$/.test(issue)) {
    console.error('publish-plan: --issue は正の整数で指定してください。');
    process.exit(1);
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    console.error('publish-plan: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    process.exit(1);
  }

  // ── 本文解決 ────────────────────────────────────────────────────────────

  let body;
  try {
    body = resolveTextInput({
      filePath: bodyFile ? toWinPath(bodyFile) : null,
      stdin: useStdin,
    });
  } catch (e) {
    if (e instanceof StdinTTYError) {
      console.error(`publish-plan: --stdin が指定されましたが${e.message}`);
    } else {
      console.error(`publish-plan: --body-file の読み込みに失敗しました: ${e.message}`);
    }
    process.exit(1);
  }

  if (!body || !body.trim()) {
    console.error('publish-plan: 計画本文が空です。');
    process.exit(1);
  }

  const result = publishPlan({ issue, body, workspace });

  if (!result.ok) {
    console.error(`publish-plan: ${result.error}`);
    process.exit(1);
  }

  console.log(result.url);
  process.exit(0);
}
