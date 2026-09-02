'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const lease = require('../scripts/shared/worker-lease');
const processLifecycle = require('../scripts/process-lifecycle');

// テスト実行環境から GH_MAESTRO_WORKER / GH_MAESTRO_WORKSPACE を退避し、
// 単体テストが親ワーカー文テキストの影響を受けないようにする。
const SAVED_MAESTRO_ENV = {};
for (const k of ['GH_MAESTRO_WORKER', 'GH_MAESTRO_WORKSPACE']) {
  if (process.env[k] !== undefined) SAVED_MAESTRO_ENV[k] = process.env[k];
  delete process.env[k];
}
process.on('exit', () => {
  for (const [k, v] of Object.entries(SAVED_MAESTRO_ENV)) process.env[k] = v;
});

// 実プロセスには一切触れない
afterEach(() => {
  lease._setIsProcessAlive(processLifecycle.isProcessAlive);
  lease._setVerifyProcessIdentity(processLifecycle.verifyProcessIdentity);
  lease._setGetProcessStartTime(processLifecycle.getProcessStartTime);
  lease._setKillProcessTree(() => { throw new Error('_killProcessTree は未注入のまま呼ばれた'); });
  lease._setSleep(() => {});
});

// ── テスト用ヘルパー ───────────────────────────────────────────────────────────

function tempStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  const store = lease.createNormalWorkerStore(tmp);
  store._tmpDir = tmp;
  return store;
}

function cleanupStore(store) {
  if (store._tmpDir) {
    fs.rmSync(store._tmpDir, { recursive: true, force: true });
  }
}

function mockLiveness({ alive = true, identityMatch = true } = {}) {
  const calls = { alive: [], verify: [] };
  lease._setIsProcessAlive((pid) => { calls.alive.push(pid); return alive; });
  lease._setVerifyProcessIdentity((pid, meta) => {
    calls.verify.push({ pid, meta });
    return identityMatch ? { match: true } : { match: false, reason: 'start time mismatch' };
  });
  lease._setGetProcessStartTime((pid) => `2026-07-29T00:00:00.${String(pid).padStart(3, '0')}Z`);
  return calls;
}

// ── createNormalWorkerStore ────────────────────────────────────────────────────

test('createNormalWorkerStore: read/write/remove/update の基本操作', () => {
  const store = tempStore();
  try {
    // 初期状態では read は null
    assert.equal(store.read('test-key'), null);

    // write でエントリを作成
    store.write('test-key', { pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: '2026-07-29T00:00:00.000Z' });
    const entry = store.read('test-key');
    assert.equal(entry.pid, 4242);
    assert.equal(entry.workerName, 'issue-1-coder-test');

    // write の重複は EEXIST
    assert.throws(
      () => store.write('test-key', { pid: 9999, workerName: 'other' }),
      { code: 'EEXIST' }
    );

    // update で原子的に上書き（temp+rename）
    store.update('test-key', { pid: 9999, startTime: '2026-07-29T00:00:00.000Z', workerName: 'updated', createdAt: '2026-07-29T00:00:00.000Z' });
    assert.equal(store.read('test-key').pid, 9999);
    assert.equal(store.read('test-key').workerName, 'updated');

    // remove で削除
    store.remove('test-key');
    assert.equal(store.read('test-key'), null);

    // 存在しないキーの remove はエラーにならない
    assert.doesNotThrow(() => store.remove('nonexistent'));
  } finally {
    cleanupStore(store);
  }
});

