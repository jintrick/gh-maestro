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

// ── Issue #248 項目7: pruneExecutionsForIssue ──────────────────────────────

test('pruneExecutionsForIssue: 対象issueのレコードだけ消し、他issueとファイル自体は残す', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'issue-7-a', issue: 7, workerName: 'worker-a', skill: 'gh-maestro-coder' });
    registry.startExecution(workspace, { executionId: 'issue-7-b', issue: 7, workerName: 'worker-b', skill: 'gh-maestro-diagnostician' });
    registry.startExecution(workspace, { executionId: 'issue-9', issue: 9, workerName: 'worker-c', skill: 'gh-maestro-coder' });

    const removed = registry.pruneExecutionsForIssue(workspace, 7);

    assert.equal(removed, 2);
    const after = registry.readRegistry(workspace);
    assert.ok(!('issue-7-a' in after));
    assert.ok(!('issue-7-b' in after));
    assert.ok('issue-9' in after);
    // ファイル自体は残る
    assert.ok(fs.existsSync(registry.registryPath(workspace)));
  });
});

test('pruneExecutionsForIssue: issueが文字列で渡されても数値化して一致する', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'issue-3', issue: 3, workerName: 'worker', skill: 'gh-maestro-coder' });
    const removed = registry.pruneExecutionsForIssue(workspace, '3');
    assert.equal(removed, 1);
    assert.deepEqual(registry.readRegistry(workspace), {});
  });
});

test('pruneExecutionsForIssue: 該当が無ければ0を返し書き込みもしない', () => {
  withWorkspace(workspace => {
    registry.startExecution(workspace, { executionId: 'issue-5', issue: 5, workerName: 'worker', skill: 'gh-maestro-coder' });
    const mtimeBefore = fs.statSync(registry.registryPath(workspace)).mtimeMs;
    const removed = registry.pruneExecutionsForIssue(workspace, 99);
    assert.equal(removed, 0);
    assert.ok('issue-5' in registry.readRegistry(workspace));
    assert.equal(fs.statSync(registry.registryPath(workspace)).mtimeMs, mtimeBefore);
  });
});
