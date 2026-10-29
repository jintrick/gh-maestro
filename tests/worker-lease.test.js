'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();
const { createResourceLiveness, createTestLiveness, testEndpointPath } = require('./helpers/process-liveness-test-double');

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const lease = require('../scripts/shared/worker-lease');
const processLiveness = require('../scripts/shared/process-liveness');
let currentProbePid = () => 'alive';
let activeLiveness = null;
const tempDirScopes = new Map();

function createTestTempDir() {
  const scope = createTempDirScope();
  const directory = scope.mkdtemp('gh-maestro-lease-test-');
  tempDirScopes.set(directory, scope);
  return directory;
}

function cleanupTestTempDir(directory) {
  const scope = tempDirScopes.get(directory);
  if (!scope) return;
  scope.cleanup();
  tempDirScopes.delete(directory);
}

function installTestLiveness(checker) {
  activeLiveness = checker;
  lease._setLiveness(checker);
}

const defaultLiveness = processLiveness.createLiveness({
  probePid: () => 'alive',
  readStartTime: () => '2026-07-29T00:00:00.000Z',
});
installTestLiveness(defaultLiveness);

function testProcessRef(pid, instanceId = 'test-instance') {
  const checker = activeLiveness || processLiveness;
  return checker.captureProcess(pid, `legacy-process:${pid}`, instanceId || 'test-instance');
}

function setReader(readStartTime) {
  if (typeof readStartTime !== 'function') return;
  installTestLiveness(processLiveness.createLiveness({
    probePid: currentProbePid,
    readStartTime,
  }));
}

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
  currentProbePid = () => 'alive';
  installTestLiveness(defaultLiveness);
  lease._setKillProcessTree(() => { throw new Error('_killProcessTree は未注入のまま呼ばれた'); });
  lease._setSleep(() => {});
});

// ── テスト用ヘルパー ───────────────────────────────────────────────────────────

function tempStore() {
  const tmp = createTestTempDir();
  const store = lease.createNormalWorkerStore(tmp);
  store._tmpDir = tmp;
  return store;
}

function cleanupStore(store) {
  if (store._tmpDir) {
    cleanupTestTempDir(store._tmpDir);
  }
}

function mockLiveness({ alive = true, identityMatch = true, livePids = [], mismatchPids = [] } = {}) {
  const calls = { alive: [], verify: [] };
  const times = new Map([
    [4242, '2026-07-29T00:00:00.000Z'],
    [8888, '2026-07-28T00:00:00.000Z'],
    [7777, '2026-07-28T00:00:00.000Z'],
    [424242, '2026-07-29T00:00:00.424Z'],
    [process.pid, '2026-07-29T00:00:00.000Z'],
  ]);
  currentProbePid = (pid) => {
    calls.alive.push(pid);
    return pid === process.pid || livePids.includes(pid) || alive ? 'alive' : 'dead';
  };
  installTestLiveness(processLiveness.createLiveness({
    probePid: currentProbePid,
    readStartTime: (pid) => {
      calls.verify.push(pid);
      if (pid === process.pid || livePids.includes(pid) || !mismatchPids.includes(pid) && identityMatch) {
        return times.get(pid) || '2026-07-29T00:00:00.000Z';
      }
      if (mismatchPids.includes(pid) || !identityMatch) return '2000-01-01T00:00:00.000Z';
      return times.get(pid) || '2026-07-29T00:00:00.000Z';
    },
  }));
  return calls;
}

function seedResidentEndpoint(checker, workspace, role, pid, instanceId = `resident-${pid}`) {
  return checker.captureProcess(pid, {
    workspace,
    kind: 'resident',
    name: role,
    instanceId,
  });
}

