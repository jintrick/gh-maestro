'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// collect-housekeeping-exclusions.js のユニットテスト。
//
// 実プロセス確認は行わない。生存判定は
// 各モジュールの _set* 注入で制御する。注入しない場合は死んだ PID（999999999 等）を使い、
// isProcessAlive が WMI/PowerShell を起動せず false を返す経路だけを踏ませる。

// ── ヘルパー: 注入状態を分離するため対象モジュールをフレッシュに再読込 ──────
const CHE = require.resolve('../scripts/shared/collect-housekeeping-exclusions');
const LIVENESS = require.resolve('../scripts/shared/worker-liveness');
const LEASE = require.resolve('../scripts/shared/worker-lease');
const RRM = require.resolve('../scripts/shared/running-review-managers');

function fresh() {
  for (const p of [CHE, LIVENESS, LEASE, RRM]) delete require.cache[p];
  return {
    che: require(CHE),
    liveness: require(LIVENESS),
    lease: require(LEASE),
    rrm: require(RRM),
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

test('collectHousekeepingExclusions: 同一性確認済みの Review Manager が生存中の PR を収集する', () => {
  const { che, rrm } = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), JSON.stringify({
      pid: 12345,
      startTime: '2026-08-28T00:00:00.000Z',
    }));
    che._setIsProcessAlive(() => true);
    rrm._setVerifyProcessIdentity(() => ({ match: true }));
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.ok(reviewPrs.has('42'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: 死んだ旧形式Review Managerは収集せず回収する', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const file = path.join(reviewDir, 'manager.running');
    fs.writeFileSync(file, '999999999');
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.equal(reviewPrs.size, 0);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: 生存中の旧形式PIDは例外にせず当該PRだけ保護して他PRの処理を続ける', () => {
  const { che, rrm } = fresh();
  const ws = tmpWorkspace();
  try {
    const legacyFile = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.running');
    const newFile = path.join(ws, '.gh-maestro', 'records', 'pr', '43', 'review', 'manager.running');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.writeFileSync(legacyFile, '12345\n', 'utf8');
    fs.writeFileSync(newFile, JSON.stringify({
      pid: 67890,
      startTime: '2026-08-28T00:01:00.000Z',
    }), 'utf8');

    che._setIsProcessAlive((pid) => pid === 12345 || pid === 67890);
    rrm._setVerifyProcessIdentity(() => ({ match: true }));

    assert.doesNotThrow(() => {
      const result = che.collectHousekeepingExclusions(ws);
      assert.ok(result.reviewPrs.has('42'), '旧形式の生存PIDは当該PRだけ保護する');
      assert.ok(result.reviewPrs.has('43'), '後続の新形式PRも処理を続ける');
      assert.ok(!result.pids.has(12345), '旧形式PIDは稼働PID集合へ入れない');
    });
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), '12345\n', '生存中の旧形式は削除しない');
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

// ── PR #268 レビュー指摘: 「ファイル不在」と「読み取り・解析不能」を区別する ──────
//
// 不在は正常な空状態として空集合でよいが、存在するのに読めない・parseできない状態を
// 不在と同じ扱いにすると、除外リストが空集合として正常返却され、fail-closed に到達せず
// 稼働中ワーカーを除外できないまま housekeeping が続行する（PR #268 レビュー指摘）。
// workers.json は readWorkersRaw が不在のみ null・それ以外は throw するため、その例外を
// 本モジュールが伝播する（Issue #275 項目1）。lease の store.read は「不在」と「解析不能」
// の両方で null を返すため、本モジュール側で readdirSync 列挙との突き合わせにより区別する。
// 以下は「存在するのに解析不能」な情報源が例外として伝播することを確認する。

test('collectHousekeepingExclusions: 解析不能な workers.json は例外を投げる（fail-closed）', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), '{broken json');
    // readWorkersRaw が parse を maxAttempts 回リトライして throw する。
    assert.throws(() => che.collectHousekeepingExclusions(ws), /workers\.json を解析できません/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: 型不正（配列）な workers.json は例外を投げる（fail-closed）', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), '[]');
    assert.throws(() => che.collectHousekeepingExclusions(ws), /workers\.json の形式が不正です/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: 破損 lease は例外を投げる（fail-closed）', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const leasesDir = path.join(ws, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    // 列挙された lease ファイルが存在するのに store.read が null（= 解析不能）を返す。
    fs.writeFileSync(path.join(leasesDir, 'issue-2-coder.json'), '{broken lease');
    assert.throws(() => che.collectHousekeepingExclusions(ws), /lease の読み取り・解析に失敗/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: PID 不正な manager.running は例外を投げる（fail-closed）', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), 'not-a-pid');
    assert.throws(() => che.collectHousekeepingExclusions(ws), /manager\.running の PID が不正/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: manager.running が無い PR はスキップする（RM 未起動）', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    // .running が無い = ENOENT → RM 未起動として対象外（fail-closed にならない）。
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.equal(reviewPrs.size, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: 生存プロセスの PID を pids 集合として収集し、manager.running は pids に含めない', () => {
  const { che, liveness, lease } = fresh();
  const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    const leasesDir = path.join(ghDir, 'leases');
    const reviewDir = path.join(ghDir, 'records', 'pr', '42', 'review');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.mkdirSync(reviewDir, { recursive: true });

    // 1. workers.json 由来（文字列形式の PID "1001" も正規化されて収集される）
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({
      'worker-1': { pid: '1001', startTime: null },
    }));
    liveness._setIsProcessAlive((pid) => pid === 1001);

    // 2. lease 由来 (resident role lease を含む)
    fs.writeFileSync(path.join(leasesDir, 'resident-role-worker-supervisor.json'), JSON.stringify({
      pid: 2002, startTime: '2025-01-01T00:00:00.000Z', workerName: 'worker-supervisor',
    }));
    lease._setIsProcessAlive((pid) => pid === 2002);
    lease._setVerifyProcessIdentity(() => ({ match: true }));

    // 3. manager.running 由来（Review Manager は reviewPrs にのみ入り、pids には入れない）
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '3003\n');
    che._setIsProcessAlive((pid) => pid === 3003);

    const { workerNames, reviewPrs, pids } = che.collectHousekeepingExclusions(ws);
    assert.ok(workerNames.has('worker-1'));
    assert.ok(workerNames.has('worker-supervisor'));
    assert.ok(reviewPrs.has('42'));
    assert.ok(pids.has(1001), 'workers.json の生存 PID（文字列から正規化）が含まれること');
    assert.ok(pids.has(2002), 'lease の生存 PID（文字列から正規化）が含まれること');
    assert.ok(!pids.has(3003), 'manager.running の PID は pids 除外集合に含めないこと（PID再利用時のstale保護防止）');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});


