'use strict';
// ~/.gh-maestro/config.json からエージェント設定を1件引く（soft-fail）。
//
// 内部では shared/resolve-config.js の SSOT ローダーを使用し、
// config.json > agent-defaults.json の解決順序でマージされた結果を返す。
//
// spawn-worker.js自身の起動時解決（--agent必須検証・見つからない場合のfail終了）とは
// 用途が異なる。こちらは「わかれば使う、わからなければ呼び出し元のデフォルトに任せる」
// というsoft-failな参照用途のため、
// ファイル欠落・パース失敗・該当エージェントなしのいずれも例外を投げず null を返す。

const { resolve } = require('path');
const { resolveAgentConfig: resolveFromConfig } = require('./resolve-config');

/**
 * @param {string|null} agentId
 * @param {string} [_homedir] 省略時は HOME/USERPROFILE env
 * @returns {object|null} 解決済みエージェント設定、または null
 */
function resolveAgentConfig(agentId, _homedir) {
  if (!agentId) return null;
  try {
    return resolveFromConfig(agentId, { homedir: _homedir });
  } catch {
    return null;
  }
}

/**
 * @deprecated config.json 移行後は内部用途のみ。下位互換のためエクスポートを維持。
 * @param {string} [_homedir]
 * @returns {string}
 */
function agentsJsonPath(_homedir) {
  const homedir = _homedir || process.env.HOME || process.env.USERPROFILE || '';
  return resolve(homedir, '.gh-maestro', 'config.json');
}

module.exports = { resolveAgentConfig, agentsJsonPath };
