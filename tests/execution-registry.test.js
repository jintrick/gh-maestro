'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../scripts/shared/execution-registry');

function withWorkspace(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-execution-'));
  try { return fn(workspace); } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}

test('コメントURLが記録された実行だけが completed になる', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'exec-1', issue: 142, workerName: 'worker', skill: 'gh-maestro-architect' });
    const completed = registry.markCommentResult(workspace, 'exec-1', { commentUrl: 'https://github.com/o/r/issues/142#issuecomment-1' });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.issue, 142);
    assert.ok(completed.commentUrl.includes('issuecomment'));
  });
});

test('投稿失敗とプロセス異常終了は completed と区別する', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'comment-failed', issue: 142, workerName: 'worker-a', skill: 'gh-maestro-architect' });
    assert.equal(registry.markCommentResult(workspace, 'comment-failed', { error: 'rate limited' }).status, 'comment_failed');
    registry.startExecution(workspace, { executionId: 'process-failed', issue: 142, workerName: 'worker-b', skill: 'gh-maestro-architect' });
    const failed = registry.markProcessExit(workspace, 'process-failed', 7);
    assert.equal(failed.status, 'process_failed');
    assert.equal(failed.exitCode, 7);
  });
});

test('起動失敗はプロセス異常終了と区別する', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'launch-failed', issue: 142, workerName: 'worker', skill: 'gh-maestro-architect' });
    const failed = registry.markLaunchFailure(workspace, 'launch-failed', 'pane split failed');
    assert.equal(failed.status, 'launch_failed');
    assert.equal(failed.error, 'pane split failed');
  });
});

test('完了済み実行を再起動しても completed とコメントURLを保持する', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'exec-1', issue: 142, workerName: 'worker', skill: 'gh-maestro-architect' });
    registry.markCommentResult(workspace, 'exec-1', { commentUrl: 'https://example.test/comment/1' });
    const retried = registry.startExecution(workspace, { executionId: 'exec-1', issue: 142, workerName: 'worker', skill: 'gh-maestro-architect' });
    assert.equal(retried.status, 'completed');
    assert.equal(retried.commentUrl, 'https://example.test/comment/1');
  });
});
