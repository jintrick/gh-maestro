'use strict';
// graphql-client.js — `gh api graphql` 低レベル実行プリミティブの共有化
//
// 背景: gh-fallback.js 内に非公開関数として存在していた _graphqlExec / parseGraphqlJson を
// 切り出し、Discussion 系（discussion-graphql.js）を含む全 GraphQL 呼び出しの共通基盤にする。
// spawnSync の起動形式（`gh api graphql` への args 直渡し・stdin body 渡し `-F 'body=@-'` +
// input・GraphQL エラー判定）はここに集約し、新規モジュールで再書き下ろししない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { spawnSync } = require('./child-process');

// ── 低レベル実行（テストで注入可能） ──────────────────────────────────────────

let _graphqlExec = (args, opts = {}) => {
  return spawnSync('gh', ['api', 'graphql', ...args], { encoding: 'utf8', ...opts });
};

/**
 * `gh api graphql` を実行する。
 *
 * 呼び出し形式は gh-fallback.js のものを踏襲する:
 *   - args: `-f query=...` / `-f var=value`（文字列）/ `-F var=<value>`（変数埋め込み）/
 *     `-F 'body=@-'`（stdin body 渡し）
 *   - opts.input: `-F 'body=@-'` と併用してボディを標準入力へ流す
 *   - opts: spawnSync にそのまま渡る（timeout 等）
 *
 * @param {string[]} args  `gh api graphql` に渡す引数配列
 * @param {object} [opts={}] spawnSync オプション（encoding は固定で utf8）
 * @returns {{ status: number, stdout: string, stderr: string }} spawnSync の戻り値
 */
function graphqlExec(args, opts = {}) {
  return _graphqlExec(args, opts);
}

/**
 * stdout を JSON としてパースする。パース失敗時は null。
 * @param {string} stdout
 * @returns {object|null}
 */
function parseGraphqlJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * GraphQL 応答に errors 配列（GraphQL エラー）が含まれるか判定する。
 * GraphQL エラーは status 非0 相当として扱う（Discussion 系のフェイルクローズ判定）。
 * @param {object|null} parsed
 * @returns {boolean}
 */
function hasGraphqlErrors(parsed) {
  return Boolean(parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0);
}

/**
 * 実行結果が成功か判定する。status 0 かつ GraphQL errors 配列が無い場合のみ true。
 * 応答が JSON としてパースできない場合は成功と断定しない（フェイルクローズ）。
 * @param {{ status?: number, stdout?: string }} result
 * @returns {boolean}
 */
function isGraphqlSuccess(result) {
  if (!result || result.status !== 0) return false;
  const parsed = parseGraphqlJson(result.stdout);
  if (parsed === null) return false;
  return !hasGraphqlErrors(parsed);
}

module.exports = {
  graphqlExec,
  parseGraphqlJson,
  hasGraphqlErrors,
  isGraphqlSuccess,
  _setGraphqlExec: (fn) => { _graphqlExec = fn; },
};
