'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// collect-housekeeping-exclusions.js のユニットテスト。
//
// 実プロセス確認は行わない（.claude/rules/test-process-spawn-safety.md 準拠）。生存判定は
// 各モジュールの _set* 注入で制御する。注入しない場合は死んだ PID（999999999 等）を使い、
// isProcessAlive が WMI/PowerShell を起動せず false を返す経路だけを踏ませる。

// ── ヘルパー: 注入状態を分離するため対象モジュールをフレッシュに再読込 ──────
const CHE = require.resolve('../scripts/shared/collect-housekeeping-exclusions');
const LIVENESS = require.resolve('../scripts/shared/worker-liveness');
const LEASE = require.resolve('../scripts/shared/worker-lease');

function fresh() {
  for (const p of [CHE, LIVENESS, LEASE]) delete require.cache[p];
  return {
    che: require(CHE),
    liveness: require(LIVENESS),
    lease: require(LEASE),
  };
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-che-'));
}

test('collectHousekeepingExclusions: 新規ワークスペース（情報源なし）は空集合を返す', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const { workerNames, reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.equal(workerNames.size, 0);
    assert.equal(reviewPrs.size, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: workers.json の生存ワーカーを収集し orchestrator は除外する', () => {
  const { che, liveness } = fresh();
  const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({
      orchestrator: { pid: 999999998, startTime: null },
      'issue-1-coder': { pid: 12345, startTime: null },
    }));
    liveness._setIsProcessAlive(() => true);
    const { workerNames } = che.collectHousekeepingExclusions(ws);
    assert.ok(workerNames.has('issue-1-coder'));
    assert.ok(!workerNames.has('orchestrator'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: workers.json の死んだワーカーは収集しない', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({
      'issue-1-coder': { pid: 999999999, startTime: '2025-01-01T00:00:00.000Z' },
    }));
    const { workerNames } = che.collectHousekeepingExclusions(ws);
    assert.equal(workerNames.size, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: live lease のワーカーを収集する（entry.workerName 優先）', () => {
  const { che, lease } = fresh();
  const ws = tmpWorkspace();
  try {
    const leasesDir = path.join(ws, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, 'issue-2-coder.json'), JSON.stringify({
      pid: 12345, startTime: '2025-01-01T00:00:00.000Z', workerName: 'issue-2-coder',
    }));
    lease._setIsProcessAlive(() => true);
    lease._setVerifyProcessIdentity(() => ({ match: true }));
    const { workerNames } = che.collectHousekeepingExclusions(ws);
    assert.ok(workerNames.has('issue-2-coder'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: live lease に workerName が無ければファイル名をキーに使う', () => {
  const { che, lease } = fresh();
  const ws = tmpWorkspace();
  try {
    const leasesDir = path.join(ws, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, 'issue-3-coder.json'), JSON.stringify({
      pid: 12345, startTime: '2025-01-01T00:00:00.000Z',
    }));
    lease._setIsProcessAlive(() => true);
    lease._setVerifyProcessIdentity(() => ({ match: true }));
    const { workerNames } = che.collectHousekeepingExclusions(ws);
    assert.ok(workerNames.has('issue-3-coder'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: 死んだ lease は収集しない', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const leasesDir = path.join(ws, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, 'issue-2-coder.json'), JSON.stringify({
      pid: 999999999, startTime: '2025-01-01T00:00:00.000Z', workerName: 'issue-2-coder',
    }));
    const { workerNames } = che.collectHousekeepingExclusions(ws);
    assert.equal(workerNames.size, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: Review Manager が生存中の PR を収集する', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '12345');
    che._setIsProcessAlive(() => true);
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.ok(reviewPrs.has('42'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: Review Manager が死んでいれば PR を収集しない', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '999999999');
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.equal(reviewPrs.size, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: records/pr の非PRディレクトリは無視する', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const prRoot = path.join(ws, '.gh-maestro', 'records', 'pr');
    fs.mkdirSync(path.join(prRoot, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(prRoot, 'tmp', 'manager.running'), '12345');
    che._setIsProcessAlive(() => true);
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.equal(reviewPrs.size, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