test('createNormalWorkerStore: 破損JSONは read で null を返す', () => {
  const store = tempStore();
  try {
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'broken.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '{not valid json', 'utf8');
    assert.equal(store.read('broken'), null);
  } finally {
    cleanupStore(store);
  }
});

test('createNormalWorkerStore: JSON.parse がオブジェクト以外を返したら null', () => {
  const store = tempStore();
  try {
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'not-obj.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '"just a string"', 'utf8');
    assert.equal(store.read('not-obj'), null);

    fs.writeFileSync(fp, 'null', 'utf8');
    assert.equal(store.read('not-obj'), null);

    fs.writeFileSync(fp, '[1,2,3]', 'utf8');
    assert.equal(store.read('not-obj'), null);
  } finally {
    cleanupStore(store);
  }
});

test('createNormalWorkerStore: update は staging+rename で原子的に更新する', () => {
  const store = tempStore();
  try {
    store.write('test-key', { pid: 1, workerName: 'original', createdAt: 'x' });
    // 同時readをエミュレート: update中にreadしても完全なデータが読める
    store.update('test-key', { pid: 2, workerName: 'updated', createdAt: 'y' });
    const entry = store.read('test-key');
    assert.equal(entry.pid, 2);
    assert.equal(entry.workerName, 'updated');
    // atomic-write.js の staging 残骸が残っていないことを確認（旧実装の .tmp. プレフィックスは
    // 使われない）
    const stagingFiles = fs.readdirSync(path.join(store._tmpDir, '.gh-maestro', 'leases'))
      .filter(f => f.includes('.staging-'));
    assert.equal(stagingFiles.length, 0, 'stagingファイルが残留していないこと');
  } finally {
    cleanupStore(store);
  }
});

// ── isLeaseLive ───────────────────────────────────────────────────────────────

test('isLeaseLive: 生存PIDと一致するstartTimeで true', () => {
  mockLiveness({ alive: true, identityMatch: true });
  assert.equal(lease.isLeaseLive({
    pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'w', createdAt: 'x',
  }), true);
});

test('isLeaseLive: PIDが死んでいれば false', () => {
  mockLiveness({ alive: false });
  assert.equal(lease.isLeaseLive({
    pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'w', createdAt: 'x',
  }), false);
});

test('isLeaseLive: PIDは生きているがstartTimeが一致しなければ false（PID再利用防止）', () => {
  mockLiveness({ alive: true, identityMatch: false });
  assert.equal(lease.isLeaseLive({
    pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'w', createdAt: 'x',
  }), false);
});

test('isLeaseLive: startTimeが無ければ live とみなさない（任意PID誤kill防止）', () => {
  const calls = mockLiveness({ alive: true, identityMatch: true });
  assert.equal(lease.isLeaseLive({ pid: 4242, startTime: '', workerName: 'w', createdAt: 'x' }), false);
  assert.equal(lease.isLeaseLive({ pid: 4242, workerName: 'w', createdAt: 'x' }), false);
  // startTime が欠落したリースは verifyProcessIdentity も通さない
  assert.equal(calls.verify.length, 0, 'startTime が欠落なら同一性確認は不要（PIDに触れない）');
});

test('isLeaseLive: null/非オブジェクト/pid無しは false', () => {
  mockLiveness();
  assert.equal(lease.isLeaseLive(null), false);
  assert.equal(lease.isLeaseLive(undefined), false);
  assert.equal(lease.isLeaseLive({}), false);
  assert.equal(lease.isLeaseLive({ pid: null }), false);
  assert.equal(lease.isLeaseLive({ pid: 0 }), false);
  assert.equal(lease.isLeaseLive({ pid: -1 }), false);
  assert.equal(lease.isLeaseLive({ pid: 'string' }), false);
});

// ── acquireLeaseLock / releaseLeaseLock ────────────────────────────────────────

test('acquireLeaseLock: 既存ロックがなければ取得に成功する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true });
    const result = lease.acquireLeaseLock(store, 'test-key');
    assert.equal(result, true);
    // ロック後にrelease
    lease.releaseLeaseLock(store, 'test-key');
    // ロックファイルが消えている
    assert.equal(fs.existsSync(store.lockPath('test-key')), false);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLeaseLock: liveな保持者がいればエラーを投げる', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true, identityMatch: true });
    // 事前に別プロセスのロック（JSON: pid+startTime）を作成
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), JSON.stringify({ pid: 99999, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

    assert.throws(
      () => lease.acquireLeaseLock(store, 'test-key'),
      /進行中/
    );
  } finally {
    cleanupStore(store);
  }
});

test('acquireLeaseLock: staleロック（保持者死亡）は奪取して成功する', () => {
  const store = tempStore();
  try {
    // 保持者は死亡
    mockLiveness({ alive: false });
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), JSON.stringify({ pid: 99999, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

    const result = lease.acquireLeaseLock(store, 'test-key');
    assert.equal(result, true);
    lease.releaseLeaseLock(store, 'test-key');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLeaseLock: PID再利用（生存だがstartTime不一致）はstaleとみなし奪取する', () => {
  const store = tempStore();
  try {
    // 生存しているが、ロックに記録されたstartTimeとは別プロセス（PID再利用）のケース
    mockLiveness({ alive: true, identityMatch: false });
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), JSON.stringify({ pid: 99999, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

    const result = lease.acquireLeaseLock(store, 'test-key');
    assert.equal(result, true);
    lease.releaseLeaseLock(store, 'test-key');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLeaseLock: 破損ロック（JSONでない）はstaleとみなし奪取する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: false });
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), 'not-json', 'utf8');

    const result = lease.acquireLeaseLock(store, 'test-key');
    assert.equal(result, true);
  } finally {
    cleanupStore(store);
  }
});

