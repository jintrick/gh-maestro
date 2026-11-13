'use strict';
// gh-comments.js — GitHub Issue/PR のコメント取得・投稿・更新を行う共通ヘルパー
//
// 背景:
// - プロジェクト内の複数スクリプトが、gh api --paginate --slurp でコメント一覧を
//   取得し平坦化する同一の処理を独立に実装していた（Issue #183）。
// - また、コメント本文を `-f body=${body}` としてコマンドライン引数で渡すと、Windows の
//   argv 長上限（約32KB）で ENAMETOOLONG になる（Issue #774）。本文は `-F body=@-` と
//   stdin（opts.input）経由で渡すことで上限を回避する。
//
// 各呼び出し元は、このモジュールの戻り値に基づいて独自のエラーハンドリング
// （GraphQLフォールバック・エラー時continue等）を実装する。本モジュールは
// REST API呼び出しと応答の平坦化のみを行い、ビジネスロジックは持ち込まない。

let _spawnSync = require('./child-process').spawnSync;

const GH_TIMEOUT_MS = 30000;

let _listComments = (repo, issue, opts = {}) => {
  const { since, per_page, ...restOpts } = opts;
  const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'];
  if (since) args.push('-f', `since=${since}`);
  if (per_page) args.push('-f', `per_page=${per_page}`);
  return _spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...restOpts });
};

/**
 * 本文を標準入力経由（`-F body=@-`）で送信する共通のコメント書き込みプリミティブ。
 * コマンドライン引数の長さ上限（Windows 約32KB）を避けるため、本文は必ず `input` に載せる。
 */
function postCommentApi(args, body, opts = {}) {
  const { spawnSyncFn, ...restOpts } = opts;
  const spawnFn = spawnSyncFn || _spawnSync;
  return spawnFn('gh', args, {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    ...restOpts,
    // undefined だと spawnSync が stdin を継承し、@- 読み込みがハングしうるため必ず文字列化する。
    input: String(body ?? ''),
  });
}

let _createComment = (repo, issue, body, opts = {}) => {
  return postCommentApi(['api', `repos/${repo}/issues/${issue}/comments`, '-X', 'POST', '-F', 'body=@-'], body, opts);
};

let _updateComment = (repo, commentId, body, opts = {}) => {
  return postCommentApi(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '-F', 'body=@-'], body, opts);
};

/**
 * `gh api --paginate --slurp` の出力（ページ配列の配列、例: `[[c1,c2],[c3]]`）を
 * 1段階フラット化してコメント配列を返す。要素が配列でないコメントオブジェクトの
 * フラットな配列（`--paginate` を使わない旧来の応答形状・テストのモック）が
 * 渡された場合はそのまま返す（後方互換）。全体が配列でない場合は null。
 *
 * @param {string} stdout
 * @returns {object[] | null}
 */
function parseCommentsResponse(stdout) {
  const parsed = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed)) return null;
  if (parsed.length > 0 && parsed.every((page) => Array.isArray(page))) {
    return parsed.flat();
  }
  return parsed;
}

module.exports = {
  listComments: (repo, issue, opts) => _listComments(repo, issue, opts || {}),
  createComment: (repo, issue, body, opts) => _createComment(repo, issue, body, opts || {}),
  updateComment: (repo, commentId, body, opts) => _updateComment(repo, commentId, body, opts || {}),
  parseCommentsResponse,
  _setListComments: (fn) => { _listComments = fn; },
  _setSpawnSync: (fn) => { _spawnSync = fn; },
};
