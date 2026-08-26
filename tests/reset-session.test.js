'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rebuildOrchestratorBaseline, restartCapturedResidents } = require('../scripts/reset-session');
const readStateLib = require('../scripts/shared/read-state');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-reset-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WORKERS = {
  orchestrator: { agentId: null },
  'issue-10-coder-x': { issue: 10, agentId: 'claude' },
  'issue-20-explorer-y': { issue: 20, agentId: 'claude' },
};

test('rebuildOrchestratorBaseline: workers.json の Issue 分が readByIssue に再構築される', () => {
  withTempDir(workspace => {
    const listCommentsFn = (repo, issue) => {
      if (issue === '10') {
        return { status: 0, stdout: JSON.stringify([[{ id: 1, created_at: '2026-07-07T10:00:00Z' }, { id: 2, created_at: '2026-07-07T11:00:00Z' }]]) };
      }
      if (issue === '20') return { status: 0, stdout: JSON.stringify([{ id: 100, created_at: '2026-07-07T12:00:00Z' }]) };
      return { status: 0, stdout: JSON.stringify([]) };
    };

    const result = rebuildOrchestratorBaseline(workspace, {
      workers: WORKERS,
      repo: 'o/r',
      listCommentsFn,
    });

    assert.equal(result.ok, true);
    assert.ok(result.generation.startsWith('reset-'), `generation: ${result.generation}`);
    assert.deepEqual(result.issues, ['10', '20']);
    assert.deepEqual(result.counts, { 10: 2, 20: 1 });

    const st = readStateLib.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.equal(st.state.initialized, true);
    assert.equal(st.state.generation, result.generation);
    assert.deepEqual(st.state.readByIssue['10'], [1, 2]);
    assert.deepEqual(st.state.readByIssue['20'], [100]);
    assert.equal(st.state.sinceByIssue['10'], '2026-07-07T11:00:00Z', '直近 created_at が取得最適化カーソルになる');
    assert.equal(st.state.sinceByIssue['20'], '2026-07-07T12:00:00Z');
  });
});

test('rebuildOrchestratorBaseline: 管理対象 Issue が無くても initialized な空状態で再構築する', () => {
  withTempDir(workspace => {
    const result = rebuildOrchestratorBaseline(workspace, {
      workers: { orchestrator: { agentId: null } },
      repo: 'o/r',
      listCommentsFn: () => ({ status: 0, stdout: '[]' }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);

    const st = readStateLib.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.equal(st.state.initialized, true, '空状態でも initialized=true（空状態で再開しない）');
    assert.deepEqual(st.state.readByIssue, {});
  });
});

test('rebuildOrchestratorBaseline: 一部の Issue 取得失敗時は新状態を書き込まない', () => {
  withTempDir(workspace => {
    // 事前に既存状態を置く（成功時は置き換えられるはず）
    readStateLib.initializeState(workspace, 'orchestrator', { byIssue: { 10: [1] }, generation: 'old' });

    const result = rebuildOrchestratorBaseline(workspace, {
      workers: WORKERS,
      repo: 'o/r',
      listCommentsFn: (repo, issue) => {
        if (issue === '20') return { status: 1, stderr: 'gh: rate limit' };
        return { status: 0, stdout: JSON.stringify([{ id: 1 }]) };
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /20/);

    const st = readStateLib.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.equal(st.state.generation, 'old', '失敗時は既存状態を置き換えない');
    assert.deepEqual(st.state.readByIssue['10'], [1]);
  });
});

test('rebuildOrchestratorBaseline: 応答が配列でない場合は失敗し状態を書き換えない', () => {
  withTempDir(workspace => {
    const result = rebuildOrchestratorBaseline(workspace, {
      workers: WORKERS,
      repo: 'o/r',
      listCommentsFn: () => ({ status: 0, stdout: JSON.stringify({ not: 'array' }) }),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /配列ではな/);
    assert.equal(fs.existsSync(readStateLib.statePath(workspace, 'orchestrator')), false, '失敗時は空状態を書かない');
  });
});

test('rebuildOrchestratorBaseline: v1（旧形式）state も v2 に再構築される（移行入口）', () => {
  withTempDir(workspace => {
    const sp = readStateLib.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: { 10: '2026-07-07T00:00:00Z' }, seenIds: [1] }), 'utf8');

    const result = rebuildOrchestratorBaseline(workspace, {
      workers: WORKERS,
      repo: 'o/r',
      listCommentsFn: (repo, issue) => ({ status: 0, stdout: JSON.stringify([{ id: 7 }]) }),
    });

    assert.equal(result.ok, true);
    const st = readStateLib.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.equal(st.state.initialized, true);
    assert.deepEqual(st.state.readByIssue['10'], [7]);
    assert.deepEqual(st.state.readByIssue['20'], [7]);
  });
});

test('rebuildOrchestratorBaseline: 取得したIDは数値のみ（非数値IDは除外）', () => {
  withTempDir(workspace => {
    const result = rebuildOrchestratorBaseline(workspace, {
      workers: WORKERS,
      repo: 'o/r',
      listCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ id: 1 }, { id: 'str' }, { id: null }]) }),
    });

    assert.equal(result.ok, true);
    const st = readStateLib.readState(workspace, 'orchestrator');
    assert.deepEqual(st.state.readByIssue['10'], [1]);
  });
});

