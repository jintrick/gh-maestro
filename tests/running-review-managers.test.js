'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RRM = require.resolve('../scripts/shared/running-review-managers');

function fresh() {
  delete require.cache[RRM];
  return require(RRM);
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-rrm-'));
}

function runningPath(ws, pr) {
  return path.join(ws, '.gh-maestro', 'records', 'pr', String(pr), 'review', 'manager.running');
}

function writeRecord(ws, pr, pid, startTime = '2026-08-28T00:00:00.000Z') {
  const file = runningPath(ws, pr);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, startTime }), 'utf8');
  return file;
}

test('listRunningReviewManagers: records/pr が存在しない場合は空配列を返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    assert.deepEqual(rrm.listRunningReviewManagers(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: records/pr が空の場合は空配列を返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.gh-maestro', 'records', 'pr'), { recursive: true });
    assert.deepEqual(rrm.listRunningReviewManagers(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: PID＋起動時刻が一致する Review Manager だけを列挙する', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    writeRecord(ws, 42, 12345, '2026-08-28T00:00:00.000Z');
    writeRecord(ws, 100, 67890, '2026-08-28T00:01:00.000Z');

    rrm._setIsProcessAlive(() => true);
    rrm._setVerifyProcessIdentity((pid, meta) => ({
      match: (pid === 12345 && meta.startTime === '2026-08-28T00:00:00.000Z')
        || (pid === 67890 && meta.startTime === '2026-08-28T00:01:00.000Z'),
    }));
    const res = rrm.listRunningReviewManagers(ws);
    assert.equal(res.length, 2);
    assert.ok(res.some((r) => r.pr === '42' && r.pid === 12345 && r.startTime === '2026-08-28T00:00:00.000Z'));
    assert.ok(res.some((r) => r.pr === '100' && r.pid === 67890 && r.startTime === '2026-08-28T00:01:00.000Z'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: PIDが生存していても起動時刻不一致なら列挙しない', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345);
    rrm._setIsProcessAlive(() => true);
    rrm._setVerifyProcessIdentity(() => ({
      match: false,
      reason: 'start time mismatch: registered=old, actual=new',
    }));
    assert.deepEqual(rrm.listRunningReviewManagers(ws), []);
    assert.ok(fs.existsSync(file), 'cleanupStale=false の照会ではファイルを残す');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: staleな新形式は内容確認後に回収できる', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345);
    rrm._setIsProcessAlive(() => false);
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { cleanupStale: true }), []);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 旧PID-onlyの死亡ファイルは回収できる', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = runningPath(ws, 42);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '12345\n', 'utf8');
    rrm._setIsProcessAlive(() => false);
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { cleanupStale: true }), []);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 生存中の旧PID-onlyはlive一覧に含めず、保護通知だけ行う', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const legacyFile = runningPath(ws, 42);
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, '12345\n', 'utf8');
    writeRecord(ws, 43, 67890, '2026-08-28T00:01:00.000Z');

    rrm._setIsProcessAlive((pid) => pid === 12345 || pid === 67890);
    rrm._setVerifyProcessIdentity(() => ({ match: true }));
    const protectedPrs = [];
    const res = rrm.listRunningReviewManagers(ws, {
      onLegacyLive: ({ pr }) => protectedPrs.push(pr),
    });
    assert.deepEqual(res, [{ pr: '43', pid: 67890, startTime: '2026-08-28T00:01:00.000Z' }]);
    assert.deepEqual(protectedPrs, ['42']);
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), '12345\n', '生存中の旧形式は削除しない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 起動時刻を取得できない新形式は保持してskipできる', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345);
    rrm._setIsProcessAlive(() => true);
    rrm._setVerifyProcessIdentity(() => ({ match: false, reason: 'cannot get process start time' }));
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { onError: 'skip' }), []);
    assert.ok(fs.existsSync(file));
    assert.throws(
      () => rrm.listRunningReviewManagers(ws),
      /manager\.running の同一性を確認できません/
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: stale判定中に内容が置き換わった場合は新しいファイルを削除しない', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345, '2026-08-28T00:00:00.000Z');
    rrm._setIsProcessAlive(() => true);
    rrm._setVerifyProcessIdentity(() => {
      fs.writeFileSync(file, JSON.stringify({ pid: 67890, startTime: '2026-08-28T00:01:00.000Z' }), 'utf8');
      return { match: false, reason: 'start time mismatch: replaced' };
    });
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { cleanupStale: true, onError: 'skip' }), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      pid: 67890,
      startTime: '2026-08-28T00:01:00.000Z',
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: manager.running の形式不正はthrow/skipを選べる', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const badFile = runningPath(ws, 42);
    const goodFile = runningPath(ws, 43);
    fs.mkdirSync(path.dirname(badFile), { recursive: true });
    fs.mkdirSync(path.dirname(goodFile), { recursive: true });
    fs.writeFileSync(badFile, 'not-a-number', 'utf8');
    fs.writeFileSync(goodFile, JSON.stringify({ pid: 12345, startTime: '2026-08-28T00:00:00.000Z' }), 'utf8');
    rrm._setIsProcessAlive((pid) => pid === 12345);
    rrm._setVerifyProcessIdentity(() => ({ match: true }));

    assert.throws(() => rrm.listRunningReviewManagers(ws), /manager\.running の PID が不正/);
    const res = rrm.listRunningReviewManagers(ws, { onError: 'skip' });
    assert.deepEqual(res, [{ pr: '43', pid: 12345, startTime: '2026-08-28T00:00:00.000Z' }]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writeRunningReviewManager: PID＋起動時刻JSONを原子的に書く', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = runningPath(ws, 42);
    rrm.writeRunningReviewManager(file, { pid: '12345', startTime: '2026-08-28T00:00:00.000Z' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      pid: 12345,
      startTime: '2026-08-28T00:00:00.000Z',
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('removeRunningReviewManagerIfOwned: 別所有者のファイルは削除しない', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345, '2026-08-28T00:00:00.000Z');
    const result = rrm.removeRunningReviewManagerIfOwned(file, {
      pid: 67890,
      startTime: '2026-08-28T00:01:00.000Z',
    });
    assert.equal(result.released, false);
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