function writeResidentLease(workspace, checker, role, pid, instanceId = `resident-${pid}`, fields = {}) {
  const ref = seedResidentEndpoint(checker, workspace, role, pid, instanceId);
  const record = checker.writeRef({
    workerName: role,
    phase: 'active',
    createdAt: '2026-10-29T00:00:00.000Z',
    ...fields,
  }, ref);
  lease.createResidentLeaseStore(workspace).write(lease.roleLeaseKey(role), record);
  return { ref, record };
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

test('createNormalWorkerStore: 破損JSONは read でエラーを返す', () => {
  const store = tempStore();
  try {
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'broken.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '{not valid json', 'utf8');
    assert.throws(() => store.read('broken'), /破損/);
    assert.equal(fs.readFileSync(fp, 'utf8'), '{not valid json');
  } finally {
    cleanupStore(store);
  }
});

test('createNormalWorkerStore: オブジェクト以外は read でエラーを返す', () => {
  const store = tempStore();
  try {
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'not-obj.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '"just a string"', 'utf8');
    assert.throws(() => store.read('not-obj'), /形式が不正/);

    fs.writeFileSync(fp, 'null', 'utf8');
    assert.throws(() => store.read('not-obj'), /形式が不正/);

    fs.writeFileSync(fp, '[1,2,3]', 'utf8');
    assert.throws(() => store.read('not-obj'), /形式が不正/);
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

test('isLeaseLive: endpointがaliveなら古いstartTime値に関係なくtrue', () => {
  mockLiveness({ alive: true, mismatchPids: [4242] });
  assert.equal(lease.isLeaseLive({
    pid: 4242, startTime: '2026-07-29T00:00:00.000Z', workerName: 'w', createdAt: 'x',
  }), true);
});

test('isLeaseLive: 識別情報が欠けた lease は判定不能としてエラー', () => {
  installTestLiveness(createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' }));
  for (const entry of [{ pid: 4242 }, {}, { pid: 0 }]) {
    assert.throws(() => lease.isLeaseLive(entry), /判定できません/);
  }
  assert.equal(lease.isLeaseLive(null), false);
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

test('acquireLeaseLock: 自プロセスの起動時刻を取得できない場合はロックを作成せずstale回収もしない', () => {
  const store = tempStore();
  try {
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(
      store.lockPath('test-key'),
      JSON.stringify({ pid: 99999, startTime: '2026-07-29T00:00:00.000Z' }),
      'utf8'
    );
    installTestLiveness(createTestLiveness({
      probePid: (pid) => pid === process.pid ? 'alive' : 'unknown',
    }));

    assert.throws(
      () => lease.acquireLeaseLock(store, 'test-key'),
      /生死を判定できません/
    );
    assert.equal(fs.existsSync(store.lockPath('test-key')), true);
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
    fs.writeFileSync(store.lockPath('test-key'), JSON.stringify({ pid: process.pid, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

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

test('acquireLeaseLock: live resourceはstartTime不一致でもstale扱いせず拒否する', () => {
  const store = tempStore();
  try {
    // 生存しているが、ロックに記録されたstartTimeとは別プロセス（PID再利用）のケース
    mockLiveness({ alive: true, identityMatch: false });
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), JSON.stringify({ pid: 99999, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

    assert.throws(() => lease.acquireLeaseLock(store, 'test-key'), /進行中/);
    assert.equal(fs.existsSync(store.lockPath('test-key')), true);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLeaseLock: 破損ロックは保持してエラーにする', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: false });
    fs.mkdirSync(path.dirname(store.lockPath('test-key')), { recursive: true });
    fs.writeFileSync(store.lockPath('test-key'), 'not-json', 'utf8');

    assert.throws(() => lease.acquireLeaseLock(store, 'test-key'), /保持者を読めません/);
    assert.equal(fs.readFileSync(store.lockPath('test-key'), 'utf8'), 'not-json');
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

test('acquireLease: ProcessRefを直接渡すと本番leaseコードが新規作成する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: true, identityMatch: true });
    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.000Z'), workerName: 'issue-1-coder-test',
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

test('acquireLease: callerが捕捉したProcessRefをロックとleaseで共有する', () => {
  const store = tempStore();
  let calls = 0;
  try {
    mockLiveness({ alive: true, identityMatch: true });
    setReader(() => {
      calls += 1;
      return '2026-07-29T00:00:00.424Z';
    });

    const processRef = activeLiveness.captureSelf();
    lease.acquireLease(store, 'issue-1-coder-test', { processRef, workerName: 'issue-1-coder-test' });

    assert.equal(calls, 0, 'liveness resource の確認はプロセス起動時刻の照会をしない');
    assert.equal(typeof store.read('issue-1-coder-test').resourceKey, 'string');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: endpoint probeがunknownならlock/leaseを作成しない', () => {
  const store = tempStore();
  try {
    const unknownLiveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' });
    installTestLiveness(unknownLiveness);

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        processRef: unknownLiveness.captureSelf(),
        workerName: 'issue-1-coder-test',
      }),
      /endpoint/
    );
    assert.equal(store.read('issue-1-coder-test'), null);
    assert.equal(fs.existsSync(store.lockPath('issue-1-coder-test')), false);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: live lease があればエラーを投げる（重複起動拒否）', () => {
  const store = tempStore();
  try {
    const checker = createTestLiveness({ probePid: () => 'alive' });
    installTestLiveness(checker);
    const workerRef = checker.captureProcess(8888, {
      workspace: store.workspace,
      kind: 'worker',
      name: 'issue-1-coder-test',
      instanceId: 'worker-generation-1',
    });
    store.write('issue-1-coder-test', checker.writeRef({
      workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    }, workerRef));

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        processRef: testProcessRef(4242), workerName: 'issue-1-coder-test',
      }),
      /既に稼働中/
    );
    // 元のリースはそのまま残っている
    assert.equal(store.read('issue-1-coder-test').pid, 8888);
  } finally {
    cleanupStore(store);
  }
});

// PR1 形式（resourceKey/instanceId なし）の lease は、保持者が決定論的 endpoint を持たない。
// ワーカー endpoint の dead は保持者の死亡を示さないため、PID の不在（ESRCH）だけで回収する。
function writePr1WorkerLease(store, workerName, pid) {
  const entry = {
    pid,
    workerName,
    createdAt: '2026-07-28T00:00:00.000Z',
    phase: 'active',
    // テスト double が startTime 付き記録を test endpoint へ読み替えないよう、
    // 本物の PR1 記録と同じ endpointless 経路を明示する。
    legacyEndpointless: true,
  };
  store.write(workerName, entry);
  return entry;
}

function launcherFor(checker, store, workerName) {
  return checker.captureSelf({ workspace: store.workspace, kind: 'launcher', name: workerName });
}

test('acquireLease: worker endpointがdeadでもPIDが存在するPR1 leaseは回収せず起動を拒否する', () => {
  const store = tempStore();
  const workerName = 'issue-1-coder-test';
  try {
    const checker = createTestLiveness({
      probePid: (pid) => (pid === 8888 || pid === process.pid ? 'alive' : 'dead'),
    });
    installTestLiveness(checker);
    const entry = writePr1WorkerLease(store, workerName, 8888);
    const launcher = launcherFor(checker, store, workerName);

    assert.throws(
      () => lease.acquireLease(store, workerName, { processRef: launcher, workerName }),
      (error) => error.code === 'LIVENESS_UNKNOWN' && /PR1 形式 lease（pid 8888）/.test(error.message),
    );
    assert.deepEqual(store.read(workerName), entry, '判定不能な旧 lease は削除も上書きもしない');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: PR1 lease の PID 照会が ESRCH 以外で失敗したら unknown として拒否する', () => {
  const store = tempStore();
  const workerName = 'issue-1-coder-test';
  try {
    // test double の kill は probePid の unknown を EPERM として投げる（ESRCH ではない）。
    const checker = createTestLiveness({
      probePid: (pid) => (pid === process.pid ? 'alive' : 'unknown'),
    });
    installTestLiveness(checker);
    const entry = writePr1WorkerLease(store, workerName, 8888);
    const launcher = launcherFor(checker, store, workerName);

    assert.throws(
      () => lease.acquireLease(store, workerName, { processRef: launcher, workerName }),
      (error) => error.code === 'LIVENESS_UNKNOWN' && /生死を判定できません/.test(error.message),
    );
    assert.deepEqual(store.read(workerName), entry);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: PR1 lease の PID が ESRCH なら遺物として回収する', () => {
  const store = tempStore();
  const workerName = 'issue-1-coder-test';
  try {
    const checker = createTestLiveness({
      probePid: (pid) => (pid === process.pid ? 'alive' : 'dead'),
    });
    installTestLiveness(checker);
    writePr1WorkerLease(store, workerName, 8888);
    const launcher = launcherFor(checker, store, workerName);

    const result = lease.acquireLease(store, workerName, { processRef: launcher, workerName });

    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);
    assert.equal(store.read(workerName).pid, process.pid);
    lease.releaseLease(store, workerName, launcher);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: pid が不正な PR1 lease は corrupt として拒否しファイルを保持する', () => {
  const store = tempStore();
  const workerName = 'issue-1-coder-test';
  try {
    const checker = createTestLiveness({
      probePid: (pid) => (pid === process.pid ? 'alive' : 'dead'),
    });
    installTestLiveness(checker);
    const entry = { pid: 'not-a-pid', workerName, createdAt: 'x', legacyEndpointless: true };
    store.write(workerName, entry);
    const launcher = launcherFor(checker, store, workerName);

    assert.throws(
      () => lease.acquireLease(store, workerName, { processRef: launcher, workerName }),
      (error) => error.code === 'LIVENESS_CORRUPT' && /pid が不正です/.test(error.message),
    );
    assert.deepEqual(store.read(workerName), entry);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: lease file が無くても既存worker endpointを正本として二重起動を拒否する', () => {
  const store = tempStore();
  const workerName = 'endpoint-only-worker';
  try {
    const checker = createTestLiveness({ probePid: () => 'alive' });
    installTestLiveness(checker);
    checker.captureProcess(5151, {
      workspace: store.workspace,
      kind: 'worker',
      name: workerName,
      instanceId: 'existing-worker-instance',
    });
    const launcher = checker.captureSelf({
      workspace: store.workspace,
      kind: 'launcher',
      name: 'spawn-worker',
    });

    assert.throws(() => lease.acquireLease(store, workerName, {
      processRef: launcher,
      workerName,
    }), /既に稼働中です（pid 5151）/);
    assert.equal(store.read(workerName), null);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: lease file とworker endpointが無くてもendpoint照会unknownなら作成を拒否する', () => {
  const store = tempStore();
  const workerName = 'unknown-endpoint-worker';
  try {
    const checker = createTestLiveness({ probePid: () => 'unknown' });
    installTestLiveness(checker);
    checker.captureProcess(5152, {
      workspace: store.workspace,
      kind: 'worker',
      name: workerName,
      instanceId: 'unknown-worker-instance',
    });
    const launcher = checker.captureSelf({
      workspace: store.workspace,
      kind: 'launcher',
      name: 'spawn-worker',
    });

    assert.throws(() => lease.acquireLease(store, workerName, {
      processRef: launcher,
      workerName,
    }), { code: 'LIVENESS_UNKNOWN' });
    assert.equal(store.read(workerName), null);
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: stale lease（PID死亡）は回収して新規作成する', () => {
  const store = tempStore();
  try {
    mockLiveness({ alive: false, livePids: [4242] }); // stale leaseは死亡、新しい所有者は生存
    store.write('issue-1-coder-test', {
      pid: 8888, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    });

    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.000Z'), workerName: 'issue-1-coder-test',
    });
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);

    // 新しいリースに置き換わっている
    const entry = store.read('issue-1-coder-test');
    assert.equal(entry.pid, 4242);
    assert.equal(typeof entry.resourceKey, 'string');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: startTime が無くても死亡PIDのleaseだけは回収できる', () => {
  const store = tempStore();
  const startTimeReads = [];
  try {
    installTestLiveness(processLiveness.createLiveness({
      probePid: (pid) => pid === 4242 || pid === process.pid ? 'alive' : pid === 8888 ? 'dead' : 'unknown',
      readStartTime: (pid) => {
        startTimeReads.push(pid);
        return pid === process.pid ? '2026-07-29T00:00:01.000Z' : '2026-07-29T00:00:00.000Z';
      },
    }));
    store.write('issue-1-coder-test', {
      pid: 8888, startTime: null, workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    });

    const result = lease.acquireLease(store, 'issue-1-coder-test', {
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.000Z'), workerName: 'issue-1-coder-test',
    });
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);
    assert.equal(store.read('issue-1-coder-test').pid, 4242);
    assert.equal(startTimeReads.includes(8888), false, 'dead PID は startTime が無くても再照会しない');
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: lease記録と無関係にworker endpointがliveなら二重起動を拒否する', () => {
  const store = tempStore();
  try {
    const checker = createTestLiveness({ probePid: () => 'alive' });
    installTestLiveness(checker);
    checker.captureProcess(4242, {
      workspace: store.workspace,
      kind: 'worker',
      name: 'issue-1-coder-test',
      instanceId: 'current-worker-instance',
    });
    store.write('issue-1-coder-test', {
      pid: 8888, startTime: '2026-07-28T00:00:00.000Z', workerName: 'issue-1-coder-test', createdAt: '2026-07-28T00:00:00.000Z',
    });

    assert.throws(() => lease.acquireLease(store, 'issue-1-coder-test', {
      processRef: testProcessRef(process.pid), workerName: 'issue-1-coder-test',
    }), /既に稼働中/);
    assert.equal(store.read('issue-1-coder-test').pid, 8888);
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
    assert.throws(() => lease.acquireLease(store, 'issue-1-coder-test', {
      processRef: testProcessRef(4242), workerName: 'issue-1-coder-test',
    }), /破損/);
    assert.equal(fs.readFileSync(fp, 'utf8'), 'corrupt');
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
    fs.writeFileSync(store.lockPath('issue-1-coder-test'), JSON.stringify({ pid: process.pid, startTime: '2026-07-29T00:00:00.000Z' }), 'utf8');

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        processRef: testProcessRef(4242), workerName: 'issue-1-coder-test',
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
    const checker = createTestLiveness({ probePid: () => 'alive' });
    installTestLiveness(checker);

    // store.read を差し替え: 1回目はnull（高速チェック通過）、2回目はlive lease（再チェックで検出）
    let readCount = 0;
    const origRead = store.read.bind(store);
    store.read = function (key) {
      readCount++;
      if (readCount === 1) return null; // 高速チェック
      if (readCount >= 2) {
        // ロック下の再チェック: live leaseが出現
        const ref = checker.captureProcess(7777, {
          workspace: store.workspace,
          kind: 'worker',
          name: 'issue-1-coder-test',
          instanceId: 'racing-worker-instance',
        });
        return checker.writeRef({ workerName: 'issue-1-coder-test', createdAt: 'x' }, ref);
      }
      return origRead(key);
    };

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        processRef: testProcessRef(process.pid), workerName: 'issue-1-coder-test',
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
      pid: 4242, startTime: '2026-07-29T00:00:00.424Z', workerName: 'w', createdAt: 'x',
    });

    lease.releaseLease(store, 'test-key', testProcessRef(4242, '2026-07-29T00:00:00.424Z'));
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

    lease.releaseLease(store, 'test-key', testProcessRef(4242, '2026-07-29T00:00:00.424Z'));
    assert.equal(store.read('test-key').pid, 8888);
  } finally {
    cleanupStore(store);
  }
});

test('releaseLease: 存在しないキーでもエラーにならない', () => {
  const store = tempStore();
  try {
    assert.doesNotThrow(() => lease.releaseLease(store, 'nonexistent', testProcessRef(4242)));
  } finally {
    cleanupStore(store);
  }
});

test('releaseResidentLeaseForProcess: 停止済みプロセスとPID/startTimeが一致するleaseだけを解放する', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  try {
    const role = 'worker-supervisor';
    const startTime = '2026-07-29T00:00:00.424Z';
    store.write(lease.roleLeaseKey(role), {
      pid: 4242,
      startTime,
      workerName: role,
      phase: 'active',
    });

    const result = lease.releaseResidentLeaseForProcess({
      workspace: tmp,
      role,
      processRef: testProcessRef(4242, startTime),
    });

    assert.deepEqual(result, { released: true, remaining: false });
    assert.equal(store.read(lease.roleLeaseKey(role)), null);
    assert.equal(fs.existsSync(store.lockPath(lease.roleLeaseKey(role))), false,
      'owner lease解放後に一時lockを残さないこと');
  } finally {
    cleanupStore(store);
  }
});

test('releaseResidentLeaseForProcess: 別PIDの生存中leaseは削除せずno-op成功にする', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  const calls = mockLiveness({ alive: true });
  try {
    const role = 'worker-supervisor';
    const replacement = {
      pid: 5252,
      startTime: '2026-07-29T00:00:00.525Z',
      workerName: role,
      phase: 'active',
    };
    store.write(lease.roleLeaseKey(role), replacement);

    const result = lease.releaseResidentLeaseForProcess({
      workspace: tmp,
      role,
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.424Z'),
    });

    assert.deepEqual(result, {
      released: false,
      remaining: false,
      reason: 'lease owner identity does not match the stopped process',
    });
    assert.ok(calls.alive.length > 0);
    assert.deepEqual(calls.alive.filter((pid) => pid !== process.pid), [], '別PIDのleaseは観測しない');
    assert.deepEqual(calls.verify.filter((pid) => pid !== process.pid), [], '別PIDのleaseは参照しない');
    assert.deepEqual(store.read(lease.roleLeaseKey(role)), replacement);
  } finally {
    cleanupStore(store);
  }
});

test('releaseResidentLeaseForProcess: 別PIDの死亡済みstale leaseもno-op成功にする', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  const calls = mockLiveness({ alive: false });
  try {
    const role = 'worker-supervisor';
    const stale = {
      pid: 6262,
      startTime: '2026-07-29T00:00:00.626Z',
      workerName: role,
      phase: 'active',
    };
    store.write(lease.roleLeaseKey(role), stale);

    const result = lease.releaseResidentLeaseForProcess({
      workspace: tmp,
      role,
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.424Z'),
    });

    assert.deepEqual(result, {
      released: false,
      remaining: false,
      reason: 'lease owner identity does not match the stopped process',
    });
    assert.ok(calls.alive.length > 0);
    assert.deepEqual(calls.alive.filter((pid) => pid !== process.pid), [], '別PIDのleaseは観測しない');
    assert.deepEqual(calls.verify.filter((pid) => pid !== process.pid), [], '別PIDのleaseは参照しない');
    assert.deepEqual(store.read(lease.roleLeaseKey(role)), stale,
      '停止対象ではないstale leaseはacquire側の回収に委ねる');
  } finally {
    cleanupStore(store);
  }
});

test('releaseResidentLeaseForProcess: 異なる参照のleaseは削除しない', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  try {
    const role = 'worker-supervisor';
    const leaseIdentity = '2026-07-29T02:00:00.525Z';
    store.write(lease.roleLeaseKey(role), {
      pid: 4242,
      startTime: leaseIdentity,
      workerName: role,
      phase: 'active',
    });

    const result = lease.releaseResidentLeaseForProcess({
      workspace: tmp,
      role,
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.424Z'),
    });

    assert.deepEqual(result, {
      released: false,
      remaining: true,
      reason: 'lease owner identity does not match the stopped process',
    });
    assert.equal(store.read(lease.roleLeaseKey(role)).startTime, leaseIdentity);
  } finally {
    cleanupStore(store);
  }
});

test('acquireResidentLease: 不透明な参照のPIDとOS資源IDをleaseへ保存する', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  try {
    mockLiveness();
    const processRef = activeLiveness.prepareSelf({
      workspace: tmp,
      kind: 'resident',
      name: 'worker-supervisor',
    });

    const result = lease.acquireResidentLease({
      workspace: tmp,
      role: 'worker-supervisor',
      processRef,
    });

    assert.equal(store.read(lease.roleLeaseKey('worker-supervisor')).pid, process.pid);
    assert.equal(typeof store.read(lease.roleLeaseKey('worker-supervisor')).resourceKey, 'string');
    result.release();
  } finally {
    cleanupStore(store);
  }
});

test('acquireResidentLease: plugin takeover は生存中の同役割monitorを止めて後発をlease ownerにする', () => {
  const store = tempStore();
  const workspace = store._tmpDir;
  let oldMonitorAlive = true;
  const checker = createTestLiveness({
    probePid: (pid) => pid === process.pid ? 'alive' : pid === 4242 && oldMonitorAlive ? 'alive' : 'dead',
  });
  try {
    installTestLiveness(checker);
    const role = lease.POLL_PR_MONITOR_ROLE;
    const oldRef = checker.captureProcess(4242, {
      workspace, kind: 'resident', name: role, instanceId: 'old-plugin-monitor-instance',
    });
    checker.captureProcess(4242, {
      workspace, kind: 'resident-takeover', name: role, instanceId: 'old-plugin-takeover-instance',
    });
    const residentStore = lease.createResidentLeaseStore(workspace);
    residentStore.write(lease.roleLeaseKey(role), checker.writeRef({
      workerName: role,
      phase: 'active',
      createdAt: '2026-10-29T00:00:00.000Z',
    }, oldRef));

    const killedPids = [];
    lease._setKillProcessTree((pid) => {
      killedPids.push(pid);
      oldMonitorAlive = false;
    });
    lease._setSleep(() => {});

    const newRef = checker.prepareSelf({ workspace, kind: 'resident', name: role });
    const result = lease.acquireResidentLease({
      workspace,
      role,
      handoff: true,
      takeover: true,
      processRef: newRef,
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(killedPids, [4242]);
    const newLease = residentStore.read(lease.roleLeaseKey(role));
    assert.equal(newLease.pid, process.pid);
    assert.equal(typeof newLease.resourceKey, 'string');
    assert.notEqual(newLease.resourceKey, 'old-plugin-monitor-resource');
    result.release();
  } finally {
    cleanupStore(store);
  }
});

test('acquireResidentLease: plugin takeover は旧monitorがunknownなら停止もlease置換もしない', () => {
  const store = tempStore();
  const workspace = store._tmpDir;
  const checker = createTestLiveness({
    probePid: (pid) => pid === process.pid ? 'alive' : 'unknown',
  });
  try {
    installTestLiveness(checker);
    const role = lease.POLL_PR_MONITOR_ROLE;
    const oldRef = checker.captureProcess(4242, {
      workspace, kind: 'resident', name: role, instanceId: 'unknown-plugin-monitor-instance',
    });
    const residentStore = lease.createResidentLeaseStore(workspace);
    const oldLease = checker.writeRef({
      workerName: role,
      phase: 'active',
      createdAt: '2026-10-29T00:00:00.000Z',
    }, oldRef);
    residentStore.write(lease.roleLeaseKey(role), oldLease);

    const killedPids = [];
    lease._setKillProcessTree((pid) => killedPids.push(pid));
    lease._setSleep(() => {});

    assert.throws(() => lease.acquireResidentLease({
      workspace,
      role,
      handoff: true,
      takeover: true,
      processRef: checker.prepareSelf({ workspace, kind: 'resident', name: role }),
    }), /確認できません/);

    assert.deepEqual(killedPids, []);
    assert.deepEqual(residentStore.read(lease.roleLeaseKey(role)), oldLease);
  } finally {
    cleanupStore(store);
  }
});

test('acquireResidentLease: 自プロセス以外のPIDをidentityとして受け付けない', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  try {
    assert.throws(
      () => lease.acquireResidentLease({
        workspace: tmp,
        role: 'worker-supervisor',
        processRef: activeLiveness.captureProcess(process.pid + 1, {
          workspace: tmp, kind: 'resident', name: 'worker-supervisor', instanceId: 'other-process-instance',
        }),
      }),
      /不透明な参照が自プロセス/
    );
    assert.equal(store.read(lease.roleLeaseKey('worker-supervisor')), null);
    assert.equal(fs.existsSync(store.lockPath(lease.roleLeaseKey('worker-supervisor'))), false);
  } finally {
    cleanupStore(store);
  }
});

test('acquireResidentLease: 未確定のidentityでは新規leaseを作成しない', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  try {
    assert.throws(
      () => lease.acquireResidentLease({
        workspace: tmp,
        role: 'worker-supervisor',
        processRef: activeLiveness.readRef({ pid: process.pid, legacyEndpointless: true }),
      }),
      /不透明な参照が自プロセス/
    );
    assert.equal(store.read(lease.roleLeaseKey('worker-supervisor')), null);
    assert.equal(fs.existsSync(store.lockPath(lease.roleLeaseKey('worker-supervisor'))), false);
  } finally {
    cleanupStore(store);
  }
});

test('releaseResidentLeaseForProcess: 自分のleaseが削除後も残れば失敗扱いにする', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  const role = 'worker-supervisor';
  const leaseFileName = `${lease.roleLeaseKey(role)}.json`;
  const originalUnlinkSync = fs.unlinkSync;
  try {
    store.write(lease.roleLeaseKey(role), {
      pid: 4242,
      startTime: '2026-07-29T00:00:00.424Z',
      workerName: role,
      phase: 'active',
    });
    fs.unlinkSync = (filePath) => {
      if (path.basename(filePath) === leaseFileName) return;
      return originalUnlinkSync(filePath);
    };

    const result = lease.releaseResidentLeaseForProcess({
      workspace: tmp,
      role,
      processRef: testProcessRef(4242, '2026-07-29T00:00:00.424Z'),
    });

    assert.deepEqual(result, {
      released: false,
      remaining: true,
      reason: 'lease remains after removal',
    });
    assert.deepEqual(store.read(lease.roleLeaseKey(role)), {
      pid: 4242,
      startTime: '2026-07-29T00:00:00.424Z',
      workerName: role,
      phase: 'active',
    });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    cleanupStore(store);
  }
});

test('releaseResidentLeaseForProcess: 所有者identityが不足する場合はleaseを残して失敗扱いにする', () => {
  const store = tempStore();
  const tmp = store._tmpDir;
  try {
    const role = 'worker-supervisor';
    const existing = { pid: 4242, startTime: 'x', workerName: role, phase: 'active' };
    store.write(lease.roleLeaseKey(role), existing);

    const result = lease.releaseResidentLeaseForProcess({
      workspace: tmp,
      role,
      processRef: null,
    });

    assert.equal(result.released, false);
    assert.equal(result.remaining, true);
    assert.deepEqual(store.read(lease.roleLeaseKey(role)), existing);
  } finally {
    cleanupStore(store);
  }
});

// ── activateLease ─────────────────────────────────────────────────────────────

test('activateLease: リースのPIDとOS資源IDを実際のワーカー情報で更新する', () => {
  const store = tempStore();
  try {
    store.write('test-key', {
      pid: 100, startTime: 'old', workerName: 'w', createdAt: '2026-07-29T00:00:00.000Z',
    });

    lease.activateLease(store, 'test-key', testProcessRef(4242, '2026-07-29T00:00:00.000Z'));

    const entry = store.read('test-key');
    assert.equal(entry.pid, 4242);
    assert.equal(typeof entry.resourceKey, 'string');
    assert.equal(entry.workerName, 'w');
    assert.equal(entry.createdAt, '2026-07-29T00:00:00.000Z');
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: リースが消えていれば例外を投げ、無 lease のワーカーを成功扱いにしない', () => {
  const store = tempStore();
  try {
    assert.throws(
      () => lease.activateLease(store, 'nonexistent', testProcessRef(4242)),
      /アクティベート前に消えています/,
    );
    assert.equal(store.read('nonexistent'), null);
  } finally {
    cleanupStore(store);
  }
});

function writeInitializingLease(store) {
  const existing = {
    pid: 100, workerName: 'w', createdAt: 'x', phase: 'initializing', legacyEndpointless: true,
  };
  store.write('test-key', existing);
  return existing;
}

test('activateLease: ワーカーの endpoint が確立するまで待ってから lease を移す', () => {
  const store = tempStore();
  try {
    let workerUp = false;
    const checker = createTestLiveness({
      probePid: (pid) => (pid === 4242 ? (workerUp ? 'alive' : 'dead') : 'alive'),
    });
    installTestLiveness(checker);
    const existing = writeInitializingLease(store);
    const workerRef = checker.captureProcess(4242, 'worker:w', 'worker-instance');
    let sleeps = 0;
    lease._setSleep(() => {
      sleeps += 1;
      assert.deepEqual(store.read('test-key'), existing, '確立前は launcher の予約を書き換えない');
      // 3回目の待機中にワーカーが endpoint を開く
      if (sleeps === 3) workerUp = true;
    });

    lease.activateLease(store, 'test-key', workerRef, { waitMs: 60000 });

    assert.equal(sleeps, 3);
    const entry = store.read('test-key');
    assert.equal(entry.pid, 4242);
    assert.equal(entry.instanceId, 'worker-instance');
    assert.equal(entry.phase, 'active');
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: 期限内に endpoint が確立しなければ投げて launcher の予約を保持する', () => {
  const store = tempStore();
  try {
    const checker = createTestLiveness({ probePid: (pid) => (pid === 4242 ? 'dead' : 'alive') });
    installTestLiveness(checker);
    const existing = writeInitializingLease(store);
    const workerRef = checker.captureProcess(4242, 'worker:w', 'worker-instance');
    lease._setSleep((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));

    const started = Date.now();
    assert.throws(
      () => lease.activateLease(store, 'test-key', workerRef, { waitMs: 50 }),
      (error) => /生存を確認できません（dead/.test(error.message) && error.code === undefined,
    );
    assert.ok(Date.now() - started >= 50, '期限まで待ってから失敗する');
    assert.deepEqual(store.read('test-key'), existing);
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: 期限まで unknown なら LIVENESS_UNKNOWN で投げて予約を保持する', () => {
  const store = tempStore();
  try {
    const checker = createTestLiveness({ probePid: (pid) => (pid === 4242 ? 'unknown' : 'alive') });
    installTestLiveness(checker);
    const existing = writeInitializingLease(store);
    const workerRef = checker.captureProcess(4242, 'worker:w', 'worker-instance');

    assert.throws(
      () => lease.activateLease(store, 'test-key', workerRef, { waitMs: 0 }),
      (error) => error.code === 'LIVENESS_UNKNOWN',
    );
    assert.deepEqual(store.read('test-key'), existing);
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: callerが捕捉したProcessRefをそのまま保存する', () => {
  const store = tempStore();
  try {
    mockLiveness();
    let calls = 0;
    setReader(() => {
      calls += 1;
      return '2026-07-29T00:00:00.000Z';
    });
    store.write('test-key', {
      pid: 100, startTime: 'old', workerName: 'w', createdAt: 'x',
    });

    const processRef = activeLiveness.captureSelf();
    lease.activateLease(store, 'test-key', processRef);

    const entry = store.read('test-key');
    assert.equal(entry.pid, process.pid);
    assert.equal(typeof entry.resourceKey, 'string');
    assert.equal(calls, 0, 'activateLease はプロセス起動時刻を照会しない');
  } finally {
    cleanupStore(store);
  }
});

test('activateLease: 起動時刻を取得できない場合はleaseを更新しない', () => {
  const store = tempStore();
  try {
    const existing = {
      pid: 100,
      startTime: 'old',
      workerName: 'w',
      createdAt: 'x',
      phase: 'initializing',
    };
    store.write('test-key', existing);
    const unknownLiveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' });
    installTestLiveness(unknownLiveness);
    const processRef = unknownLiveness.captureSelf();

    assert.throws(
      () => lease.activateLease(store, 'test-key', processRef),
      /生存を確認できません/
    );
    assert.deepEqual(store.read('test-key'), existing);
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
    setReader(() => '2026-07-29T02:00:00.000Z');
    const processRef = testProcessRef(99999, '2026-07-29T02:00:00.000Z');
    lease.activateLease(store, 'test-key', processRef);
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
      processRef: activeLiveness.captureSelf(), workerName: 'issue-5-coder-fix-auth',
    });
    assert.equal(r1.acquired, true);
    assert.equal(r1.staleReclaimed, false);

    // 2. ワーカー起動後にアクティベート
    lease.activateLease(store, 'issue-5-coder-fix-auth', testProcessRef(99999, '2026-07-29T00:00:00.000Z'));
    assert.equal(store.read('issue-5-coder-fix-auth').pid, 99999);

    // 3. ワーカー終了時に解放
    lease.releaseLease(store, 'issue-5-coder-fix-auth', testProcessRef(99999, '2026-07-29T00:00:00.000Z'));
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
      processRef: activeLiveness.captureSelf(), workerName: 'issue-5-coder-fix-auth',
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
      processRef: activeLiveness.captureSelf(), workerName: 'issue-5-coder-fix-auth',
    });
    assert.notEqual(store.read('issue-5-coder-fix-auth'), null);

    // 起動失敗 → リース解放
    lease.releaseLease(store, 'issue-5-coder-fix-auth', activeLiveness.captureSelf());
    assert.equal(store.read('issue-5-coder-fix-auth'), null);

    // 後続の起動がブロックされない
    const r = lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      processRef: testProcessRef(99999), workerName: 'issue-5-coder-fix-auth',
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
    mockLiveness({ alive: false }); // dead process reference
    fs.mkdirSync(path.dirname(store.lockPath('issue-5-coder-fix-auth')), { recursive: true });
    fs.writeFileSync(store.lockPath('issue-5-coder-fix-auth'), JSON.stringify({ pid: 2147483647, startTime: '2000-01-01T00:00:00.000Z' }), 'utf8');

    // 既存leaseはなし、ロックはstale → 奪取成功
    lease.acquireLease(store, 'issue-5-coder-fix-auth', {
      processRef: activeLiveness.captureSelf(), workerName: 'issue-5-coder-fix-auth',
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
  const tmp = createTestTempDir();
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
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: endpoint取得後のlease metadata更新失敗は警告して継続する', () => {
  const tmp = createTestTempDir();
  try {
    const checker = createTestLiveness({
      probePid: (pid) => pid === process.pid ? 'alive' : 'dead',
    });
    installTestLiveness(checker);
    writeResidentLease(tmp, checker, 'worker-supervisor', 999999, 'stale-worker-supervisor');

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
        assert.ok(warnings.some(w => w.includes('リースメタデータを保存できません')),
          `warnings: ${JSON.stringify(warnings)}`);
        // endpointが排他の正本なので、補助メタデータ更新が失敗しても新所有者はlive。
        const canonical = storageLayout.canonicalWorkspace(tmp);
        assert.equal(fs.existsSync(path.join(canonical, '.gh-maestro', 'leases', lease.roleLeaseKey('worker-supervisor') + '.json')), true);
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
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: live lease があれば lock-denied を監査記録して throw する', () => {
  const tmp = createTestTempDir();
  try {
    mockLiveness({ alive: true });
    const canonical = storageLayout.canonicalWorkspace(tmp);
    writeResidentLease(tmp, activeLiveness, 'worker-supervisor', 424242, 'existing-worker-supervisor');

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
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: workspace 表記の差異（末尾スラッシュ）でも同一の排他領域で拒否する（Issue #240）', () => {
  const tmp = createTestTempDir();
  try {
    mockLiveness({ alive: true });
    writeResidentLease(tmp, activeLiveness, 'worker-supervisor', 424242, 'existing-worker-supervisor');

    // 生パスと「末尾スラッシュ付き」の表記が異なっても、同じ canonical へ正規化され同一排他領域になる
    assert.throws(
      () => lease.acquireResidentLease({ workspace: tmp + path.sep, role: 'worker-supervisor' }),
      /重複起動できません/
    );
  } finally {
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: --force は既存所有者を停止させて同じ lease を再取得する', () => {
  const tmp = createTestTempDir();
  try {
    // 既存所有者が kill されるまで alive、kill されたら false を返す
    let ownerAlive = true;
    const ownerPid = 424242;
    const checker = createTestLiveness({
      probePid: (pid) => ownerAlive || pid !== ownerPid ? 'alive' : 'dead',
    });
    installTestLiveness(checker);
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); ownerAlive = false; });
    lease._setSleep(() => {});

    const canonical = storageLayout.canonicalWorkspace(tmp);
    writeResidentLease(tmp, checker, 'worker-supervisor', ownerPid, 'handoff-owner-instance');

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
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: endpoint probeのunknownではPR1形式リースを保持して引き継がない', () => {
  const tmp = createTestTempDir();
  try {
    const ownerPid = 424242;
    installTestLiveness(createTestLiveness({ probeEndpoint: () => 'unknown' }));
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

    assert.throws(() => lease.acquireResidentLease({
      workspace: tmp, role: 'worker-supervisor', handoff: true,
      deadlineMs: 50, env: { GH_MAESTRO_WORKER: 'orchestrator' },
    }), { code: 'LIVENESS_UNKNOWN' });
    assert.deepEqual(kills, []);
    assert.equal(lease.createResidentLeaseStore(tmp).read(lease.roleLeaseKey('worker-supervisor')).pid, ownerPid);
  } finally {
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: deterministic endpointがdeadならPIDが存在するPR1形式リースも上書きする', () => {
  const tmp = createTestTempDir();
  try {
    const ownerPid = 424242;
    installTestLiveness(createTestLiveness({
      probePid: () => 'alive',
    }));
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); });
    lease._setSleep(() => {});

    const canonical = storageLayout.canonicalWorkspace(tmp);
    const leasesDir = path.join(canonical, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, lease.roleLeaseKey('worker-supervisor') + '.json'), JSON.stringify({
      pid: ownerPid, workerName: 'worker-supervisor', phase: 'active',
      startTime: '2026-01-01T00:00:00.000Z',
      legacyEndpointless: true,
    }), 'utf8');

    const result = lease.acquireResidentLease({
      workspace: tmp, role: 'worker-supervisor', handoff: true,
      deadlineMs: 50, env: { GH_MAESTRO_WORKER: 'orchestrator' },
    });
    assert.equal(result.acquired, true);
    assert.deepEqual(kills, []);
    assert.equal(lease.createResidentLeaseStore(tmp).read(lease.roleLeaseKey('worker-supervisor')).pid, process.pid);
    result.release();
  } finally {
    cleanupTestTempDir(tmp);
  }
});

test('isResidentLeaseLive: deterministic endpointがdeadならendpointless PR1記録は遺物として扱う', () => {
  const tmp = createTestTempDir();
  try {
    const ownerPid = 424242;
    const store = lease.createResidentLeaseStore(tmp);
    store.write(lease.roleLeaseKey('worker-supervisor'), {
      pid: ownerPid,
      workerName: 'worker-supervisor',
      phase: 'active',
      startTime: '2026-01-01T00:00:00.000Z',
      legacyEndpointless: true,
    });
    installTestLiveness(createTestLiveness({
      probePid: (pid) => pid === ownerPid ? 'unknown' : 'alive',
    }));

    assert.equal(lease.isResidentLeaseLive({ workspace: tmp, role: 'worker-supervisor' }), false);
  } finally {
    cleanupTestTempDir(tmp);
  }
});

test('isResidentLeaseLive: endpoint probeのunknownはPR1記録が残っていてもunknownとして報告する', () => {
  const tmp = createTestTempDir();
  try {
    const store = lease.createResidentLeaseStore(tmp);
    store.write(lease.roleLeaseKey('worker-supervisor'), {
      pid: 424242,
      workerName: 'worker-supervisor',
      phase: 'active',
      startTime: '2026-01-01T00:00:00.000Z',
      legacyEndpointless: true,
    });
    installTestLiveness(createTestLiveness({ probeEndpoint: () => 'unknown' }));

    assert.throws(() => lease.isResidentLeaseLive({ workspace: tmp, role: 'worker-supervisor' }), {
      code: 'LIVENESS_UNKNOWN',
    });
  } finally {
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: --force でも所有者が終了しなければ期限超過で acquired:false（本稼働へ進まない）', () => {
  const tmp = createTestTempDir();
  try {
    const ownerPid = 424242;
    const checker = createTestLiveness({ probePid: () => 'alive' });
    installTestLiveness(checker);
    lease._setKillProcessTree(() => {}); // 止めても ownerAlive は変わらない
    lease._setSleep(() => {});

    const canonical = storageLayout.canonicalWorkspace(tmp);
    writeResidentLease(tmp, checker, 'worker-supervisor', ownerPid, 'timeout-owner-instance');

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
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: GH_MAESTRO_WORKER がワーカー名のときは handoff を拒否し kill しない（Issue #384）', () => {
  const tmp = createTestTempDir();
  try {
    mockLiveness({ alive: true });
    const ownerPid = 424242;
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); });

    const canonical = storageLayout.canonicalWorkspace(tmp);
    writeResidentLease(tmp, activeLiveness, 'worker-supervisor', ownerPid, 'worker-guard-owner');

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
    cleanupTestTempDir(tmp);
  }
});

test('acquireResidentLease: GH_MAESTRO_WORKER が未設定のときは handoff を拒否し kill しない（Issue #384）', () => {
  const tmp = createTestTempDir();
  try {
    mockLiveness({ alive: true });
    const ownerPid = 424242;
    const kills = [];
    lease._setKillProcessTree((pid) => { kills.push(pid); });

    const canonical = storageLayout.canonicalWorkspace(tmp);
    writeResidentLease(tmp, activeLiveness, 'worker-supervisor', ownerPid, 'unset-worker-guard-owner');

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
    cleanupTestTempDir(tmp);
  }
});


test('acquireLeaseLock: 同一性不明の保持者のロックを残して中断する', () => {
  const store = tempStore();
  try {
    installTestLiveness(createTestLiveness({
      probePid: (pid) => pid === process.pid ? 'alive' : 'unknown',
    }));
    const lp = store.lockPath('unknown-holder');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const raw = JSON.stringify({ pid: process.pid + 1 });
    fs.writeFileSync(lp, raw);
    assert.throws(() => lease.acquireLeaseLock(store, 'unknown-holder'), /判定できません/);
    assert.equal(fs.readFileSync(lp, 'utf8'), raw);
  } finally { cleanupStore(store); }
});

test('acquireLease: 不明な所有者のリースを保持し二重起動を拒否する', () => {
  const store = tempStore();
  try {
    const existing = { pid: 4242, startTime: '2026-07-29T00:00:00.000Z' };
    store.write('unknown', existing);
    const unknownWorkerEndpoint = testEndpointPath({
      workspace: store.workspace,
      kind: 'worker',
      name: 'unknown',
    });
    const checker = createTestLiveness({
      probePid: () => 'alive',
      probeEndpoint: (endpoint) => endpoint === unknownWorkerEndpoint ? 'unknown' : 'alive',
    });
    installTestLiveness(checker);
    assert.throws(() => lease.acquireLease(store, 'unknown', {
      processRef: checker.captureProcess(process.pid, 'launcher', 'test-instance'), workerName: 'unknown',
    }), { code: 'LIVENESS_UNKNOWN' });
    assert.deepEqual(store.read('unknown'), existing);
  } finally { installTestLiveness(null); cleanupStore(store); }
});

test('acquireLease: 破損したリースを保持し二重起動を拒否する', () => {
  const store = tempStore();
  try {
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'broken.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'not-json');
    assert.throws(() => lease.acquireLease(store, 'broken', {
      processRef: testProcessRef(process.pid, '2026-07-29T00:00:00.000Z'), workerName: 'broken',
    }), /破損/);
    assert.equal(fs.readFileSync(fp, 'utf8'), 'not-json');
  } finally { cleanupStore(store); }
});

test('acquireLease: EEXIST 後に不明な lease が現れても削除しない', () => {
  const store = tempStore();
  try {
    const existing = { pid: 4242, startTime: '2026-07-29T00:00:00.000Z' };
    let workerEndpointState = 'dead';
    const unknownWorkerEndpoint = testEndpointPath({
      workspace: store.workspace,
      kind: 'worker',
      name: 'race',
    });
    const checker = createTestLiveness({
      probePid: () => 'alive',
      probeEndpoint: (endpoint) => endpoint === unknownWorkerEndpoint ? workerEndpointState : 'alive',
    });
    installTestLiveness(checker);
    const processRef = checker.captureProcess(process.pid, 'launcher', 'test-instance');
    const write = store.write.bind(store);
    let first = true;
    store.write = (key, value) => {
      if (first) {
        first = false;
        write(key, existing);
        workerEndpointState = 'unknown';
        const error = new Error('already exists');
        error.code = 'EEXIST';
        throw error;
      }
      return write(key, value);
    };
    assert.throws(() => lease.acquireLease(store, 'race', {
      processRef, workerName: 'race',
    }), { code: 'LIVENESS_UNKNOWN' });
    assert.deepEqual(store.read('race'), existing);
  } finally { installTestLiveness(null); cleanupStore(store); }
});
