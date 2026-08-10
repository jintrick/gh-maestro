'use strict';
// inbox-supervisor-control.js — 稼働中の inbox-supervisor の検知・停止。
//
// migrate-records.js が `--scope inbox-supervisor`（または all）で記録を移行する際、
// 既に稼働中の inbox-supervisor が移行対象の記録を書き続けないよう、ツール自身が
// プロセスを検知して停止するために使う（Issue #256）。停止後はマーカー
// （migration-marker.js）で自動起動を抑制し、移行完了後に削除する。inbox-supervisor の
// 再開は既存の自動起動機構（ensure-inbox-supervisor.js）が次の必要時に引き受ける。
//
// 検知は2つの既存機構を併用する:
//   - PID registry: process-lifecycle.js::findRunningInstance
//     （inbox-supervisor.js が起動時に registerProcess で自己登録する）
//   - role lease（排他の正本、Issue #240）: worker-lease.js
//     （acquireResidentLease で取得。プロセスが死ねば isLeaseLive が false になるため、
//       stale lease を誤って kill 対象にすることはない）
//
// 停止は kill-tree.js::killProcessTree（Windows: taskkill /F /T、Unix: SIGTERM グループ）。
// 強制終了で SIGTERM ハンドラのクリーンアップは走らないが、残った role lease / registry
// エントリは次回起動時に stale として回収されるため（findRunningInstance /
// acquireResidentLease の既存ロジック）、安全に再起動できる。
//
// 検知失敗時は fail-open（空として扱い停止しない）。マーカーによる自動起動抑制が
// 「新配置への空状態書き込み」を防ぐ主防衛線であり、停止漏れの最悪系は旧配置への
// 書き残し止まり（移行側の衝突検出も後背にある）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { findRunningInstance } = require('../process-lifecycle');
const { killProcessTree } = require('../kill-tree');
const {
  INBOX_SUPERVISOR_ROLE,
  roleLeaseKey,
  isLeaseLive,
  createResidentLeaseStore,
} = require('./worker-lease');

let _findRunningInstance = findRunningInstance;
let _createResidentLeaseStore = createResidentLeaseStore;
let _isLeaseLive = isLeaseLive;
let _killProcessTree = killProcessTree;

function isValidPid(pid) {
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0;
}

/**
 * 稼働中の inbox-supervisor の PID を検知する（registry と role lease の両方を参照、
 * 重複排除済み）。検知不能・検知失敗時は空配列を返す（fail-open）。
 *
 * @param {string} workspace
 * @returns {number[]}
 */
function runningInboxSupervisorPids(workspace) {
  const pids = new Set();

  // PID registry。registerProcess で script='inbox-supervisor.js' / workerName=null として
  // 登録される（ensure-inbox-supervisor.js の既存の稼働中判定と同条件）。
  try {
    const entry = _findRunningInstance(workspace, { script: 'inbox-supervisor.js', workerName: null });
    if (entry && isValidPid(entry.pid)) pids.add(entry.pid);
  } catch {
    // registry 読取失敗時は role lease 側で拾えれば拾う
  }

  // role lease（排他の正本）。isLeaseLive が startTime 照合まで行うため、PID 再利用や
  // 改ざんされた lease を停止対象にすることはない。
  try {
    const store = _createResidentLeaseStore(workspace);
    const entry = store.read(roleLeaseKey(INBOX_SUPERVISOR_ROLE));
    if (_isLeaseLive(entry) && isValidPid(entry.pid)) pids.add(entry.pid);
  } catch {
    // role lease 読取失敗時も停止対象なしとして続行
  }

  return [...pids];
}

/**
 * 稼働中の inbox-supervisor を全て停止する。best-effort（個別の kill 失敗は無視）。
 *
 * @param {string} workspace
 * @returns {number[]} 停止処理を行った PID の一覧
 */
function stopRunningInboxSupervisors(workspace) {
  const stopped = [];
  for (const pid of runningInboxSupervisorPids(workspace)) {
    try {
      _killProcessTree(pid);
      stopped.push(pid);
    } catch {
      // 停止失敗は無視（残ったプロセスは移行側の held / 衝突検出が防ぐ）
    }
  }
  return stopped;
}

module.exports = {
  runningInboxSupervisorPids,
  stopRunningInboxSupervisors,
  // テスト用注入（test-process-spawn-safety ルール準拠。実プロセスは起動・killしない）
  _setFindRunningInstance: (fn) => { _findRunningInstance = fn; },
  _setCreateResidentLeaseStore: (fn) => { _createResidentLeaseStore = fn; },
  _setIsLeaseLive: (fn) => { _isLeaseLive = fn; },
  _setKillProcessTree: (fn) => { _killProcessTree = fn; },
};
