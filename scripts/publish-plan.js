#!/usr/bin/env node
// publish-plan.js — Issue の pin 済み計画コメントを管理する決定的スクリプト
//
// 対象 Issue のコメント一覧を取得し、既に pin されているコメントがあれば
// その本文を更新、なければ新規コメントを投稿して pin する。
//
// Usage:
//   node publish-plan.js --issue <N> --body-file <path> [--workspace <path>]
//   node publish-plan.js --issue <N> --stdin [--workspace <path>] <<'EOF'
//   <計画本文>
//   EOF
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags, hasHelpFlag } = require('./shared/workspace');
const { toWinPath } = require('./win-path');
const { resolveTextInput, StdinTTYError } = require('./shared/text-input');

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
  1. 対象 Issue のコメント一覧から pin 済みコメントを検索
  2. pin 済みコメントがあればその本文を更新する（新規コメントは増やさない）
  3. pin 済みコメントがなければ新規コメントを投稿し pin する

Output (stdout):
  投稿または更新されたコメントの URL を1行出力`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', ...opts });
};

let _ghListComments = (issue, repo, opts = {}) => {
  return spawnSync('gh', ['api', `repos/${repo}/issues/${issue}/comments`],
    { encoding: 'utf8', ...opts });
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

// ── コアロジック ──────────────────────────────────────────────────────────

/**
 * Issue に pin 済み計画コメントがあれば更新、なければ新規投稿＋pin する。
 *
 * @param {{ issue: string, body: string, workspace: string }} params
 * @param {object} [deps]  テスト用の依存注入
 * @param {function} [deps.ghRepoViewFn]
 * @param {function} [deps.ghListCommentsFn]
 * @param {function} [deps.ghCreateCommentFn]
 * @param {function} [deps.ghUpdateCommentFn]
 * @param {function} [deps.ghPinCommentFn]
 * @returns {{ ok: boolean, url?: string, error?: string, action?: 'created'|'updated', warning?: string }}
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

  // ── リポジトリ解決 ──────────────────────────────────────────────────────

  const repoResult = ghRepoViewFn(ghOpts);
  if (repoResult.status !== 0) {
    return { ok: false, error: `リポジトリを解決できません: ${repoResult.stderr || '(empty)'}` };
  }
  const repo = repoResult.stdout.trim();
  if (!repo) {
    return { ok: false, error: 'リポジトリを解決できません（空のレスポンス）' };
  }

  // ── コメント一覧を取得し pin 済みコメントを検索 ─────────────────────────

  const listResult = ghListCommentsFn(issue, repo, ghOpts);
  if (listResult.status !== 0) {
    return { ok: false, error: `コメント一覧の取得に失敗しました: ${listResult.stderr || '(empty)'}` };
  }

  let comments;
  try {
    comments = JSON.parse(listResult.stdout);
  } catch {
    return { ok: false, error: 'コメント一覧のJSONパースに失敗しました' };
  }

  if (!Array.isArray(comments)) {
    return { ok: false, error: 'コメント一覧の形式が不正です' };
  }

  const pinned = comments.find(c => c.pin != null);

  // ── pin 済みコメントがあれば更新 ───────────────────────────────────────

  if (pinned) {
    const updateResult = ghUpdateCommentFn(pinned.id, repo, body, ghOpts);
    if (updateResult.status !== 0) {
      return { ok: false, error: `pin済みコメントの更新に失敗しました: ${updateResult.stderr || '(empty)'}` };
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

  // ── pin 済みコメントなし → 新規投稿して pin ────────────────────────────

  const createResult = ghCreateCommentFn(issue, repo, body, ghOpts);
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

  // pin を試行する（失敗してもコメント作成自体は成功扱い）
  const pinResult = ghPinCommentFn(commentId, repo, ghOpts);
  if (pinResult.status !== 0) {
    return { ok: true, url, action: 'created', warning: `pinに失敗しました: ${pinResult.stderr || '(empty)'}` };
  }

  return { ok: true, url, action: 'created' };
}

module.exports = { publishPlan };

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(
    argv,
    ['--issue', '--body-file', '--workspace'],
    ['--stdin'],
  );

  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
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
  if (result.warning) {
    console.error(`publish-plan: ${result.warning}`);
  }
  process.exit(0);
}
