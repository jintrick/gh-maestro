'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectWorkersForIssue, finalizeIssue } = require('../scripts/finalize-issue.js');

function withTempWorkspace(workers, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    if (workers !== null) {
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify(workers, null, 2));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('collectWorkersForIssue: 指定Issueのワーカーだけ列挙しorchestratorは除く', () => {
  withTempWorkspace({
    orchestrator: { paneId: '0' },
    'issue-5-coder': { paneId: '1', issue: 5, skill: 'gh-maestro-coder' },
    'issue-5-explore': { paneId: '2', issue: 5, skill: 'gh-maestro-explorer' },
    'issue-9-coder': { paneId: '3', issue: 9, skill: 'gh-maestro-coder' },
  }, (dir) => {
    const names = collectWorkersForIssue(dir, 5).sort();
    assert.deepEqual(names, ['issue-5-coder', 'issue-5-explore']);
  });
});

test('collectWorkersForIssue: issueが数値でも文字列でも一致する', () => {
  withTempWorkspace({
    'issue-7-coder': { paneId: '1', issue: 7 },
  }, (dir) => {
    assert.deepEqual(collectWorkersForIssue(dir, '7'), ['issue-7-coder']);
    assert.deepEqual(collectWorkersForIssue(dir, 7), ['issue-7-coder']);
  });
});

test('collectWorkersForIssue: workers.jsonが無ければ空配列', () => {
  withTempWorkspace(null, (dir) => {
    assert.deepEqual(collectWorkersForIssue(dir, 5), []);
  });
});

test('finalizeIssue: 全ワーカーを削除してからIssueをクローズする（spawnはモック注入）', () => {
  withTempWorkspace({
    orchestrator: { paneId: '0' },
    'issue-5-coder': { paneId: '1', issue: 5 },
    'issue-5-explore': { paneId: '2', issue: 5 },
  }, (dir) => {
    const removed = [];
    let closedIssue = null;
    const result = finalizeIssue(
      { workspace: dir, issue: 5, repo: 'o/r' },
      {
        removeWorkerFn: (ws, name) => { removed.push(name); return { ok: true }; },
        closeIssueFn: (issue, repo, ws) => { closedIssue = { issue, repo }; return { ok: true }; },
      }
    );
    assert.deepEqual(removed.sort(), ['issue-5-coder', 'issue-5-explore']);
    assert.deepEqual(closedIssue, { issue: 5, repo: 'o/r' });
    assert.equal(result.removedCount, 2);
    assert.equal(result.closed, true);
  });
});

test('finalizeIssue: ワーカー削除が一部失敗してもIssueは閉じる（best-effort）', () => {
  withTempWorkspace({
    'issue-5-coder': { paneId: '1', issue: 5 },
    'issue-5-explore': { paneId: '2', issue: 5 },
  }, (dir) => {
    let closed = false;
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      {
        removeWorkerFn: (ws, name) => ({ ok: name !== 'issue-5-explore', stderr: 'boom' }),
        closeIssueFn: () => { closed = true; return { ok: true }; },
      }
    );
    assert.equal(result.removedCount, 1);
    assert.equal(result.closed, true);
    assert.equal(closed, true);
  });
});

test('finalizeIssue: ワーカーが無くてもIssueは閉じる', () => {
  withTempWorkspace({ orchestrator: { paneId: '0' } }, (dir) => {
    let closed = false;
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      { closeIssueFn: () => { closed = true; return { ok: true }; } }
    );
    assert.equal(result.workers.length, 0);
    assert.equal(result.removedCount, 0);
    assert.equal(closed, true);
  });
});

test('finalizeIssue: Issueクローズ失敗は closed:false で返る', () => {
  withTempWorkspace({ 'issue-5-coder': { paneId: '1', issue: 5 } }, (dir) => {
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      {
        removeWorkerFn: () => ({ ok: true }),
        closeIssueFn: () => ({ ok: false, stderr: 'gh error' }),
      }
    );
    assert.equal(result.closed, false);
  });
});

test('finalizeIssue: 既定のkillAssistantFnはassistants.jsonにエントリが無ければskipped扱い（assistantKilled:null）', () => {
  withTempWorkspace({ 'issue-5-coder': { paneId: '1', issue: 5 } }, (dir) => {
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      {
        removeWorkerFn: () => ({ ok: true }),
        closeIssueFn: () => ({ ok: true }),
      }
    );
    assert.equal(result.assistantKilled, null);
    assert.equal(result.closed, true);
  });
});

test('finalizeIssue: killAssistantFnが注入されればそれが呼ばれ、結果がassistantKilledに反映される', () => {
  withTempWorkspace({}, (dir) => {
    let calledWith = null;
    const result = finalizeIssue(
      { workspace: dir, issue: 9 },
      {
        closeIssueFn: () => ({ ok: true }),
        killAssistantFn: (ws, issue) => { calledWith = { ws, issue }; return { ok: true }; },
      }
    );
    assert.deepEqual(calledWith, { ws: dir, issue: 9 });
    assert.equal(result.assistantKilled, true);
  });
});

test('finalizeIssue: assistant終了失敗はassistantKilled:falseだが、closedはissueクローズ結果に従う（best-effort）', () => {
  withTempWorkspace({}, (dir) => {
    const result = finalizeIssue(
      { workspace: dir, issue: 9 },
      {
        closeIssueFn: () => ({ ok: true }),
        killAssistantFn: () => ({ ok: false, stderr: 'kill-pane failed' }),
      }
    );
    assert.equal(result.assistantKilled, false);
    assert.equal(result.closed, true);
  });
});
