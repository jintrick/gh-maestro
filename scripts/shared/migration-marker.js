'use strict';
// migration-marker.js — migrate-records.js の実行中を示すマーカーファイルの読み書き。
//
// このマーカーが存在する間、ensure-inbox-supervisor.js は inbox-supervisor の自動起動を
// 抑制する（Issue #256: 移行中にデーモンが自動復活し、移行先の空状態で記録を上書きしかける
// 事故の防止）。マーカーパスは migrate-records.js（作成側）と ensure-inbox-supervisor.js
// （抑制側）の両方が一致していなければならず、ズレると安全機構が黙って無効化されるため、
// パスはこの単一モジュールに集約する。
//
// 設置場所は <workspace>/.gh-maestro/ 配下（install.js 管理対象外）。workspace は
// resolveWorkspace() の解決結果を使う前提で、既存の `.gh-maestro/` ディレクトリ
// （workers.json / assistants.json / inbox-supervisor-autostart.log 等）と同じ扱い。
//
// 自己回復（BLOCKER 修正、PR #257 レビュー指摘）:
//   マーカーは移行プロセス自身の `{ pid, startTime }` を記録する（worker-lease.js の
//   stale lease 回収と同じ方式）。移行プロセスが正常終了すれば finally で削除されるが、
//   SIGKILL / クラッシュ / OS 終了で強制終了された場合は削除が走らないため、isMigration
//   InProgress は所有 PID の生存確認＋同一性確認（PID 再利用対策）を行い、所有プロセスが
//   死んでいれば stale として無効扱い（false）にして inbox-supervisor の自動起動を許可する。
//   これにより強制終了後も自動起動の抑制が永久に残ることはない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');

// process-lifecycle への依存は呼び出し時点で解決する（Issue #267）。process-lifecycle.js は
// CLI 主経路（require.main === module）から sweepRegistry 経由でこのモジュールを require する
// ことがあるため、評価時に require して捕捉すると module.exports 未確定の undefined を掴む。
// 最初の呼び出し時まで解決を遅らせる。テスト注入（_set*）は注入値が優先される。
let _injectedIsProcessAlive = null;
let _injectedGetProcessStartTime = null;
let _injectedVerifyProcessIdentity = null;

function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('../process-lifecycle').isProcessAlive;
  return fn(pid);
}

function _getProcessStartTime(pid) {
  const fn = _injectedGetProcessStartTime ?? require('../process-lifecycle').getProcessStartTime;
  return fn(pid);
}

function _verifyProcessIdentity(pid, identity) {
  const fn = _injectedVerifyProcessIdentity ?? require('../process-lifecycle').verifyProcessIdentity;
  return fn(pid, identity);
}

function migrationInProgressPath(workspace) {
  return path.resolve(workspace, '.gh-maestro', '.migration-in-progress');
}

/**
 * マーカーが「有効な移行実行中」を示すかを判定する。
 *
 * マーカーは移行プロセス自身が `{ pid, startTime }` を書く。所有プロセスの生存確認と
 * （startTime が記録されている場合は）同一性確認の両方を通った場合のみ true。所有
 * プロセスが死んでいる・同一性が確認できないマーカーは stale として無効扱い（false）に
 * し、inbox-supervisor の自動起動を許可する（自己回復）。読み取り・パース失敗時も false
 * （worker-lease.js の stale lease 判定と同じ fail-open）。
 *
 * @param {string} workspace
 * @returns {boolean}
 */
function isMigrationInProgress(workspace) {
  const p = migrationInProgressPath(workspace);
  if (!fs.existsSync(p)) return false;
  let entry;
  try { entry = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return false; }
  if (!entry || typeof entry !== 'object') return false;
  const pid = typeof entry.pid === 'number' && Number.isFinite(entry.pid) && entry.pid > 0
    ? entry.pid : null;
  if (!pid) return false;
  if (!_isProcessAlive(pid)) return false;
  // startTime が記録されている場合は PID 再利用対策の同一性確認も行う。記録されていない
  // 稀なケース（マーカー作成時に起動時刻を取得できなかった）は生存確認のみで抑止を維持
  // する（移行中の自動復活防止という本件の主目的を優先する劣化縮退）。
  if (typeof entry.startTime === 'string' && entry.startTime) {
    if (!_verifyProcessIdentity(pid, { startTime: entry.startTime }).match) return false;
  }
  return true;
}

function markMigrationInProgress(workspace) {
  const p = migrationInProgressPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = {
    pid: process.pid,
    startTime: _getProcessStartTime(process.pid) || null,
  };
  fs.writeFileSync(p, JSON.stringify(entry, null, 2), 'utf8');
}

function clearMigrationInProgress(workspace) {
  try { fs.unlinkSync(migrationInProgressPath(workspace)); } catch {}
}

module.exports = {
  migrationInProgressPath,
  isMigrationInProgress,
  markMigrationInProgress,
  clearMigrationInProgress,
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
  _setGetProcessStartTime: (fn) => { _injectedGetProcessStartTime = fn; },
  _setVerifyProcessIdentity: (fn) => { _injectedVerifyProcessIdentity = fn; },
};
