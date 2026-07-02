'use strict';
// ~/.gh-maestro/agents.json からエージェント設定を1件引く。
//
// spawn-worker.js自身の起動時解決（--agent必須検証・見つからない場合のfail終了）とは
// 用途が異なる。こちらは「わかれば使う、わからなければ呼び出し元のデフォルトに任せる」
// というsoft-failな参照用途（例: send-pane.jsのterminator選択）のため、
// ファイル欠落・パース失敗・該当エージェントなしのいずれも例外を投げず null を返す。

const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');

function agentsJsonPath() {
  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  return resolve(homedir, '.gh-maestro', 'agents.json');
}

function resolveAgentConfig(agentId) {
  if (!agentId) return null;
  const p = agentsJsonPath();
  if (!existsSync(p)) return null;
  try {
    const agents = JSON.parse(readFileSync(p, 'utf8'));
    return agents.find(a => a.id === agentId) ?? null;
  } catch {
    return null;
  }
}

module.exports = { resolveAgentConfig, agentsJsonPath };
