'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RRM = require.resolve('../scripts/shared/running-review-managers');
const { createLiveness } = require('../scripts/shared/process-liveness');
const live = (readStartTime = () => '2026-08-28T00:00:00.000Z') => createLiveness({ probePid: () => 'alive', readStartTime });
const dead = () => createLiveness({ probePid: () => 'dead', readStartTime: () => '2026-08-28T00:00:00.000Z' });

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

function writeRecord(ws, pr, pid, startTime = '2026-08-28T00:00:00.000Z', issue = 174) {
  const file = runningPath(ws, pr);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    pid,
    resourceKey: `review-manager-${pr}`,
    instanceId: `review-manager-${pr}-instance`,
    startTime,
    issue,
  }), 'utf8');
  return file;
}

test('listRunningReviewManagers: records/pr が存在しない・空の場合は空配列を返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    assert.deepEqual(rrm.listRunningReviewManagers(ws), []);
    // records/pr が存在するが空のディレクトリの場合も空配列（統合元の検査）
    fs.mkdirSync(path.join(ws, '.gh-maestro', 'records', 'pr'), { recursive: true });
    assert.deepEqual(rrm.listRunningReviewManagers(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 生存する Review Manager の pr・pid・startTime を返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    writeRecord(ws, 42, 12345, '2026-08-28T00:00:00.000Z');
    writeRecord(ws, 100, 67890, '2026-08-28T00:01:00.000Z');

    rrm._setLiveness(live(pid => pid === 12345 ? '2026-08-28T00:00:00.000Z' : '2026-08-28T00:01:00.000Z'));
    const res = rrm.listRunningReviewManagers(ws);
    assert.equal(res.length, 2);
    assert.ok(res.some((r) => r.pr === '42' && r.pid === 12345 && r.startTime === '2026-08-28T00:00:00.000Z' && r.issue === 174));
    assert.ok(res.some((r) => r.pr === '100' && r.pid === 67890 && r.startTime === '2026-08-28T00:01:00.000Z' && r.issue === 174));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: resourceが死亡していれば列挙しない', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345);
    rrm._setLiveness(createLiveness({ probeEndpoint: () => 'dead' }));
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
    const file = writeRecord(ws, 42, 12345, '2026-08-28T00:00:00.000Z', 715);
    rrm._setLiveness(dead());
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { cleanupStale: true }), []);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 旧 PID-only は持ち主のいない stale として回収する', () => {
  const rrm = fresh(); const ws = tmpWorkspace();
  try {
    const file = runningPath(ws, 42);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${process.pid}\n`);
    rrm._setLiveness(live());
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { cleanupStale: true }), []);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('listRunningReviewManagers: resourceの照会結果がunknownなら保持してskipできる', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345);
    rrm._setLiveness(createLiveness({ probeEndpoint: () => 'unknown' }));
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { onError: 'skip' }), []);
    assert.ok(fs.existsSync(file));
    assert.throws(
      () => rrm.listRunningReviewManagers(ws),
      /manager\.running の生死を判定できません/
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
    rrm._setLiveness(createLiveness({ probeEndpoint: () => {
      fs.writeFileSync(file, JSON.stringify({ pid: 67890, resourceKey: 'replacement-manager' }), 'utf8');
      return 'dead';
    } }));
    assert.deepEqual(rrm.listRunningReviewManagers(ws, { cleanupStale: true, onError: 'skip' }), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      pid: 67890,
      resourceKey: 'replacement-manager',
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
    fs.writeFileSync(goodFile, JSON.stringify({
      pid: 12345,
      resourceKey: 'review-manager-good',
      instanceId: 'review-manager-good-instance',
      startTime: '2026-08-28T00:00:00.000Z',
      issue: 9,
    }), 'utf8');
    rrm._setLiveness(live());

    assert.throws(() => rrm.listRunningReviewManagers(ws), /manager\.running の PID が不正/);
    const res = rrm.listRunningReviewManagers(ws, { onError: 'skip' });
    assert.deepEqual(res, [{ pr: '43', pid: 12345, startTime: '2026-08-28T00:00:00.000Z', issue: 9 }]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writeRunningReviewManager: PID＋起動時刻JSONを原子的に書く', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = runningPath(ws, 42);
    const checker = live();
    rrm._setLiveness(checker);
    const ref = checker.captureProcess(12345, 'review-manager-write-owner');
    rrm.writeRunningReviewManager(file, {
      processRef: ref,
      startTime: '2026-08-28T00:00:00.000Z',
      issue: 715,
    });
    // 期待値は writeRef の出力ではなく、書かれるべき値をリテラルで検証する。
    // resourceKey はテスト用アダプタが導出する64桁の16進数で、その形式だけを見る。
    // instanceId は実行ごとに生成されるため、存在と型だけを見る。
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.pid, 12345);
    assert.equal(written.startTime, '2026-08-28T00:00:00.000Z');
    assert.equal(written.issue, 715);
    assert.match(written.resourceKey, /^[a-f0-9]{64}$/);
    assert.equal(typeof written.instanceId, 'string');
    assert.ok(written.instanceId.length > 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('旧manager.runningレコードはアンカーIssueなしとして読み取り、停止判定にもissue:nullを返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = runningPath(ws, 42);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacyJson = JSON.stringify({
      pid: 12345,
      resourceKey: 'legacy-review-manager-resource',
      instanceId: 'legacy-review-manager-instance',
      startTime: '2026-08-28T00:00:00.000Z',
    });
    fs.writeFileSync(file, legacyJson, 'utf8');

    const parsed = rrm.parseRunningReviewManagerRecord(legacyJson, file);
    assert.equal(parsed.issue, null);
    rrm._setLiveness(live());
    assert.deepEqual(rrm.listRunningReviewManagers(ws), [{
      pr: '42', pid: 12345, startTime: '2026-08-28T00:00:00.000Z', issue: null,
    }]);
    rrm._setLiveness(dead());
    const inspected = rrm.inspectRunningReviewManager(file, { pr: 42, cleanupStale: false });
    assert.equal(inspected.status, 'stale');
    assert.equal(inspected.issue, null);

    const oldPidOnly = rrm.parseRunningReviewManagerRecord('12345\n', file);
    assert.equal(oldPidOnly.issue, null);
    assert.equal(oldPidOnly.startTime, null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manager.runningのアンカーIssueが不正なら黙って旧形式へ縮退しない', () => {
  const rrm = fresh();
  assert.throws(() => rrm.parseRunningReviewManagerRecord(JSON.stringify({ pid: 12345, issue: '715x' })), /アンカーIssueが不正/);
});

test('removeRunningReviewManagerIfOwned: 別所有者のファイルは削除しない', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const file = writeRecord(ws, 42, 12345, '2026-08-28T00:00:00.000Z');
    const checker = live();
    rrm._setLiveness(checker);
    const result = rrm.removeRunningReviewManagerIfOwned(file, checker.captureProcess(67890, 'other-review-manager'));
    assert.equal(result.released, false);
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