test('releaseLeaseLock: 自プロセスのロックのみ解放する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true });
    lease.acquireLeaseLock(store, 'test-key');
    assert.equal(fs.existsSync(store.lockPath('test-key')), true);
    lease.releaseLeaseLock(store, 'test-key');
    assert.equal(fs.existsSync(store.lockPath('test-key')), false);
  } finally {
    cleanupStore(store);
  }
});

test('releaseLeaseLock: 他プロセスのロックは解放しない', () => {
  const store = tempStore();
  try {
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), JSON.stringify({ pid: 99999, startTime: 'x' }), 'utf8');

    lease.releaseLeaseLock(store, 'test-key');
    // 他プロセスのロックはそのまま
    assert.equal(fs.existsSync(store.lockPath('test-key')), true);
    // 後片付け
    fs.unlinkSync(store.lockPath('test-key'));
  } finally {
    cleanupStore(store);
  }
});

// ── acquireLease ──────────────────────────────────────────────────────────────

test('acquireLease: 既存リースがなければ新規作成に成功する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true, identityMatch: true });
    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'issue-1-coder-test',
    });
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, false);

    const entry = store.read('issue-1-coder-test');
    assert.equal(entry.pid, 4242);
    assert.equal(entry.workerName, 'issue-1-coder-test');
    assert.ok(entry.createdAt);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: live lease があればエラーを投げる（重複起動拒否）', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true, identityMatch: true });
    // 事前に live なリースを作成
    store.write('issue-1-coder-test', {
      pid: 8888, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    });

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        pid: 4242, startTime: null, workerName: 'issue-1-coder-test',
      }),
      /既に稼働中/
    );
    // 元のリースはそのまま残っている
    assert.equal(store.read('issue-1-coder-test').pid, 8888);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: stale lease（PID死亡）は回収して新規作成する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: false }); // PIDが死んでいる
    store.write('issue-1-coder-test', {
      pid: 8888, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    });

    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'issue-1-coder-test',
    });
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);

    // 新しいリースに置き換わっている
    const entry = store.read('issue-1-coder-test');
    assert.equal(entry.pid, 4242);
    assert.equal(entry.startTime, '2026-07-29T00:00:00.000Z');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: stale lease（startTime不一致=PID再利用）は回収して新規作成する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true, identityMatch: false }); // PIDは生きているが同一性不一致
    store.write('issue-1-coder-test', {
      pid: 8888, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    });

    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'issue-1-coder-test',
    });
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);
    assert.equal(store.read('issue-1-coder-test').pid, 4242);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: 破損JSONの既存リースは stale 扱いで回収', () => {
  const store = tempStore();
  try {
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'issue-1-coder-test.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'corrupt', 'utf8');

    mockLiveness({ alive: true, identityMatch: true });
    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      pid: 4242, startTime: null, workerName: 'issue-1-coder-test',
    });
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);
    assert.equal(store.read('issue-1-coder-test').pid, 4242);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: per-keyロックにより並行起動を拒否する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true, identityMatch: true });
    // 事前に別プロセスのロックを作成（他launcherが起動処理中）
    fs.mkdirSync(path.dirname(store.lockPath('issue-1-coder-test')), { recursive: true });
    fs.writeFileSync(store.lockPath('issue-1-coder-test'), JSON.stringify({ pid: 99999, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        pid: 4242, startTime: null, workerName: 'issue-1-coder-test',
      }),
      /進行中/
    );
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: ロック取得後にlive leaseが現れた場合は拒否（再チェック）', () => {
  const store = tempStore();
  try {
    // 高速チェック: leaseなし → ロック取得へ進む
    // ロック取得後の再チェック: leaseが出現
    mockLiveness({ alive: true, identityMatch: true });

    // store.read を差し替え: 1回目はnull（高速チェック通過）、2回目はlive lease（再チェックで検出）
    let readCount = 0;
    const origRead = store.read.bind(store);
    store.read = function (key) {
      readCount++;
      if (readCount === 1) return null; // 高速チェック
      if (readCount >= 2) {
        // ロック下の再チェック: live leaseが出現
        return { pid: 7777, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: 'x' };
      }
      return origRead(key);
    };

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        pid: 4242, startTime: null, workerName: 'issue-1-coder-test',
      }),
      /既に稼働中/
    );
    // ロックは解放されている
    assert.equal(fs.existsSync(store.lockPath('issue-1-coder-test')), false);
  } finally {
    cleanupStore(store);
  }
});

