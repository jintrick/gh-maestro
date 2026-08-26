'use strict';
// sync-failure.js — 同期スクリプト（sync-agents-md.js / sync-rules.js）の失敗記録と削除（Issue #393）。
//
// pre-commit フックでの同期スクリプト実行時、コミットを中断させずに失敗した事実を
// <workspace>/.gh-maestro/sync-failures/<kind>.yaml に永続化する。
// 同期が成功した際は既存の記録ファイルを削除する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { resolveWorkspace } = require('./workspace');
const { resolveGitHead } = require('./git-head');

function getHeadSha(cwd, workspace) {
  try {
    return resolveGitHead(cwd);
  } catch {
    if (workspace && workspace !== cwd) {
      try {
        return resolveGitHead(workspace);
      } catch {}
    }
    return 'unknown';
  }
}

/**
 * 同期スクリプトの失敗を <workspace>/.gh-maestro/sync-failures/<kind>.yaml に記録する。
 *
 * @param {string} kind 'sync-agents-md' | 'sync-rules' 等
 * @param {string} errorMsg 失敗理由のエラーメッセージ
 * @param {string} [cwd=process.cwd()] HEAD SHA解決に試行するcwd
 */
function recordSyncFailure(kind, errorMsg, cwd = process.cwd()) {
  const workspace = resolveWorkspace();
  if (!workspace) {
    console.error('  [warn] 同期失敗の記録に失敗しました: ワークスペースを解決できません（未初期化または ~/.gh-maestro/ と衝突しています）');
    return;
  }

  const dir = path.join(workspace, '.gh-maestro', 'sync-failures');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const head = getHeadSha(cwd, workspace);
    const yaml = [
      `timestamp: ${new Date().toISOString()}`,
      `error: ${JSON.stringify(errorMsg)}`,
      `head: ${head}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `${kind}.yaml`), yaml, 'utf8');
  } catch (e) {
    console.error(`  [warn] 同期失敗の記録ファイル書き込みに失敗しました (${kind}.yaml): ${e.message}`);
  }
}

/**
 * 同期成功時に <workspace>/.gh-maestro/sync-failures/<kind>.yaml が存在すれば削除する。
 *
 * @param {string} kind 'sync-agents-md' | 'sync-rules' 等
 */
function clearSyncFailure(kind) {
  const workspace = resolveWorkspace();
  if (!workspace) return;

  const target = path.join(workspace, '.gh-maestro', 'sync-failures', `${kind}.yaml`);
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  } catch (e) {
    console.error(`  [warn] 同期失敗記録の削除に失敗しました (${kind}.yaml): ${e.message}`);
  }
}

module.exports = { recordSyncFailure, clearSyncFailure };