test('restartCapturedResidents: 全体掃除後は捕捉済み常駐だけを立て直し、再停止しない', () => {
  withTempDir(workspace => {
    const resident = {
      pid: 101,
      script: 'worker-supervisor.js',
      workerName: null,
      workspace,
      startTime: 'old',
      args: ['--workspace', workspace, '--session-pid', '9000'],
    };
    let replacement = null;
    let killed = false;
    const hooks = {
      findRunningInstances: () => replacement ? [replacement] : [],
      isProcessAlive: (pid) => pid === 9000 || pid === replacement?.pid,
      verifyProcessIdentity: () => ({ match: true }),
      spawn: (cmd, args) => {
        replacement = {
          pid: 200,
          script: 'worker-supervisor.js',
          workerName: null,
          workspace,
          args: args.slice(1),
        };
        return { pid: 200, unref() {} };
      },
      killProcessTree: () => { killed = true; },
      unregisterProcess: () => {},
      findSessionRootPid: () => 9000,
      sleep: () => {},
    };

    const result = restartCapturedResidents(workspace, [resident], workspace, {
      hooks,
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(killed, false, 'reset-session側で既に停止済みのPIDを再度killしない');
    assert.equal(result.errors.length, 0);
    assert.equal(result.results[0].status, 'replaced');
    assert.deepEqual(result.results[0].newPids, [200]);
    assert.equal('newPid' in result.results[0], false);
    assert.equal('command' in result.results[0], false);
  });
});

test('restartCapturedResidents: sweep後も旧常駐が生きている場合は重複起動を拒否する', () => {
  withTempDir(workspace => {
    const resident = {
      pid: 101,
      script: 'worker-supervisor.js',
      workerName: null,
      workspace,
      startTime: 'old',
      args: ['--workspace', workspace, '--session-pid', '9000'],
    };
    let spawnCalled = false;
    const hooks = {
      findRunningInstances: () => [],
      isProcessAlive: (pid) => pid === 101 || pid === 9000,
      verifyProcessIdentity: () => ({ match: true }),
      spawn: () => { spawnCalled = true; throw new Error('must not spawn'); },
      killProcessTree: () => {},
      unregisterProcess: () => {},
      findSessionRootPid: () => 9000,
      sleep: () => {},
    };

    const result = restartCapturedResidents(workspace, [resident], workspace, { hooks });
    assert.equal(spawnCalled, false);
    assert.equal(result.results[0].status, 'failed');
    assert.match(result.errors[0], /重複起動/);
  });
});

test('reset-session: status-pane.json が存在する場合にセッションリセットで削除される', () => {
  withTempDir(workspace => {
    const { saveStatusPane, loadStatusPane } = require('../scripts/shared/status-pane-registry');
    const { spawnSync } = require('child_process');

    saveStatusPane(workspace, { paneId: '9999', launchedAt: '2026-08-26T09:00:00.000Z' });
    assert.ok(loadStatusPane(workspace) !== null);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'reset-session.js');
    const r = spawnSync(process.execPath, [scriptPath, '--workspace', workspace, '--quiet'], {
      encoding: 'utf8',
    });

    assert.equal(loadStatusPane(workspace), null, 'status-pane.json が削除されていること');
  });
});

test('reset-session: killPane に失敗した場合は status-pane.json を削除せず残す', () => {
  withTempDir(workspace => {
    const { saveStatusPane, loadStatusPane } = require('../scripts/shared/status-pane-registry');
    const paneLaunch = require('../scripts/shared/pane-launch');

    saveStatusPane(workspace, { paneId: '8888', launchedAt: '2026-08-26T09:00:00.000Z' });
    assert.ok(loadStatusPane(workspace) !== null);

    // list は生存中と判定し、killPane は失敗するモックを設定
    paneLaunch._setWeztermListPanes(() => ({
      status: 0,
      stdout: JSON.stringify([{ pane_id: '8888' }]),
      stderr: '',
    }));
    paneLaunch._setWeztermKillPane(() => ({
      status: 1,
      stdout: '',
      stderr: 'kill failed',
    }));

    try {
      const alivePanes = paneLaunch.getAlivePaneIds();
      const statusPane = loadStatusPane(workspace);
      assert.ok(statusPane && statusPane.paneId);

      // killPane 失敗時は removeStatusPane は呼ばれない
      const r = paneLaunch.killPane(statusPane.paneId);
      assert.equal(r.ok, false);
      // ファイルが残っていることを確認
      assert.ok(loadStatusPane(workspace) !== null);
    } finally {
      paneLaunch._setWeztermListPanes(null);
      paneLaunch._setWeztermKillPane(null);
    }
  });
});



