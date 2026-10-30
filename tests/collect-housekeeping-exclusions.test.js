'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// collect-housekeeping-exclusions.js のユニットテスト。
//
// 実プロセス確認は行わない。生存判定は
// 各モジュールの _set* 注入で制御する。注入しない場合は死んだ PID（999999999 等）を使い、
// process-liveness のテスト用 checker で PID の生死を制御する。

// ── ヘルパー: 注入状態を分離するため対象モジュールをフレッシュに再読込 ──────
const CHE = require.resolve('../scripts/shared/collect-housekeeping-exclusions');
const LIVENESS = require.resolve('../scripts/shared/worker-liveness');
const LEASE = require.resolve('../scripts/shared/worker-lease');
const RRM = require.resolve('../scripts/shared/running-review-managers');
const { createLiveness } = require('../scripts/shared/process-liveness');
const simulated = (time) => createLiveness({ probePid: () => 'alive', readStartTime: () => time });

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
      'issue-1-coder': { pid: 12345, startTime: '2025-01-01T00:00:00.000Z' },
    }));
    che._setLiveness(simulated('2025-01-01T00:00:00.000Z'));
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
    fs.writeFileSync(path.join(ws, '.gh-maestro', 'workers.json'), JSON.stringify({
      'issue-2-coder': { pid: 12345, startTime: '2025-01-01T00:00:00.000Z' },
    }));
    che._setLiveness(simulated('2025-01-01T00:00:00.000Z'));
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
    fs.writeFileSync(path.join(ws, '.gh-maestro', 'workers.json'), JSON.stringify({
      'issue-3-coder': { pid: 12345, startTime: '2025-01-01T00:00:00.000Z' },
    }));
    che._setLiveness(simulated('2025-01-01T00:00:00.000Z'));
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
      resourceKey: 'review-manager-42',
      instanceId: 'review-manager-42-instance',
      startTime: '2026-08-28T00:00:00.000Z',
    }));
    che._setLiveness(simulated('2026-08-28T00:00:00.000Z'));
    const { reviewPrs } = che.collectHousekeepingExclusions(ws);
    assert.ok(reviewPrs.has('42'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('collectHousekeepingExclusions: PIDが生存中でも旧 PID-only は持ち主なしとして中断せず除外対象にしない', () => {
  const { che } = fresh(); const ws = tmpWorkspace();
  try {
    const file = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.running');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '12345');
    che._setLiveness(createLiveness({ probePid: () => 'alive' }));
    const result = che.collectHousekeepingExclusions(ws);
    assert.equal(result.reviewPrs.has('42'), false);
    assert.equal(result.pids.has(12345), false);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: PIDが生存中の旧形式 lease・workers.json の項目があっても中断しない', () => {
  const { che } = fresh(); const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(path.join(ghDir, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'leases', 'issue-1-coder-old.json'),
      JSON.stringify({ pid: process.pid, workerName: 'issue-1-coder-old', legacyEndpointless: true }));
    fs.writeFileSync(path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'issue-2-coder-old': { pid: process.pid, issue: 2, legacyEndpointless: true } }));
    che._setLiveness(createLiveness({ probePid: () => 'alive' }));
    const result = che.collectHousekeepingExclusions(ws);
    assert.equal(result.workerNames.has('issue-1-coder-old'), false);
    assert.equal(result.workerNames.has('issue-2-coder-old'), false);
    assert.ok(!fs.existsSync(path.join(ghDir, 'leases', 'issue-1-coder-old.json')), '孤立した旧形式 lease は回収する');
    assert.ok(result.removedLeases.includes(path.join(ghDir, 'leases', 'issue-1-coder-old.json')));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: 候補登録後に同名の新しい lease が取得された場合は削除しない', () => {
  const { che, lease } = fresh(); const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    const workerName = 'issue-6-coder';
    const store = lease.createNormalWorkerStore(ws);
    fs.mkdirSync(path.dirname(store.filePath(workerName)), { recursive: true });
    fs.writeFileSync(store.filePath(workerName), JSON.stringify({ pid: 12345, workerName }));

    const managerPath = path.join(ghDir, 'records', 'pr', '42', 'review', 'manager.running');
    fs.mkdirSync(path.dirname(managerPath), { recursive: true });
    fs.writeFileSync(managerPath, JSON.stringify({
      pid: 54321,
      resourceKey: 'b'.repeat(64),
      instanceId: 'manager-instance',
    }));

    const replacementResourceKey = 'c'.repeat(64);
    let replaced = false;
    che._setLiveness({
      readRef: (entry, _format, options = {}) => ({ ...entry, source: options.source }),
      observe: (reference) => {
        if (reference.source === managerPath && !replaced) {
          // Simulate a new spawn taking the same per-key lock after the stale candidate
          // was collected but before candidate cleanup starts.
          lease.acquireLeaseLock(store, workerName);
          try {
            store.remove(workerName);
            store.write(workerName, {
              pid: process.pid,
              workerName,
              resourceKey: replacementResourceKey,
              instanceId: 'new-worker-instance',
            });
          } finally {
            lease.releaseLeaseLock(store, workerName);
          }
          replaced = true;
          return 'alive';
        }
        if (reference.resourceKey === replacementResourceKey) return 'alive';
        return 'dead';
      },
    });

    const result = che.collectHousekeepingExclusions(ws);
    assert.equal(replaced, true, '後続の情報源を読む間に新しい lease を取得する');
    assert.deepEqual(result.removedLeases, []);
    assert.equal(store.read(workerName).instanceId, 'new-worker-instance');
    assert.ok(result.workerNames.has(workerName));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: workers.json または worktree にある lease は回収しない', () => {
  const { che } = fresh(); const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    const leasesDir = path.join(ghDir, 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'worktrees', 'issue-3-coder'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({ 'issue-2-coder': { pid: 12345 } }));
    fs.writeFileSync(path.join(leasesDir, 'issue-2-coder.json'), JSON.stringify({ pid: 12345 }));
    fs.writeFileSync(path.join(leasesDir, 'issue-3-coder.json'), JSON.stringify({ pid: 12346 }));

    const result = che.collectHousekeepingExclusions(ws);
    assert.deepEqual(result.removedLeases, []);
    assert.ok(fs.existsSync(path.join(leasesDir, 'issue-2-coder.json')));
    assert.ok(fs.existsSync(path.join(leasesDir, 'issue-3-coder.json')));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: resident lease と起動途中の新形式 lease は保持する', () => {
  const { che } = fresh(); const ws = tmpWorkspace();
  try {
    const leasesDir = path.join(ws, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    const residentPath = path.join(leasesDir, 'resident-role-worker-supervisor.json');
    const residentNewPath = path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json');
    const initializingPath = path.join(leasesDir, 'issue-4-coder.json');
    fs.writeFileSync(residentPath, JSON.stringify({ pid: 12345 }));
    const residentResourceKey = 'b'.repeat(64);
    const residentInstanceId = 'resident-instance';
    fs.writeFileSync(residentNewPath, JSON.stringify({
      pid: 12347, resourceKey: residentResourceKey, instanceId: residentInstanceId,
      workerName: 'msgpoll-orchestrator', phase: 'active',
    }));
    const resourceKey = 'a'.repeat(64);
    const instanceId = 'launcher-instance';
    fs.writeFileSync(initializingPath, JSON.stringify({
      pid: 12346, resourceKey, instanceId, workerName: 'issue-4-coder', phase: 'initializing',
    }));
    const manifests = new Map([
      [resourceKey, { instanceId, pid: 12346 }],
      [residentResourceKey, { instanceId: residentInstanceId, pid: 12347 }],
    ]);
    const checker = createLiveness({
      useRealResources: false,
      probeEndpoint: () => 'alive',
      readManifest: (key) => ({ schemaVersion: 2, resourceKey: key, ...manifests.get(key) }),
    });
    che._setLiveness(checker);

    const result = che.collectHousekeepingExclusions(ws);
    assert.deepEqual(result.removedLeases, []);
    assert.ok(fs.existsSync(residentPath), 'workers.json/worktree に載らない resident lease も維持する');
    assert.ok(fs.existsSync(residentNewPath), '新形式の resident lease も維持する');
    assert.ok(fs.existsSync(initializingPath), 'live launcher の initializing lease を維持する');
    assert.ok(result.workerNames.has('issue-4-coder'));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: cleanupStale=false は孤立した旧形式 lease を削除しない', () => {
  const { che } = fresh(); const ws = tmpWorkspace();
  try {
    const leasePath = path.join(ws, '.gh-maestro', 'leases', 'issue-5-coder.json');
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 12345 }));

    const result = che.collectHousekeepingExclusions(ws, { cleanupStale: false });
    assert.deepEqual(result.removedLeases, []);
    assert.ok(fs.existsSync(leasePath));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: unknown または破損 lease がある場合は候補 lease を何も削除しない', () => {
  for (const laterLease of ['unknown', 'corrupt']) {
    const { che } = fresh(); const ws = tmpWorkspace();
    try {
      const leasesDir = path.join(ws, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      const earlierOldLease = path.join(leasesDir, 'issue-a-old.json');
      fs.writeFileSync(earlierOldLease, JSON.stringify({ pid: 12345 }));
      if (laterLease === 'corrupt') {
        fs.writeFileSync(path.join(leasesDir, 'issue-z-corrupt.json'), '{broken');
      } else {
        fs.writeFileSync(path.join(leasesDir, 'issue-z-unknown.json'), JSON.stringify({
          pid: 12346, resourceKey: 'b'.repeat(64), instanceId: 'instance-z',
        }));
        che._setLiveness(createLiveness({
          useRealResources: false,
          probeEndpoint: () => 'unknown',
        }));
      }

      assert.throws(() => che.collectHousekeepingExclusions(ws));
      assert.ok(fs.existsSync(earlierOldLease), `${laterLease} failure must not partially delete earlier candidates`);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }
});

test('collectHousekeepingExclusions: pid が不正な lease は従来どおり判定不能として中断する', () => {
  const { che } = fresh(); const ws = tmpWorkspace();
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(path.join(ghDir, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'leases', 'issue-1-coder-bad.json'), JSON.stringify({ pid: 'x' }));
    che._setLiveness(createLiveness({ probePid: () => 'alive' }));
    assert.throws(() => che.collectHousekeepingExclusions(ws), /判定できません/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('collectHousekeepingExclusions: records/pr の非PRディレクトリは無視する', () => {
  const { che } = fresh();
  const ws = tmpWorkspace();
  try {
    const prRoot = path.join(ws, '.gh-maestro', 'records', 'pr');
    fs.mkdirSync(path.join(prRoot, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(prRoot, 'tmp', 'manager.running'), '12345');

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
    assert.throws(() => che.collectHousekeepingExclusions(ws), /workers\.json のJSON構文エラー/);
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
    assert.throws(() => che.collectHousekeepingExclusions(ws), /workers\.json はJSONとしては妥当だがオブジェクトでない/);
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
    assert.throws(() => che.collectHousekeepingExclusions(ws), /lease .*破損/);
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
      'worker-1': { pid: '1001', startTime: '2025-01-01T00:00:00.000Z' },
    }));
    che._setLiveness(simulated('2025-01-01T00:00:00.000Z'));

    // 2. lease 由来 (resident role lease を含む)
    fs.writeFileSync(path.join(leasesDir, 'resident-role-worker-supervisor.json'), JSON.stringify({
      pid: 2002, startTime: '2025-01-01T00:00:00.000Z', workerName: 'worker-supervisor',
    }));


    // 3. manager.running 由来（Review Manager は reviewPrs にのみ入り、pids には入れない）
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), JSON.stringify({
      pid: 3003, resourceKey: 'review-manager-42', instanceId: 'review-manager-42-instance', startTime: '2025-01-01T00:00:00.000Z',
    }));

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


