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

test('listRunningReviewManagers: records/pr が存在しない場合は空配列を返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const res = rrm.listRunningReviewManagers(ws);
    assert.deepEqual(res, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: records/pr が空の場合は空配列を返す', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const prDir = path.join(ws, '.gh-maestro', 'records', 'pr');
    fs.mkdirSync(prDir, { recursive: true });
    const res = rrm.listRunningReviewManagers(ws);
    assert.deepEqual(res, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 稼働中の Review Manager を列挙する', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir42 = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    const reviewDir100 = path.join(ws, '.gh-maestro', 'records', 'pr', '100', 'review');
    fs.mkdirSync(reviewDir42, { recursive: true });
    fs.mkdirSync(reviewDir100, { recursive: true });
    fs.writeFileSync(path.join(reviewDir42, 'manager.running'), '12345\n');
    fs.writeFileSync(path.join(reviewDir100, 'manager.running'), '67890\n');

    rrm._setIsProcessAlive((pid) => pid === 12345 || pid === 67890);
    const res = rrm.listRunningReviewManagers(ws);
    assert.equal(res.length, 2);
    assert.ok(res.some((r) => r.pr === '42' && r.pid === 12345));
    assert.ok(res.some((r) => r.pr === '100' && r.pid === 67890));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 死んでいる PID は除外する', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '12345\n');

    rrm._setIsProcessAlive(() => false);
    const res = rrm.listRunningReviewManagers(ws);
    assert.deepEqual(res, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: manager.running が無い PR (ENOENT) はスキップする', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });

    rrm._setIsProcessAlive(() => true);
    const res = rrm.listRunningReviewManagers(ws);
    assert.deepEqual(res, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: 非PRディレクトリは無視する', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const nonPrDir = path.join(ws, '.gh-maestro', 'records', 'pr', 'temp-dir', 'review');
    fs.mkdirSync(nonPrDir, { recursive: true });
    fs.writeFileSync(path.join(nonPrDir, 'manager.running'), '12345\n');

    rrm._setIsProcessAlive(() => true);
    const res = rrm.listRunningReviewManagers(ws);
    assert.deepEqual(res, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: onError=throw（既定）で PID 不正時は例外を投げる (fail-closed)', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), 'not-a-number');

    assert.throws(() => rrm.listRunningReviewManagers(ws), /manager\.running の PID が不正です/);
    assert.throws(() => rrm.listRunningReviewManagers(ws, { onError: 'throw' }), /manager\.running の PID が不正です/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: onError=skip で PID 不正時はスキップして他を返す (tolerant)', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const badReviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    const goodReviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '43', 'review');
    fs.mkdirSync(badReviewDir, { recursive: true });
    fs.mkdirSync(goodReviewDir, { recursive: true });
    fs.writeFileSync(path.join(badReviewDir, 'manager.running'), 'not-a-number');
    fs.writeFileSync(path.join(goodReviewDir, 'manager.running'), '12345');

    rrm._setIsProcessAlive((pid) => pid === 12345);
    const res = rrm.listRunningReviewManagers(ws, { onError: 'skip' });
    assert.equal(res.length, 1);
    assert.equal(res[0].pr, '43');
    assert.equal(res[0].pid, 12345);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('listRunningReviewManagers: opts.isProcessAliveFn による外部関数注入をサポートする', () => {
  const rrm = fresh();
  const ws = tmpWorkspace();
  try {
    const reviewDir = path.join(ws, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '999');

    let checkedPid = null;
    const res = rrm.listRunningReviewManagers(ws, {
      isProcessAliveFn: (pid) => {
        checkedPid = pid;
        return true;
      },
    });

    assert.equal(checkedPid, 999);
    assert.equal(res.length, 1);
    assert.equal(res[0].pr, '42');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