// ── releaseLease ──────────────────────────────────────────────────────────────

test('releaseLease: 自プロセス所有のリースを解放する', () => {
  const store = tempStore();
  try {
    store.write('test-key', {
      pid: 4242, startTime: 'x', workerName: 'w', createdAt: 'x',
    });

    lease.releaseLease(store, 'test-key', { pid: 4242 });
    assert.equal(store.read('test-key'), null);
  } finally {
    cleanupStore(store);
  }
});

test('releaseLease: PIDが異なる場合は解放しない（他プロセスのリース保護）', () => {
  const store = tempStore();
  try {
    store.write('test-key', {
      pid: 8888, startTime: 'x', workerName: 'w', createdAt: 'x',
    });

    lease.releaseLease(store, 'test-key', { pid: 4242 });
    assert.equal(store.read('test-key').pid, 8888);
  } finally {
    cleanupStore(store);
  }
});

test('releaseLease: 存在しないキーでもエラーにならない', () => {
  const store = tempStore();
  try {
    assert.doesNotThrow(() => lease.releaseLease(store, 'nonexistent', { pid: 4242 }));
  } finally {
    cleanupStore(store);
  }
});

// ── activateLease ─────────────────────────────────────────────────────────────

test('activateLease: リースのPIDとstartTimeを実際のワーカー情報で更新する', () => {
  const store = tempStore();
  try {
    store.write('test-key', {
      pid: 100, startTime: 'old', workerName: 'w', createdAt: '2026-07-29T00:00:00.000Z',
    });

    lease.activateLease(store, 'test-key', {
      pid: 4242, startTime: '2026-07-29T00:00:01.000Z',
    });

    const entry = store.read('test-key');
    assert.equal(entry.pid, 4242);
    assert.equal(entry.startTime, '2026-07-29T00:00:01.000Z');
    assert.equal(entry.workerName, 'w');
    assert.equal(entry.createdAt, '2026-07-29T00:00:00.000Z');
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: リースが存在しなければ何もしない（エラーにしない）', () => {
  const store = tempStore();
  try {
    assert.doesNotThrow(() => lease.activateLease(store, 'nonexistent', {
      pid: 4242, startTime: null,
    }));
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: startTime省略時はgetProcessStartTimeで取得する', () => {
  const store = tempStore();
  try {
    mockLiveness();
    store.write('test-key', {
      pid: 100, startTime: 'old', workerName: 'w', createdAt: 'x',
    });

    lease.activateLease(store, 'test-key', { pid: 4242, startTime: null });

    const entry = store.read('test-key');
    assert.equal(entry.pid, 4242);
    // pid=4242 は4桁なので padStart(3, '0') を通過し、'.4242Z' になる
    assert.equal(entry.startTime, '2026-07-29T00:00:00.4242Z');
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: temp+rename更新により並行readが不完全JSONを読まない', () => {
  const store = tempStore();
  try {
    store.write('test-key', {
      pid: 100, startTime: 'old', workerName: 'w', createdAt: 'x',
    });

    // update中にreadしても完全な値が返る（atomic renameの保証）
    lease.activateLease(store, 'test-key', { pid: 99999, startTime: '2026-07-29T02:00:00.000Z' });
    const entry = store.read('test-key');
    assert.equal(entry.pid, 99999);
    assert.ok(entry.startTime);
  } finally {
    cleanupStore(store);
  }
});

// ── 統合シナリオ ──────────────────────────────────────────────────────────────

test('シナリオ: 通常の起動フロー（予約→アクティベート→解放）', () => {
  const store = tempStore();
  try {
    mockLiveness();

    // 1. 起動前にリース獲得（launcher PIDで予約）
    const r1 = lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      pid: process.pid, startTime: null, workerName: 'issue-5-coder-fix-auth',
    });
    assert.equal(r1.acquired, true);
    assert.equal(r1.staleReclaimed, false);

    // 2. ワーカー起動後にアクティベート
    lease.activateLease(store, 'issue-5-coder-fix-auth', {
      pid: 99999, startTime: '2026-07-29T01:00:00.000Z',
    });
    assert.equal(store.read('issue-5-coder-fix-auth').pid, 99999);

    // 3. ワーカー終了時に解放
    lease.releaseLease(store, 'issue-5-coder-fix-auth', { pid: 99999 });
    assert.equal(store.read('issue-5-coder-fix-auth'), null);
  } finally {
    cleanupStore(store);
  }
});

test('シナリオ: stale回収からの再起動', () => {
  const store = tempStore();
  try {
    // 古いワーカーエントリを直接書き込む（プロセスは既に死んでいる）
    store.write('issue-5-coder-fix-auth', {
      pid: 11111, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-5-coder-fix-auth', createdAt: '2026-07-28T00:00:00.000Z',
    });

    // PIDは死んでいる（stale判定）→ 高速チェック通過 → ロック取得 → 回収
    mockLiveness({ alive: false });
    const r2 = lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      pid: process.pid, startTime: null, workerName: 'issue-5-coder-fix-auth',
    });
    assert.equal(r2.staleReclaimed, true);
    assert.equal(store.read('issue-5-coder-fix-auth').pid, process.pid);
  } finally {
    cleanupStore(store);
  }
});

