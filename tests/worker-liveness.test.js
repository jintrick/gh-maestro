'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const liveness = require('../scripts/shared/worker-liveness');
const { isWorkerAlive } = liveness;
const processLifecycle = require('../scripts/process-lifecycle');

// 実プロセスには一切触れない（.claude/rules/test-process-spawn-safety.md）
afterEach(() => {
  liveness._setIsProcessAlive(processLifecycle.isProcessAlive);
  liveness._setVerifyProcessIdentity(processLifecycle.verifyProcessIdentity);
});

function mock({ alive = true, identityMatch = true } = {}) {
  const calls = { alive: [], verify: [] };
  liveness._setIsProcessAlive((pid) => { calls.alive.push(pid); return alive; });
  liveness._setVerifyProcessIdentity((pid, meta, opts) => {
    calls.verify.push({ pid, meta, opts });
    return identityMatch ? { match: true } : { match: false, reason: 'start time mismatch' };
  });
  return calls;
}

// ── 基本 ─────────────────────────────────────────────────────────────────────

test('isWorkerAlive: pidが生存し起動時刻も一致すれば true', () => {
  mock({ alive: true, identityMatch: true });
  assert.equal(isWorkerAlive({ pid: 4242, startTime: '2026-07-25T00:00:00.000Z' }), true);
});

test('isWorkerAlive: pidが死んでいれば false', () => {
  mock({ alive: false });
  assert.equal(isWorkerAlive({ pid: 4242, startTime: '2026-07-25T00:00:00.000Z' }), false);
});

test('isWorkerAlive: pidが無ければ false（生存確認のしようがない）', () => {
  const calls = mock();
  assert.equal(isWorkerAlive({ pid: null, startTime: 'x' }), false);
  assert.equal(isWorkerAlive({}), false);
  assert.equal(isWorkerAlive(null), false);
  assert.equal(isWorkerAlive(undefined), false);
  assert.equal(calls.alive.length, 0, 'pidが無い時点でプロセス確認を行わない');
});

// ── PID再利用対策（本モジュールの存在理由） ──────────────────────────────────

test('isWorkerAlive: PIDは生きているが起動時刻が一致しなければ false（PID再利用の誤判定を防ぐ）', () => {
  // クラッシュ後にOSが同じPIDを別プロセスへ再利用すると、PID生存のみを根拠にした判定は
  // 無関係なプロセスを「稼働中」と誤認し、配送が永久に止まる（PR #90 Review Manager指摘）
  mock({ alive: true, identityMatch: false });
  assert.equal(isWorkerAlive({ pid: 4242, startTime: '2026-07-25T00:00:00.000Z' }), false);
});

test('isWorkerAlive: startTime を verifyProcessIdentity へ渡して同一性を確認する', () => {
  const calls = mock({ alive: true, identityMatch: true });
  isWorkerAlive({ pid: 4242, startTime: '2026-07-25T00:00:00.000Z' });
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.verify[0].pid, 4242);
  assert.equal(calls.verify[0].meta.startTime, '2026-07-25T00:00:00.000Z');
});

test('isWorkerAlive: startTime が無ければPID生存のみで判定する（移行前エントリ・取得失敗時）', () => {
  const calls = mock({ alive: true, identityMatch: false });
  assert.equal(isWorkerAlive({ pid: 4242 }), true);
  assert.equal(calls.verify.length, 0, '同一性確認は行わない');
});

test('isWorkerAlive: 起動時刻供給関数の値を verifyProcessIdentity に渡す', () => {
  const calls = mock({ alive: true, identityMatch: true });
  const suppliedStartTime = '2026-07-25T00:00:00.000Z';
  const result = isWorkerAlive(
    { pid: 4242, startTime: suppliedStartTime },
    { getProcessStartTimeFn: (pid) => {
      assert.equal(pid, 4242);
      return suppliedStartTime;
    } }
  );

  assert.equal(result, true);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.verify[0].pid, 4242);
  assert.equal(calls.verify[0].meta.startTime, suppliedStartTime);
  assert.equal(calls.verify[0].opts.actualStartTime, suppliedStartTime);
});

// ── 入力の正規化 ─────────────────────────────────────────────────────────────

test('isWorkerAlive: 正規化前のエントリ（文字列pid）も受け付ける', () => {
  mock({ alive: true, identityMatch: true });
  assert.equal(isWorkerAlive({ pid: '4242', startTime: 'x' }), true);
});

test('isWorkerAlive: レガシーなpaneIdだけのエントリは false（pidが無いため）', () => {
  const calls = mock();
  assert.equal(isWorkerAlive({ paneId: '42', agentId: 'agy' }), false);
  assert.equal(calls.alive.length, 0);
});

test('isWorkerAlive: 不正なpid（0・負数）は false', () => {
  const calls = mock();
  assert.equal(isWorkerAlive({ pid: 0 }), false);
  assert.equal(isWorkerAlive({ pid: -1 }), false);
  assert.equal(calls.alive.length, 0, '不正PIDでプロセス確認を行わない');
});
