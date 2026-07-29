'use strict';
// gh-comments.js — GitHub Issue/PR のコメント一覧を全件取得する共通ヘルパー
//
// 背景: プロジェクト内の複数スクリプトが、gh api --paginate --slurp でコメント一覧を
// 取得し平坦化する同一の処理を独立に実装していた（Issue #183）。本モジュールに
// 集約することで重複を排除する。
//
// 各呼び出し元は、このモジュールの戻り値に基づいて独自のエラーハンドリング
// （GraphQLフォールバック・エラー時continue等）を実装する。本モジュールは
// REST API呼び出しと応答の平坦化のみを行い、ビジネスロジックは持ち込まない。

let _spawnSync = require('../child-process').spawnSync;

const GH_TIMEOUT_MS = 30000;

let _listComments = (repo, issue, opts = {}) => {
  const { since, per_page, ...restOpts } = opts;
  const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'];
  if (since) args.push('-f', `since=${since}`);
  if (per_page) args.push('-f', `per_page=${per_page}`);
  return _spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...restOpts });
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
  parseCommentsResponse,
  _setListComments: (fn) => { _listComments = fn; },
  _setSpawnSync: (fn) => { _spawnSync = fn; },
};
