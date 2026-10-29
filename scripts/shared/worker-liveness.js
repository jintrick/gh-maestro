'use strict';
// worker-liveness.js — ワーカーが稼働中かを判定する唯一の述語
//
// WezTermペイン運用では「ペインが存在するか」が稼働中の代理指標だった（isPaneAlive）。
// headless化後はワーカープロセスのPIDで直接判定する。
//
// この判定は配送制御の中核である。worker-supervisor.js は「稼働中のワーカーには一切
// 書き込まず、休止するのを待ってresumeする」という設計なので、生存判定を誤ると
// 動作中のワーカーを二重起動する（誤ってfalse）か、永久に配送しない（誤ってtrue）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { normalizeWorkerEntry } = require('./worker-entry');

// process-lifecycle への依存は呼び出し時点で解決する（Issue #267）。
// process-lifecycle.js は CLI 主経路（require.main === module）から sweepRegistry 経由で
// このモジュールを require する。評価時に require して捕捉すると、module.exports の代入
// 前に循環参照した process-lifecycle の undefined を掴むため、最初の呼び出し時まで
// 解決を遅らせる。テスト注入（_set*）は注入値が優先される。
let _injectedIsProcessAlive = null;
let _injectedVerifyProcessIdentity = null;

function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('../process-lifecycle').isProcessAlive;
  return fn(pid);
}

function _verifyProcessIdentity(pid, identity, opts) {
  const fn = _injectedVerifyProcessIdentity ?? require('../process-lifecycle').verifyProcessIdentity;
  if (opts === undefined) return fn(pid, identity);
  return fn(pid, identity, opts);
}

/**
 * workers.json のエントリが指すワーカープロセスが稼働中か判定する。
 *
 * PIDの生存だけでは不十分である。ワーカーがクラッシュした後にOSが同じPIDを別プロセスへ
 * 再利用すると、無関係なプロセスを「このワーカーが稼働中」と誤判定し続け、配送が
 * 永久に止まる。startTime を記録している場合は必ず同一性まで確認する
 * （.claude/rules/process-lifecycle-scripts.md、PR #90 Review Manager指摘）。
 *
 * 判定不能な場合は false（休止中）に倒す。稼働中と誤るより休止中と誤るほうが影響が
 * 小さい——前者は配送が永久に止まるが、後者はresumeが1回余分に走るだけで済む。
 *
 * @param {object|string|null} entry workers.json のエントリ（正規化前でよい）
 * @param {object} [opts]
 * @param {(pid: number) => (string|null)} [opts.getProcessStartTimeFn]
 *   同一性確認に使う実起動時刻の供給関数。指定時も同一性確認は
 *   `verifyProcessIdentity` を通して行う。
 * @returns {boolean}
 */
function isWorkerAlive(entry, opts = {}) {
  const e = normalizeWorkerEntry(entry);
  if (!e.pid) return false;
  if (!_isProcessAlive(e.pid)) return false;

  // startTime が無いエントリ（移行前・取得失敗時）は同一性を確認できない。
  // PID生存のみを根拠に稼働中と判断する。
  if (!e.startTime) return true;

  if (typeof opts.getProcessStartTimeFn === 'function') {
    const actualStartTime = opts.getProcessStartTimeFn(e.pid);
    return _verifyProcessIdentity(
      e.pid,
      { startTime: e.startTime },
      { actualStartTime }
    ).match === true;
  }

  return _verifyProcessIdentity(e.pid, { startTime: e.startTime }).match === true;
}

module.exports = {
  isWorkerAlive,
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _injectedVerifyProcessIdentity = fn; },
};