test('シナリオ: 起動失敗時のロールバック（リース解放）', () => {
  const store = tempStore();
  try {
    mockLiveness();

    // リース獲得
    lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      pid: process.pid, startTime: null, workerName: 'issue-5-coder-fix-auth',
    });
    assert.notEqual(store.read('issue-5-coder-fix-auth'), null);

    // 起動失敗 → リース解放
    lease.releaseLease(store, 'issue-5-coder-fix-auth', { pid: process.pid });
    assert.equal(store.read('issue-5-coder-fix-auth'), null);

    // 後続の起動がブロックされない
    const r = lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      pid: 99999, startTime: null, workerName: 'issue-5-coder-fix-auth',
    });
    assert.equal(r.acquired, true);
  } finally {
    cleanupStore(store);
  }
});

test('シナリオ: staleロック保持者がいる場合、死亡していれば奪取して進行する', () => {
  const store = tempStore();
  try {
    // 死んだlauncherのロックが残っている
    mockLiveness({ alive: false }); // isProcessAlive → false
    fs.mkdirSync(path.dirname(store.lockPath('issue-5-coder-fix-auth')), { recursive: true });
    fs.writeFileSync(store.lockPath('issue-5-coder-fix-auth'), '12345', 'utf8');

    // 既存leaseはなし、ロックはstale → 奪取成功
    lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      pid: process.pid, startTime: null, workerName: 'issue-5-coder-fix-auth',
    });
    assert.equal(store.read('issue-5-coder-fix-auth').pid, process.pid);
    // ロックは解放済み
    assert.equal(fs.existsSync(store.lockPath('issue-5-coder-fix-auth')), false);
  } finally {
    cleanupStore(store);
  }
});

// ── 常駐プロセス用 role lease（Issue #240） ───────────────────────────────────
// workspace を canonicalWorkspace() で正規化して排他することで、表記差異（大文字小文字・
// 末尾スラッシュ等）による重複起動のすり抜けを防ぐ。監査イベント記録は
// GH_MAESTRO_RUNTIME_DIR（_env-setup.js がテスト用に隔離）へ書かれる。

const storageLayout = require('../scripts/shared/storage-layout');

test('roleLeaseKey: Windows パス無効文字をアンダースコアへ置換する', () => {
  assert.equal(lease.roleLeaseKey('worker-supervisor'), 'resident-role-worker-supervisor');
  assert.equal(lease.roleLeaseKey('msgpoll-orchestrator'), 'resident-role-msgpoll-orchestrator');
  // Windows のファイル名に使えない文字が混入しても安全なキーになる
  assert.equal(lease.roleLeaseKey('a/b:c*d?e"f<g>h|i'), 'resident-role-a_b_c_d_e_f_g_h_i');
});

