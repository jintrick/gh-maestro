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

function readError(kind, filePath, error = null) {
  const detail = error && error.message ? `: ${error.message}` : '';
  return new Error(`status-pane レジストリの${kind}（${filePath}）${detail}`);
}

function readStatusPaneEntry(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw readError('読み取り失敗', filePath, error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw readError('JSON構文エラー', filePath, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw readError('JSONとしては妥当だがオブジェクトでない', filePath);
  }
  if (parsed.paneId == null || parsed.paneId === '') {
    throw readError('型不正（paneId がありません）', filePath);
  }
  if (typeof parsed.unixSocket !== 'string' || parsed.unixSocket === '') {
    throw readError('型不正（unixSocket がありません）', filePath);
  }
  if (parsed.targetPaneId == null || parsed.targetPaneId === '') {
    throw readError('型不正（targetPaneId がありません）', filePath);
  }

  const entry = {
    paneId: String(parsed.paneId),
    unixSocket: parsed.unixSocket,
    targetPaneId: String(parsed.targetPaneId),
    launchedAt: typeof parsed.launchedAt === 'string' ? parsed.launchedAt : '',
  };
  if (/^[1-9]\d*$/.test(String(parsed.issue))) entry.issue = String(parsed.issue);
  return entry;
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
 * status-pane.json と status-pane-recovery.json を安全に読み込む。
 * 両方が無い場合は null を返す。片方だけが壊れている場合は警告して有効な方を返し、
 * 有効な記録を得られない場合（片方の破損と相方の不在を含む）は throw する。
 *
 * @param {string} workspace
 * @param {(message: string) => void} [warn]
 * @returns {{paneId: string, unixSocket: string, targetPaneId: string, launchedAt: string}|null}
 * @throws {Error} 有効な記録を得られない、またはパス解決失敗
 */
function loadStatusPane(workspace, warn = (message) => process.stderr.write(`Warning: ${message}\n`)) {
  let primaryPath;
  let recoveryPath;
  try {
    primaryPath = statusPanePath(workspace);
    recoveryPath = statusPaneRecoveryPath(workspace);
  } catch (error) {
    throw readError('パス解決失敗', workspace, error);
  }

  const errors = [];
  const readEntry = (filePath) => {
    try {
      return readStatusPaneEntry(filePath);
    } catch (error) {
      errors.push(error);
      warn(error.message);
      return null;
    }
  };

  const selected = selectNewestEntry(readEntry(primaryPath), readEntry(recoveryPath));
  if (selected) return selected;
  if (errors.length > 0) {
    throw new Error(
      `status-pane レジストリから有効な記録を取得できません: ${errors.map((error) => error.message).join(' / ')}`,
    );
  }
  return null;
}

function buildStatusPaneRecord(entry) {
  if (!entry || entry.paneId == null || entry.paneId === '') {
    throw new Error('status-pane レジストリへ保存する paneId がありません');
  }
  if (typeof entry.unixSocket !== 'string' || entry.unixSocket === '') {
    throw new Error('status-pane レジストリへ保存する unixSocket がありません');
  }
  if (entry.targetPaneId == null || entry.targetPaneId === '') {
    throw new Error('status-pane レジストリへ保存する targetPaneId がありません');
  }

  const record = {
    paneId: String(entry.paneId),
    unixSocket: entry.unixSocket,
    targetPaneId: String(entry.targetPaneId),
    launchedAt: entry.launchedAt || new Date().toISOString(),
  };
  if (/^[1-9]\d*$/.test(String(entry.issue))) record.issue = String(entry.issue);
  return record;
}

/**
 * status-pane.json に監視ペイン情報をアトミックに保存する。
 *
 * @param {string} workspace
 * @param {{paneId: string|number, unixSocket: string, targetPaneId: string|number, launchedAt?: string}} entry
 */
function saveStatusPane(workspace, entry) {
  storageLayout.ensureWorkspaceRuntimeDir(workspace, {
    register: !storageLayout.isNodeTestContext(),
  });
  const p = statusPanePath(workspace);
  const record = buildStatusPaneRecord(entry);
  atomicWriteJson(p, record);
  // 通常記録に成功したら、不要になった回復記録を掃除する。掃除だけの失敗は
  // 次回 loadStatusPane の時刻比較で安全に扱えるため、主記録の成功を覆さない。
  removeStatusPaneRecovery(workspace);
}

/**
 * 通常の status-pane.json 保存と補償終了がともに失敗したペインを記録する。
 *
 * @param {string} workspace
 * @param {{paneId: string|number, unixSocket: string, targetPaneId: string|number, launchedAt?: string}} entry
 */
function saveStatusPaneRecovery(workspace, entry) {
  storageLayout.ensureWorkspaceRuntimeDir(workspace, {
    register: !storageLayout.isNodeTestContext(),
  });
  const p = statusPaneRecoveryPath(workspace);
  const record = buildStatusPaneRecord(entry);
  atomicWriteJson(p, record);
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
