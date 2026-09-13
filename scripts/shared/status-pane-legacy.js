'use strict';

// status-pane-legacy.js — status-pane.json の配置と形式判定を共有する。
//
// 旧形式には接続先がないため、ここではJSON記録の形式だけを判定する。
// paneIdを使ったWezTermの照会・終了はこのモジュールの責務ではない。

const path = require('path');
const storageLayout = require('./storage-layout');

const STATUS_PANE_RECORD_FILE = 'status-pane.json';

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validPaneIdentifier(value) {
  return (typeof value === 'string' && value !== '')
    || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * status-pane.json のruntime上のパスを返す。
 *
 * @param {string} workspace
 * @param {string} [runtimeRoot]
 * @returns {string}
 */
function statusPaneRecordPath(workspace, runtimeRoot = storageLayout.runtimeRoot()) {
  if (typeof workspace !== 'string' || workspace === '') {
    throw new Error('status-pane の対象workspaceがありません');
  }
  if (typeof runtimeRoot !== 'string' || runtimeRoot === '') {
    throw new Error('status-pane のruntime rootがありません');
  }
  storageLayout.assertValidWorkspace(workspace);
  storageLayout.assertDisjointRoots();
  return path.join(
    path.resolve(runtimeRoot),
    'workspaces',
    storageLayout.workspaceKey(workspace),
    STATUS_PANE_RECORD_FILE,
  );
}

/**
 * JSONとして読み込んだstatus-pane記録の形式を判定する。
 *
 * legacy はpaneIdだけを持つ旧形式、currentは現行loaderが必要とする
 * 接続情報を持つ形式、invalidはcleanupしてはならない不正形式を表す。
 *
 * @param {unknown} value
 * @returns {{status:'legacy'|'current'|'invalid', reason?:string}}
 */
function classifyStatusPaneRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', reason: 'JSONのトップレベルがオブジェクトではありません' };
  }
  if (!validPaneIdentifier(value.paneId)) {
    return { status: 'invalid', reason: 'paneIdが不正です' };
  }

  const hasUnixSocket = own(value, 'unixSocket');
  const hasTargetPaneId = own(value, 'targetPaneId');
  if (!hasUnixSocket && !hasTargetPaneId) {
    return { status: 'legacy' };
  }

  if (typeof value.unixSocket !== 'string' || value.unixSocket === '') {
    return { status: 'invalid', reason: 'unixSocketが不正です' };
  }
  if (!validPaneIdentifier(value.targetPaneId)) {
    return { status: 'invalid', reason: 'targetPaneIdが不正です' };
  }
  return { status: 'current' };
}

module.exports = {
  STATUS_PANE_RECORD_FILE,
  statusPaneRecordPath,
  classifyStatusPaneRecord,
};
