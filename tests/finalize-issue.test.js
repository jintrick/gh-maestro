'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectWorkersForIssue, finalizeIssue, cleanupIssueArtifacts, bodyReferencesIssue } = require('../scripts/finalize-issue.js');

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
        findReviewPrsFn: () => [],
      }
    );
    assert.deepEqual(removed.sort(), ['issue-5-coder', 'issue-5-explore']);
    assert.deepEqual(closedIssue, { issue: 5, repo: 'o/r' });
    assert.equal(result.removedCount, 2);
    assert.equal(result.closed, true);
  });
});

test('finalizeIssue: 実物のremove-workerへworkerNameを位置引数で渡し、削除が成功する', () => {
  withTempWorkspace({
    'issue-5-coder': { issue: 5, skill: 'gh-maestro-coder' },
  }, (dir) => {
    // defaultRemoveWorker は子プロセスへ --workspace を渡す。明示引数が優先される
    // ことを固定しつつ、子プロセスが引数を省略する経路にも実workspaceを継承させない。
    const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
    delete process.env.GH_MAESTRO_WORKSPACE;
    try {
      const result = finalizeIssue(
        { workspace: dir, issue: 5 },
        {
          // removeWorkerFn を注入しないことで、実物の defaultRemoveWorker と
          // finalize-issue.js → remove-worker.js の引数境界を通す。
          closeIssueFn: () => ({ ok: true }),
          killAssistantFn: () => ({ ok: true }),
          findReviewPrsFn: () => [],
        }
      );
      assert.deepEqual(result.workers, [{ name: 'issue-5-coder', ok: true }]);
      assert.equal(result.removedCount, 1);
      assert.equal(result.closed, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'))['issue-5-coder'], undefined);
    } finally {
      if (savedWorkspace === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
      else process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    }
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
        findReviewPrsFn: () => [],
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
      { closeIssueFn: () => { closed = true; return { ok: true }; }, findReviewPrsFn: () => [] }
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
        findReviewPrsFn: () => [],
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
        findReviewPrsFn: () => [],
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
        findReviewPrsFn: () => [],
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
        findReviewPrsFn: () => [],
      }
    );
    assert.equal(result.assistantKilled, false);
    assert.equal(result.closed, true);
  });
});

// ── Issue #248: cleanupIssueArtifacts（項目2/4/7） ─────────────────────────

test('cleanupIssueArtifacts: 対象issueの assistant-watch/<N>.json を削除する（項目2）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const watchDir = path.join(dir, '.gh-maestro', 'records', 'issue');
    fs.mkdirSync(path.join(watchDir, '42'), { recursive: true });
    fs.mkdirSync(path.join(watchDir, '99'), { recursive: true });
    fs.writeFileSync(path.join(watchDir, '42', 'assistant-watch.json'), '{}');
    fs.writeFileSync(path.join(watchDir, '99', 'assistant-watch.json'), '{}');
    const result = cleanupIssueArtifacts(dir, 42, { findReviewPrsFn: () => [] });
    assert.equal(result.watchRemoved, true);
    assert.ok(!fs.existsSync(path.join(watchDir, '42', 'assistant-watch.json')));
    assert.ok(fs.existsSync(path.join(watchDir, '99', 'assistant-watch.json')), '他のissueのwatchファイルは残す');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupIssueArtifacts: 対象PRの review-manager-<PR>.incomplete を削除し、無関係PRは残す（項目4）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const ghDir = path.join(dir, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'records', 'pr', '123', 'review'), { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'records', 'pr', '999', 'review'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.incomplete'), 'done');
    fs.writeFileSync(path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.incomplete'), 'done');
    const result = cleanupIssueArtifacts(dir, 7, { findReviewPrsFn: () => [123] });
    assert.deepEqual(result.incompleteRemoved, [123]);
    assert.ok(!fs.existsSync(path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.incomplete')));
    assert.ok(fs.existsSync(path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.incomplete')), '無関係PRのセンチネルは残す');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupIssueArtifacts: executions.json の対象issueレコードだけを間引き、ファイル自体は残す（項目7）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const { startExecution, readRegistry } = require('../scripts/shared/execution-registry');
    startExecution(dir, { executionId: 'issue-7-a', issue: 7, workerName: 'w-a', skill: 'gh-maestro-coder' });
    startExecution(dir, { executionId: 'issue-9', issue: 9, workerName: 'w-b', skill: 'gh-maestro-coder' });
    const result = cleanupIssueArtifacts(dir, 7, { findReviewPrsFn: () => [] });
    assert.equal(result.executionsPruned, 1);
    const after = readRegistry(dir);
    assert.ok(!('issue-7-a' in after));
    assert.ok('issue-9' in after);
    assert.ok(fs.existsSync(path.join(dir, '.gh-maestro', 'executions.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupIssueArtifacts: findReviewPrsFnが例外を投げても他項目は続行する（best-effort）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const watchDir = path.join(dir, '.gh-maestro', 'records', 'issue', '5');
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(path.join(watchDir, 'assistant-watch.json'), '{}');
    const result = cleanupIssueArtifacts(dir, 5, { findReviewPrsFn: () => { throw new Error('gh down'); } });
    assert.equal(result.watchRemoved, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Issue #248レビュー指摘1: PR本文の #<issue> 厳密一致（前方一致を許さない） ──

test('bodyReferencesIssue: 正確な "#<issue>" 参照を検出する', () => {
  assert.equal(bodyReferencesIssue('Closes #1', 1), true);
  assert.equal(bodyReferencesIssue('Fixes #1\nSee body', 1), true);
  assert.equal(bodyReferencesIssue('ref #42.', 42), true);
  // 直後に数字以外が続くものは「別の番号の一部」ではないため参照として検出する（単語境界ルール）
  assert.equal(bodyReferencesIssue('see #1x (not an issue ref)', 1), true);
});

test('bodyReferencesIssue: "#<issue>" の直後に数字が続く前方一致は誤検出しない', () => {
  // Issue #1 の finalize 時に #12・#123 を参照するPRを誤って拾わない
  assert.equal(bodyReferencesIssue('Closes #12', 1), false);
  assert.equal(bodyReferencesIssue('related #123', 1), false);
  assert.equal(bodyReferencesIssue('Closes #123', 12), false);
});

test('bodyReferencesIssue: 本文が文字列でなければfalse', () => {
  assert.equal(bodyReferencesIssue(null, 1), false);
  assert.equal(bodyReferencesIssue(undefined, 1), false);
  assert.equal(bodyReferencesIssue(123, 1), false);
});