test('msgPollRole: MSGPOLL_ORCHESTRATOR_ROLE と msg-poll.js の role 構築が一箇所に集約されている（PR #302）', () => {
  // MSGPOLL_ORCHESTRATOR_ROLE が msgPollRole('orchestrator') から導出されて
  // いることを固定する。
  assert.equal(typeof lease.msgPollRole, 'function');
  assert.equal(lease.msgPollRole('orchestrator'), 'msgpoll-orchestrator');
  assert.equal(lease.msgPollRole('worker-1'), 'msgpoll-worker-1');
  assert.equal(lease.MSGPOLL_ORCHESTRATOR_ROLE, lease.msgPollRole('orchestrator'));
});

test('acquireResidentLease: live lease が無ければ取得して自PIDでアクティブ化する', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    const res = lease.acquireResidentLease({ workspace: tmp, role: 'worker-supervisor' });
    try {
      assert.equal(res.acquired, true);
      const canonical = storageLayout.canonicalWorkspace(tmp);
      const entry = JSON.parse(fs.readFileSync(
        path.join(canonical, '.gh-maestro', 'leases', lease.roleLeaseKey('worker-supervisor') + '.json'), 'utf8'));
      // 起動元（launcher）ではなく、実際に稼働するプロセス自身のPID/startTime を記録する
      assert.equal(entry.pid, process.pid);
      assert.equal(entry.phase, 'active');
      assert.equal(lease.isResidentLeaseLive({ workspace: tmp, role: 'worker-supervisor' }), true);
    } finally {
      res.release();
    }
    assert.equal(lease.isResidentLeaseLive({ workspace: tmp, role: 'worker-supervisor' }), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: アクティベート（update）失敗時も警告して継続し、起動を拒否しない（Issue #252）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });

    // Windows で他プロセスが対象ファイルを掴む rename EPERM を再現する。atomic-write.js の
    // リトライ予算（500ms）を使い切って throw するまで fs.renameSync を失敗させ、update が
    // 失敗しても acquireResidentLease が起動を拒否しないことを検証する。
    const origRenameSync = fs.renameSync;
    const origWarn = console.warn;
    const warnings = [];
    fs.renameSync = () => {
      const err = new Error('EPERM: simulated rename contention');
      err.code = 'EPERM';
      throw err;
    };
    console.warn = (msg) => { warnings.push(String(msg)); };
    try {
      const res = lease.acquireResidentLease({ workspace: tmp, role: 'worker-supervisor' });
      try {
        assert.equal(res.acquired, true);
        // 黙って素通りせず、アクティベート失敗が警告されている
        assert.ok(warnings.some(w => w.includes('アクティベートに失敗')),
          `warnings: ${JSON.stringify(warnings)}`);
        // リース本体は acquireLease で作成済みのまま残る（phase は initializing のまま）
        const canonical = storageLayout.canonicalWorkspace(tmp);
        const entry = JSON.parse(fs.readFileSync(
          path.join(canonical, '.gh-maestro', 'leases', lease.roleLeaseKey('worker-supervisor') + '.json'), 'utf8'));
        assert.equal(entry.pid, process.pid);
        assert.equal(entry.phase, 'initializing');
        // 稼働中は正しく live とみなされ、重複起動防止は維持される
        assert.equal(lease.isResidentLeaseLive({ workspace: tmp, role: 'worker-supervisor' }), true);
      } finally {
        res.release();
      }
      // クリーン終了時はリースが解放される
      assert.equal(lease.isResidentLeaseLive({ workspace: tmp, role: 'worker-supervisor' }), false);
    } finally {
      fs.renameSync = origRenameSync;
      console.warn = origWarn;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: live lease があれば lock-denied を監査記録して throw する', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: 424242, startTime: '2026-07-29T00:00:00.424Z', workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    assert.throws(
      () => lease.acquireResidentLease({ workspace: tmp, role: 'worker-supervisor' }),
      /重複起動できません/
    );

    // lock-denied イベントが記録されている（黙って失敗させない）
    const residentAudit = require('../scripts/shared/resident-audit');
    const events = residentAudit.listUnprocessedResidentAuditEvents(canonical);
    const denied = events.filter(e => e.event.type === 'lock-denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].event.role, 'worker-supervisor');
    assert.equal(denied[0].event.detail.ownerPid, 424242);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: workspace 表記の差異（末尾スラッシュ）でも同一の排他領域で拒否する（Issue #240）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: 424242, startTime: '2026-07-29T00:00:00.424Z', workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    // 生パスと「末尾スラッシュ付き」の表記が異なっても、同じ canonical へ正規化され同一排他領域になる
    assert.throws(
      () => lease.acquireResidentLease({ workspace: tmp + path.sep, role: 'worker-supervisor' }),
      /重複起動できません/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: --force は既存所有者を停止させて同じ lease を再取得する', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    // 既存所有者が kill されるまで alive、kill されたら false を返す
    let ownerAlive = true;
    const ownerPid = 424242;
    lease._setIsProcessAlive((pid) => ownerAlive || pid !== ownerPid);
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); ownerAlive = false; });
    lease._setSleep(() => {});

    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: ownerPid, startTime: '2026-07-29T00:00:00.424Z', workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    const res = lease.acquireResidentLease({
      workspace: tmp,
      role: 'worker-supervisor',
      handoff: true,
      deadlineMs: 1000,
      env: { GH_MAESTRO_WORKER: 'orchestrator' },
    });
    try {
      assert.equal(res.acquired, true);
      assert.deepEqual(kills, [ownerPid]);
      // handoff-wait イベントが記録されている
      const residentAudit = require('../scripts/shared/resident-audit');
      const events = residentAudit.listUnprocessedResidentAuditEvents(canonical);
      assert.equal(events.some(e => e.event.type === 'handoff-wait'), true);
    } finally {
      res.release();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: startTime 欠落の細工リースは --force の停止対象にしない（任意PID誤kill防止）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    const ownerPid = 424242;
    mockLiveness({ alive: true });
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); });
    lease._setSleep(() => {});

    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    // 攻撃者が workspace に置ける細工リース: startTime 無し・PID のみ
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: ownerPid, workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    const res = lease.acquireResidentLease({
      workspace: tmp,
      role: 'worker-supervisor',
      handoff: true,
      deadlineMs: 50,
      env: { GH_MAESTRO_WORKER: 'orchestrator' },
    });
    try {
      // isLeaseLive が false のため停止対象にならず、stale として回収して取得できる
      assert.equal(res.acquired, true);
      assert.deepEqual(kills, [], `細工リースの PID が kill されてはならない: ${JSON.stringify(kills)}`);
    } finally {
      res.release();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: --force でも所有者が終了しなければ期限超過で acquired:false（本稼働へ進まない）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    const ownerPid = 424242;
    lease._setKillProcessTree(() => {}); // 止めても ownerAlive は変わらない
    lease._setSleep(() => {});

    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: ownerPid, startTime: '2026-07-29T00:00:00.424Z', workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    const res = lease.acquireResidentLease({ workspace: tmp, role: 'worker-supervisor', handoff: true, deadlineMs: 50, env: { GH_MAESTRO_WORKER: 'orchestrator' } });
    assert.equal(res.acquired, false);
    assert.equal(res.reason, 'handoff-timeout');
    assert.equal(res.ownerPid, ownerPid);
    // 期限超過の lock-denied も記録される
    const residentAudit = require('../scripts/shared/resident-audit');
    const events = residentAudit.listUnprocessedResidentAuditEvents(canonical);
    const denied = events.filter(e => e.event.type === 'lock-denied' && e.event.detail.reason === 'handoff-timeout');
    assert.equal(denied.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: GH_MAESTRO_WORKER がワーカー名のときは handoff を拒否し kill しない（Issue #384）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    const ownerPid = 424242;
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); });

    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: ownerPid, startTime: '2026-07-29T00:00:00.424Z', workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    assert.throws(
      () => lease.acquireResidentLease({
        workspace: tmp,
        role: 'worker-supervisor',
        handoff: true,
        env: { GH_MAESTRO_WORKER: 'issue-384-coder-force-guard' },
      }),
      /ワーカー "issue-384-coder-force-guard" からの常駐プロセスの強制置き換え/
    );

    assert.deepEqual(kills, [], 'ワーカーからの要求で既存プロセスを kill してはならない');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireResidentLease: GH_MAESTRO_WORKER が未設定のときは handoff を拒否し kill しない（Issue #384）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  try {
    mockLiveness({ alive: true });
    const ownerPid = 424242;
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); });

    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: ownerPid, startTime: '2026-07-29T00:00:00.424Z', workerName: 'worker-supervisor', phase: 'active',
    }), 'utf8');

    assert.throws(
      () => lease.acquireResidentLease({
        workspace: tmp,
        role: 'worker-supervisor',
        handoff: true,
        env: {},
      }),
      /GH_MAESTRO_WORKER/
    );

    assert.deepEqual(kills, [], '名乗り無しでの要求で既存プロセスを kill してはならない');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

