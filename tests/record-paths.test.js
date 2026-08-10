'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARTIFACTS, recordPath, legacyWorkerOwner, legacyWorkerLogPath,
} = require('../scripts/shared/record-paths');

test('recordPath resolves distinct issue/pr/job owners without collisions', () => {
  assert.match(recordPath('C:/workspace', {
    ownerKind: 'issue', ownerId: 7, artifact: ARTIFACTS.WORKER_LOG,
    workerName: 'issue-7-coder-fix',
  }), /records[\\/]issue[\\/]7[\\/]workers[\\/]issue-7-coder-fix[\\/]worker\.log$/);
  assert.match(recordPath('C:/workspace', {
    ownerKind: 'pr', ownerId: 7, artifact: ARTIFACTS.REVIEW_MANAGER_JSON,
  }), /records[\\/]pr[\\/]7[\\/]review[\\/]manager\.json$/);
  assert.match(recordPath('C:/workspace', {
    ownerKind: 'job', ownerId: 'job-1', artifact: ARTIFACTS.WORKER_LOG,
    workerName: 'review-job-job-1',
  }), /records[\\/]job[\\/]job-1[\\/]workers[\\/]review-job-job-1[\\/]worker\.log$/);
});

test('recordPath rejects invalid owners and incompatible artifacts', () => {
  assert.throws(() => recordPath('C:/workspace', {
    ownerKind: 'issue', ownerId: '../7', artifact: ARTIFACTS.ASSISTANT_WATCH,
  }));
  assert.throws(() => recordPath('C:/workspace', {
    ownerKind: 'issue', ownerId: 7, artifact: ARTIFACTS.REVIEW_MANAGER_JSON,
  }));
  assert.throws(() => recordPath('C:/workspace', {
    ownerKind: 'issue', ownerId: 7, artifact: ARTIFACTS.WORKER_LOG,
    workerName: '../escape',
  }));
});

test('legacy worker adapter is strict and preserves explicit ownership', () => {
  assert.deepEqual(legacyWorkerOwner('issue-12-coder-fix'), {
    ownerKind: 'issue', ownerId: '12', workerName: 'issue-12-coder-fix',
  });
  assert.deepEqual(legacyWorkerOwner('issue-12-review-manager-pr-42'), {
    ownerKind: 'pr', ownerId: '42', workerName: 'issue-12-review-manager-pr-42',
  });
  assert.deepEqual(legacyWorkerOwner('review-job-job-1'), {
    ownerKind: 'job', ownerId: 'job-1', workerName: 'review-job-job-1',
  });
  assert.throws(() => legacyWorkerOwner('ambiguous-worker'));
  assert.match(legacyWorkerLogPath('C:/workspace', 'review-job-job-1'), /records[\\/]job[\\/]job-1/);
});
