'use strict';
// status-pane-registry.js — .gh-maestro/status-pane.json（監視ペイン情報）の読み書き。
//
// 監視ペインはワークスペース単位の設備であり、セッション単位で1つだけ存在する。
// Issue 単位の管理対象（workers.json / assistants.json）とは意図的に分離する。
// split-pane 作成後に通常の保存と補償終了がともに失敗した場合は、回復用の
// status-pane-recovery.json に記録する。通常記録より新しい回復記録を優先して読むことで、
// 次回の存在保証が作成済みペインを再利用できるようにし、reset-session の既存の
// load/remove 経路でも同じペインを終了できるようにする。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { existsSync, readFileSync, unlinkSync } = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const storageLayout = require('./storage-layout');

const STATUS_PANE_FILE = 'status-pane.json';
const STATUS_PANE_RECOVERY_FILE = 'status-pane-recovery.json';

function statusPanePath(workspace) {
  storageLayout.assertValidWorkspace(workspace);
  storageLayout.assertDisjointRoots();
  return path.join(storageLayout.workspaceRuntimeDir(workspace), STATUS_PANE_FILE);
}

/**
 * status-pane.json の保存に続く補償処理も失敗したときの回復記録パス。
 *
 * @param {string} workspace
 * @returns {string}
 */
function statusPaneRecoveryPath(workspace) {
  storageLayout.assertValidWorkspace(workspace);
  storageLayout.assertDisjointRoots();
  return path.join(storageLayout.workspaceRuntimeDir(workspace), STATUS_PANE_RECOVERY_FILE);
}

function readStatusPaneEntry(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
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

function entryTimestamp(entry) {
  if (!entry || !entry.launchedAt) return null;
  const timestamp = Date.parse(entry.launchedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectNewestEntry(primary, recovery) {
  if (!primary) return recovery;
  if (!recovery) return primary;

  const primaryTimestamp = entryTimestamp(primary);
  const recoveryTimestamp = entryTimestamp(recovery);
  if (primaryTimestamp === null && recoveryTimestamp === null) return recovery;
  if (primaryTimestamp === null) return recovery;
  if (recoveryTimestamp === null) return primary;
  return recoveryTimestamp >= primaryTimestamp ? recovery : primary;
}

function removeFile(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * status-pane.json を安全に読み込む。存在しない・壊れている場合は null を返す。
 *
 * @param {string} workspace
 * @returns {{paneId: string, launchedAt: string}|null}
 */
function loadStatusPane(workspace) {
  let primaryPath;
  let recoveryPath;
  try {
    primaryPath = statusPanePath(workspace);
    recoveryPath = statusPaneRecoveryPath(workspace);
  } catch {
    return null;
  }
  return selectNewestEntry(readStatusPaneEntry(primaryPath), readStatusPaneEntry(recoveryPath));
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
  // 通常記録に成功したら、不要になった回復記録を掃除する。掃除だけの失敗は
  // 次回 loadStatusPane の時刻比較で安全に扱えるため、主記録の成功を覆さない。
  removeStatusPaneRecovery(workspace);
}

/**
 * 通常の status-pane.json 保存と補償終了がともに失敗したペインを記録する。
 *
 * @param {string} workspace
 * @param {{paneId: string|number, launchedAt?: string}} entry
 */
function saveStatusPaneRecovery(workspace, entry) {
  storageLayout.ensureWorkspaceRuntimeDir(workspace);
  const p = statusPaneRecoveryPath(workspace);
  atomicWriteJson(p, {
    paneId: String(entry.paneId),
    launchedAt: entry.launchedAt || new Date().toISOString(),
  });
}

/**
 * 回復用 status-pane-recovery.json を削除する。
 *
 * @param {string} workspace
 * @returns {boolean} ファイルが存在し削除されたか
 */
function removeStatusPaneRecovery(workspace) {
  let p;
  try {
    p = statusPaneRecoveryPath(workspace);
  } catch {
    return false;
  }
  return removeFile(p);
}

/**
 * status-pane.json を削除する。
 *
 * @param {string} workspace
 * @returns {boolean} ファイルが存在し削除されたか
 */
function removeStatusPane(workspace) {
  let paths;
  try {
    paths = [statusPanePath(workspace), statusPaneRecoveryPath(workspace)];
  } catch {
    return false;
  }
  return paths.reduce((removed, p) => removeFile(p) || removed, false);
}

module.exports = {
  statusPanePath,
  statusPaneRecoveryPath,
  loadStatusPane,
  saveStatusPane,
  saveStatusPaneRecovery,
  removeStatusPaneRecovery,
  removeStatusPane,
};
