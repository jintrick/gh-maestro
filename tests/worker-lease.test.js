'use strict';

const { test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const lease = require('../scripts/shared/worker-lease');
const processLifecycle = require('../scripts/process-lifecycle');

// 実プロセスには一切触れない（.claude/rules/test-process-spawn-safety.md）
afterEach(() => {
  lease._setIsProcessAlive(processLifecycle.isProcessAlive);
  lease._setVerifyProcessIdentity(processLifecycle.verifyProcessIdentity);
  lease._setGetProcessStartTime(processLifecycle.getProcessStartTime);
});

// ── テスト用ヘルパー ───────────────────────────────────────────────────────────

/**
 * 一時ディレクトリ上に store を作成する。
 * テスト終了時に自動削除するため、各テストで独立した store を使う。
 */
function tempStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-lease-test-'));
  const store = lease.createNormalWorkerStore(tmp);
  // cleanup 用に dir を露出
  store._tmpDir = tmp;
  return store;
}

function cleanupStore(store) {
  if (store._tmpDir) {
    fs.rmSync(store._tmpDir, { recursive: true, force: true });
  }
}

/** liveness 関数を注入する */
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

test('createNormalWorkerStore: read/write/remove の基本操作', () => {
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

    // update で上書き
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
    // 手動で不正なJSONを書き込む
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

test('isLeaseLive: startTimeが無ければPID生存のみで判定（移行前・予約エントリ）', () => {
  const calls = mockLiveness({ alive: true, identityMatch: false });
  // startTime が空文字列
  assert.equal(lease.isLeaseLive({ pid: 4242, startTime: '', workerName: 'w', createdAt: 'x' }), true);
  assert.equal(calls.verify.length, 0, 'startTimeが空なら同一性確認をスキップ');
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

// ── acquireLease ──────────────────────────────────────────────────────────────

test('acquireLease: 既存リースがなければ新規作成に成功する', () => {
  const store = tempStore();
  try {
    mockLiveness();
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
    // 手動で破損JSONを書き込む
    const fp = path.join(store._tmpDir, '.gh-maestro', 'leases', 'issue-1-coder-test.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'corrupt', 'utf8');

    mockLiveness();
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

test('acquireLease: TOCTOU競合（readとwriteの間に別プロセスが作成）→ liveなら拒否', () => {
  const store = tempStore();
  try {
    // 1回目の write で EEXIST を起こし、その後 read で live なエントリが見つかるケース
    let writeAttempt = 0;
    const origWrite = store.write.bind(store);
    store.write = function (key, entry) {
      writeAttempt++;
      if (writeAttempt === 1) {
        // 1回目: EEXIST を発生させる
        origWrite(key, { pid: 9999, startTime: '2026-07-29T00:00:00.000Z', workerName: 'racer', createdAt: '2026-07-29T00:00:00.000Z' });
        const err = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      // 2回目: 成功
      return origWrite(key, entry);
    };

    mockLiveness({ alive: true, identityMatch: true });

    assert.throws(
      () => lease.acquireLease(store, 'issue-1-coder-test', {
        pid: 4242, startTime: null, workerName: 'issue-1-coder-test',
      }),
      /別プロセスによって起動されました/
    );
  } finally {
    cleanupStore(store);
  }
});

test('acquireLease: TOCTOU競合 → 競合エントリがstaleなら回収してリトライ成功', () => {
  const store = tempStore();
  try {
    let writeAttempt = 0;
    const origWrite = store.write.bind(store);
    store.write = function (key, entry) {
      writeAttempt++;
      if (writeAttempt === 1) {
        // 競合エントリを作成（stale — PIDが死んでいる）
        origWrite(key, { pid: 9999, startTime: '2026-07-29T00:00:00.000Z', workerName: 'racer', createdAt: '2026-07-29T00:00:00.000Z' });
        const err = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      return origWrite(key, entry);
    };

    mockLiveness({ alive: false }); // 競合も自分も死んでいる → stale

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

    // 別のPIDで解放を試みる
    lease.releaseLease(store, 'test-key', { pid: 4242 });
    // 元のリースはそのまま
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
    // 予約リース（launcherのPID）
    store.write('test-key', {
      pid: 100, startTime: 'old', workerName: 'w', createdAt: '2026-07-29T00:00:00.000Z',
    });

    lease.activateLease(store, 'test-key', {
      pid: 4242, startTime: '2026-07-29T00:00:01.000Z',
    });

    const entry = store.read('test-key');
    assert.equal(entry.pid, 4242);
    assert.equal(entry.startTime, '2026-07-29T00:00:01.000Z');
    // 他のフィールドは維持
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
    // getProcessStartTime のモックが返す値
    // pid=4242 は4桁なので padStart(3, '0') を通過し、'.4242Z' になる
    assert.equal(entry.startTime, '2026-07-29T00:00:00.4242Z');
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

    // PIDは死んでいる（stale判定）→ 回収される
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
