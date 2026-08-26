'use strict';
// status-pane-registry.js — .gh-maestro/status-pane.json（監視ペイン情報）の読み書き。
//
// 監視ペインはワークスペース単位の設備であり、セッション単位で1つだけ存在する。
// Issue 単位の管理対象（workers.json / assistants.json）とは意図的に分離する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { existsSync, readFileSync, unlinkSync } = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const storageLayout = require('./storage-layout');

function statusPanePath(workspace) {
  storageLayout.assertValidWorkspace(workspace);
  storageLayout.assertDisjointRoots();
  return path.join(storageLayout.workspaceRuntimeDir(workspace), 'status-pane.json');
}

/**
 * status-pane.json を安全に読み込む。存在しない・壊れている場合は null を返す。
 *
 * @param {string} workspace
 * @returns {{paneId: string, launchedAt: string}|null}
 */
function loadStatusPane(workspace) {
  let p;
  try {
    p = statusPanePath(workspace);
  } catch {
    return null;
  }
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.paneId != null && parsed.paneId !== '') {
      return {
        paneId: String(parsed.paneId),
        launchedAt: typeof parsed.launchedAt === 'string' ? parsed.launchedAt : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * status-pane.json に監視ペイン情報をアトミックに保存する。
 *
 * @param {string} workspace
 * @param {{paneId: string|number, launchedAt?: string}} entry
 */
function saveStatusPane(workspace, entry) {
  storageLayout.ensureWorkspaceRuntimeDir(workspace);
  const p = statusPanePath(workspace);
  atomicWriteJson(p, {
    paneId: String(entry.paneId),
    launchedAt: entry.launchedAt || new Date().toISOString(),
  });
}

/**
 * status-pane.json を削除する。
 *
 * @param {string} workspace
 * @returns {boolean} ファイルが存在し削除されたか
 */
function removeStatusPane(workspace) {
  let p;
  try {
    p = statusPanePath(workspace);
  } catch {
    return false;
  }
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  statusPanePath,
  loadStatusPane,
  saveStatusPane,
  removeStatusPane,
};
