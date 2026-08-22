'use strict';
// gh-pr.js — ブランチ名に対応する GitHub PR の検索・一覧取得の共通ヘルパー（Issue #378）。
//
// プロジェクト内の複数スクリプト（worker-exit-hook.js, push-and-declare.js,
// closed-pr-guard.js 等）が、gh pr list --head でブランチに対応する PR を検索する
// 処理を独立に実装していた。本モジュールに集約することで重複を排除する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

let _spawnSync = require('./child-process').spawnSync;

const GH_TIMEOUT_MS = 30000;
const DEFAULT_JSON_FIELDS = 'number,createdAt,url,state,headRefName,baseRefName';

/**
 * 指定リポジトリ・指定ブランチ（head）の PR 一覧を取得する。
 *
 * @param {string} repo "owner/repo" 形式のリポジトリ名
 * @param {string} branch 対象のブランチ名（head）
 * @param {object} [opts] オプション
 * @param {string} [opts.state='open'] PR状態（'open' | 'closed' | 'merged' | 'all'）
 * @param {string|string[]} [opts.json] 取得するJSONフィールド
 * @param {number} [opts.limit] 取得上限件数
 * @param {string} [opts.cwd] 実行ディレクトリ
 * @param {number} [opts.timeout=30000] タイムアウトミリ秒
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
function listPrsByBranch(repo, branch, opts = {}) {
  if (!repo || typeof repo !== 'string') {
    throw new Error(`listPrsByBranch: 有効な repo が必要です（指定値: ${JSON.stringify(repo)}）`);
  }
  if (!branch || typeof branch !== 'string') {
    throw new Error(`listPrsByBranch: 有効な branch が必要です（指定値: ${JSON.stringify(branch)}）`);
  }

  const {
    state = 'open',
    json = DEFAULT_JSON_FIELDS,
    limit,
    cwd,
    timeout = GH_TIMEOUT_MS,
    ...restOpts
  } = opts;

  const jsonFields = Array.isArray(json) ? json.join(',') : String(json);
  const args = [
    'pr', 'list',
    '--repo', repo,
    '--head', branch,
    '--state', state,
    '--json', jsonFields,
  ];

  if (limit !== undefined && limit !== null) {
    args.push('--limit', String(limit));
  }

  const spawnOpts = {
    encoding: 'utf8',
    timeout,
    ...restOpts,
  };
  if (cwd) spawnOpts.cwd = cwd;

  return _spawnSync('gh', args, spawnOpts);
}

let _listPrsByBranch = listPrsByBranch;

/**
 * `gh pr list` の JSON 応答をパースして PR 配列を返す。
 * パース失敗または配列でない場合は null を返す。
 *
 * @param {string} stdout
 * @returns {object[] | null}
 */
function parsePrListResponse(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]');
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  listPrsByBranch: (repo, branch, opts) => _listPrsByBranch(repo, branch, opts),
  parsePrListResponse,
  GH_TIMEOUT_MS,
  DEFAULT_JSON_FIELDS,
  _setListPrsByBranch: (fn) => { _listPrsByBranch = fn; },
  _resetListPrsByBranch: () => { _listPrsByBranch = listPrsByBranch; },
  _setSpawnSync: (fn) => { _spawnSync = fn; },
  _resetSpawnSync: () => { _spawnSync = require('./child-process').spawnSync; },
};
