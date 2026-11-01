'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  beginReviewManagerGeneration,
  recordReviewManagerResult,
  readReviewManagerGeneration,
  inspectReviewManagerResult,
} = require('../scripts/shared/review-manager-generation');
const { reviewArtifactPath } = require('../scripts/shared/review-manager-paths');

function withTempDir(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-rm-generation-'));
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('新しいReview Manager世代は旧成果物の状態をrunningに置き換え、結果記録を更新する', () => {
  withTempDir((workspace) => {
    const previous = { version: 1, startTime: '2026-08-01T10:00:00.000Z', state: 'complete' };
    const currentStart = '2026-08-02T10:00:00.000Z';
    const file = reviewArtifactPath(workspace, '42', '.generation.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(previous), 'utf8');

    assert.deepEqual(beginReviewManagerGeneration(workspace, '42', currentStart), {
      version: 1, startTime: currentStart, state: 'running',
    });
    assert.deepEqual(recordReviewManagerResult(workspace, '42', currentStart, 'complete'), {
      version: 1, startTime: currentStart, state: 'complete',
    });
    assert.deepEqual(readReviewManagerGeneration(workspace, '42'), {
      version: 1, startTime: currentStart, state: 'complete',
    });
  });
});

test('破損したReview Manager世代記録は新規起動で上書きせずエラーにする', () => {
  withTempDir((workspace) => {
    const file = reviewArtifactPath(workspace, '42', '.generation.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken generation', 'utf8');

    assert.throws(() => beginReviewManagerGeneration(workspace, '42', '2026-08-02T10:00:00.000Z'), /世代記録を解析できません/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken generation');
  });
});

test('Review Manager結果は別世代のgeneration記録へ書き込めない', () => {
  withTempDir((workspace) => {
    beginReviewManagerGeneration(workspace, '42', '2026-08-02T10:00:00.000Z');

    assert.throws(
      () => recordReviewManagerResult(workspace, '42', '2026-08-03T10:00:00.000Z', 'complete'),
      /現在のmanager\.runningと一致しません/,
    );
    assert.deepEqual(readReviewManagerGeneration(workspace, '42'), {
      version: 1, startTime: '2026-08-02T10:00:00.000Z', state: 'running',
    });
  });
});

test('共有結果確認は同世代のincompleteとcomplete成果物だけを確定扱いする', () => {
  withTempDir((workspace) => {
    const currentStart = '2026-08-02T10:00:00.000Z';
    beginReviewManagerGeneration(workspace, '42', currentStart);
    assert.deepEqual(inspectReviewManagerResult(workspace, '42', currentStart), {
      status: 'unconfirmed', state: 'running',
    });
    assert.equal(inspectReviewManagerResult(workspace, '42', '2026-08-01T10:00:00.000Z').status, 'unconfirmed');

    recordReviewManagerResult(workspace, '42', currentStart, 'incomplete');
    assert.deepEqual(inspectReviewManagerResult(workspace, '42', currentStart), {
      status: 'confirmed', state: 'incomplete',
    });

    beginReviewManagerGeneration(workspace, '43', currentStart);
    recordReviewManagerResult(workspace, '43', currentStart, 'complete');
    assert.equal(inspectReviewManagerResult(workspace, '43', currentStart).status, 'complete-without-artifact');
    fs.writeFileSync(reviewArtifactPath(workspace, '43', '.json'), '{}', 'utf8');
    assert.deepEqual(inspectReviewManagerResult(workspace, '43', currentStart), {
      status: 'confirmed', state: 'complete',
    });
  });
});
