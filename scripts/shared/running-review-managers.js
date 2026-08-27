'use strict';
// running-review-managers.js
// 稼働中の Review Manager を records/pr/<PR>/review/manager.running から走査・列挙する共有ヘルパー。
//
// collect-housekeeping-exclusions.js（fail-closed: 不正値で throw）と
// worker-status.js（tolerant: 不正値を skip）の双方から利用される。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { reviewArtifactPath } = require('./review-manager-paths');

let _injectedIsProcessAlive = null;

function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('../process-lifecycle').isProcessAlive;
  return fn(pid);
}

/**
 * records/pr/<PR>/review/manager.running を走査し、稼働中の Review Manager を列挙する。
 *
 * @param {string} workspace ワークスペースのルートパス
 * @param {object} [opts]
 * @param {'throw'|'skip'} [opts.onError='throw'] 不正値・読み取り不能時の挙動。既定は安全側の 'throw'
 * @param {(pid: number) => boolean} [opts.isProcessAliveFn] プロセス生存判定関数
 * @returns {Array<{ pr: string, pid: number }>} 稼働中の Review Manager 一覧
 */
function listRunningReviewManagers(workspace, opts = {}) {
  const onError = opts.onError || 'throw';
  const isAlive = opts.isProcessAliveFn || _isProcessAlive;

  const ghDir = path.join(workspace, '.gh-maestro');
  const prDir = path.join(ghDir, 'records', 'pr');
  if (!fs.existsSync(prDir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(prDir, { withFileTypes: true });
  } catch (e) {
    if (onError === 'throw') {
      throw new Error(`records/pr の走査に失敗しました: ${prDir}: ${e.message}`);
    }
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const runningPath = reviewArtifactPath(ghDir, entry.name, '.running');
    let raw;
    try {
      raw = fs.readFileSync(runningPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      if (onError === 'throw') {
        throw new Error(`manager.running の読み取りに失敗しました: ${runningPath}: ${e.message}`);
      }
      continue;
    }

    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      if (onError === 'throw') {
        throw new Error(`manager.running の PID が不正です（解析不能）: ${runningPath}`);
      }
      continue;
    }

    if (isAlive(pid)) {
      results.push({ pr: entry.name, pid });
    }
  }

  return results;
}

module.exports = {
  listRunningReviewManagers,
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
};
