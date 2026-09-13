'use strict';

// status-pane-legacy.js — status-pane.json の形式判定を共有する。
//
// 旧形式には接続先がないため、ここではJSON記録の形式だけを判定する。
// 記録ファイルの配置とpaneIdを使ったWezTermの照会・終了はこのモジュールの責務ではない。

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validPaneIdentifier(value) {
  return (typeof value === 'string' && value !== '')
    || (typeof value === 'number' && Number.isFinite(value));
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
  classifyStatusPaneRecord,
};
