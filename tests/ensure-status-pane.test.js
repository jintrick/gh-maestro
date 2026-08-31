'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ensureStatusPaneLib = require('../scripts/shared/ensure-status-pane');
const paneLaunch = require('../scripts/shared/pane-launch');

const { ensureStatusPane } = ensureStatusPaneLib;

function withTempWorkspace(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ensure-status-pane-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function baseParams(workspace = 'C:\\workspace') {
  return {
    workspace,
    scriptsPath: 'C:\\gh-maestro\\scripts',
  };
}

function injectedDeps(overrides = {}) {
  const calls = {
    acquire: 0,
    release: 0,
    load: 0,
    alive: 0,
    launch: 0,
    save: 0,
  };
  const deps = {
    acquireLockFn: () => {
      calls.acquire++;
      return true;
    },
    releaseLockFn: () => { calls.release++; },
    loadStatusPaneFn: () => {
      calls.load++;
      return null;
    },
    isPaneAliveFn: () => {
      calls.alive++;
      return false;
    },
    launchInSplitPaneFn: () => {
      calls.launch++;
      return { paneId: '123' };
    },
    saveStatusPaneFn: () => { calls.save++; },
    nowFn: () => 1760000000000,
  };
  return { calls, deps: { ...deps, ...overrides } };
}

test('ensureStatusPane: workspace または scriptsPath が無ければ副作用なしで拒否する', () => {
  const { calls, deps } = injectedDeps();

  const missingWorkspace = ensureStatusPane({ scriptsPath: 'scripts' }, deps);
  assert.deepEqual(missingWorkspace, {
    ok: false,
    stage: 'input',
    error: 'workspace と scriptsPath は必須です',
  });
  const missingScriptsPath = ensureStatusPane({ workspace: 'C:\\workspace' }, deps);
  assert.equal(missingScriptsPath.ok, false);
  assert.equal(missingScriptsPath.stage, 'input');
  assert.deepEqual(calls, { acquire: 0, release: 0, load: 0, alive: 0, launch: 0, save: 0 });
});

test('ensureStatusPane: 生存中の記録済みペインを再利用し起動・保存しない', () => {
  const { calls, deps } = injectedDeps({
    loadStatusPaneFn: () => {
      calls.load++;
      return { paneId: '42', launchedAt: '2026-08-31T00:00:00.000Z' };
    },
    isPaneAliveFn: () => {
      calls.alive++;
      return true;
    },
  });

  const result = ensureStatusPane(baseParams(), deps);

  assert.deepEqual(result, { ok: true, paneId: '42', reused: true });
  assert.equal(calls.acquire, 1);
  assert.equal(calls.release, 1);
  assert.equal(calls.load, 1);
  assert.equal(calls.alive, 1);
  assert.equal(calls.launch, 0);
  assert.equal(calls.save, 0);
});

test('ensureStatusPane: 未記録ペインを起動し status-pane.json の記録を更新する', () => {
  let launchParams = null;
  let saved = null;
  const { calls, deps } = injectedDeps({
    launchInSplitPaneFn: (params) => {
      calls.launch++;
      launchParams = params;
      return { paneId: 77 };
    },
    saveStatusPaneFn: (workspace, entry) => {
      calls.save++;
      saved = { workspace, entry };
    },
  });

  const result = ensureStatusPane({
    ...baseParams(),
    interval: 5,
    direction: 'right',
    percent: 20,
  }, deps);

  assert.deepEqual(result, { ok: true, paneId: '77', reused: false });
  assert.equal(launchParams.cwd, 'C:\\workspace');
  assert.equal(launchParams.direction, 'right');
  assert.equal(launchParams.percent, 20);
  assert.deepEqual(launchParams.argv, [
    process.execPath,
    path.join('C:\\gh-maestro\\scripts', 'worker-status.js'),
    'watch',
    '--workspace',
    'C:\\workspace',
    '--interval',
    '5',
  ]);
  assert.deepEqual(saved, {
    workspace: 'C:\\workspace',
    entry: { paneId: '77', launchedAt: '2025-10-09T08:53:20.000Z' },
  });
  assert.equal(calls.acquire, 1);
  assert.equal(calls.release, 1);
});

test('ensureStatusPane: 死亡した記録済みペインは新規起動して記録を置き換える', () => {
  let launchCalls = 0;
  let savedPaneId = null;
  const { deps } = injectedDeps({
    loadStatusPaneFn: () => ({ paneId: 'old' }),
    isPaneAliveFn: () => false,
    launchInSplitPaneFn: () => {
      launchCalls++;
      return { paneId: 'new' };
    },
    saveStatusPaneFn: (workspace, entry) => { savedPaneId = entry.paneId; },
  });

  const result = ensureStatusPane(baseParams(), deps);

  assert.deepEqual(result, { ok: true, paneId: 'new', reused: false });
  assert.equal(launchCalls, 1);
  assert.equal(savedPaneId, 'new');
});

test('ensureStatusPane: ロックを取得できなければ状態確認・起動・保存を行わない', () => {
  const { calls, deps } = injectedDeps({
    acquireLockFn: () => {
      calls.acquire++;
      return false;
    },
  });

  const result = ensureStatusPane(baseParams(), deps);

  assert.deepEqual(result, {
    ok: false,
    stage: 'lock',
    error: '監視ペインの保証ロックを取得できませんでした',
  });
  assert.deepEqual(calls, { acquire: 1, release: 0, load: 0, alive: 0, launch: 0, save: 0 });
});

test('ensureStatusPane: split-pane失敗は launch の失敗結果になりロックを解放する', () => {
  const { calls, deps } = injectedDeps({
    launchInSplitPaneFn: () => {
      calls.launch++;
      throw new Error('WezTerm not found');
    },
  });

  const result = ensureStatusPane(baseParams(), deps);

  assert.deepEqual(result, { ok: false, stage: 'launch', error: 'WezTerm not found' });
  assert.equal(calls.release, 1);
  assert.equal(calls.save, 0);
});

test('ensureStatusPane: pane一覧取得に失敗した場合は新規起動せず lookup の失敗結果を返す', () => {
  withTempWorkspace((workspace) => {
    paneLaunch._setWeztermListPanes(() => ({ status: 1, stdout: '', stderr: 'wezterm unavailable' }));
    let launchCalled = false;
    try {
      const result = ensureStatusPane({
        workspace,
        scriptsPath: path.join(__dirname, '..', 'scripts'),
      }, {
        acquireLockFn: () => true,
        releaseLockFn: () => {},
        loadStatusPaneFn: () => ({ paneId: 'existing' }),
        launchInSplitPaneFn: () => {
          launchCalled = true;
          return { paneId: 'duplicate' };
        },
        saveStatusPaneFn: () => {},
      });

      assert.deepEqual(result, {
        ok: false,
        stage: 'lookup',
        error: 'WezTermのpane一覧を取得できませんでした',
      });
      assert.equal(launchCalled, false);
    } finally {
      paneLaunch._setWeztermListPanes(null);
    }
  });
});

test('ensureStatusPane: 保存失敗は save の失敗結果になり作成後も成功扱いにしない', () => {
  const { calls, deps } = injectedDeps({
    saveStatusPaneFn: () => {
      calls.save++;
      throw new Error('disk full');
    },
  });

  const result = ensureStatusPane(baseParams(), deps);

  assert.deepEqual(result, { ok: false, stage: 'save', error: 'disk full' });
  assert.equal(calls.launch, 1);
  assert.equal(calls.release, 1);
});

test('ensureStatusPane: 保持中ロックへの再入entrant呼び出しは二重起動せず拒否する', () => {
  let held = false;
  let nestedResult = null;
  let launchCalls = 0;
  const deps = {
    acquireLockFn: () => {
      if (held) return false;
      held = true;
      return true;
    },
    releaseLockFn: () => { held = false; },
    loadStatusPaneFn: () => null,
    isPaneAliveFn: () => false,
    launchInSplitPaneFn: () => {
      launchCalls++;
      nestedResult = ensureStatusPane(baseParams(), deps);
      return { paneId: 'only-one' };
    },
    saveStatusPaneFn: () => {},
  };

  const result = ensureStatusPane(baseParams(), deps);

  assert.deepEqual(result, { ok: true, paneId: 'only-one', reused: false });
  assert.deepEqual(nestedResult, {
    ok: false,
    stage: 'lock',
    error: '監視ペインの保証ロックを取得できませんでした',
  });
  assert.equal(launchCalls, 1);
  assert.equal(held, false);
});

test('ensureStatusPane: 既存startup lockのstale保持者を回収して一度だけ起動する', () => {
  withTempWorkspace((workspace) => {
    const processLifecycle = require('../scripts/process-lifecycle');
    const lockPath = processLifecycle.startupLockPath(
      workspace,
      ensureStatusPaneLib.STATUS_PANE_LOCK_SCRIPT,
      ensureStatusPaneLib.STATUS_PANE_LOCK_WORKER,
    );
    const legacyLockPath = processLifecycle.legacyStartupLockPath(
      workspace,
      ensureStatusPaneLib.STATUS_PANE_LOCK_SCRIPT,
      ensureStatusPaneLib.STATUS_PANE_LOCK_WORKER,
    );
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyLockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: -1, startTime: '2020-01-01T00:00:00.000Z' }));
    fs.writeFileSync(legacyLockPath, JSON.stringify({ pid: -1, startTime: '2020-01-01T00:00:00.000Z' }));

    let launchCalls = 0;
    try {
      const result = ensureStatusPane({
        workspace,
        scriptsPath: path.join(__dirname, '..', 'scripts'),
      }, {
        loadStatusPaneFn: () => null,
        isPaneAliveFn: () => false,
        launchInSplitPaneFn: () => {
          launchCalls++;
          return { paneId: 'stale-reclaimed' };
        },
        saveStatusPaneFn: () => {},
      });

      assert.deepEqual(result, { ok: true, paneId: 'stale-reclaimed', reused: false });
      assert.equal(launchCalls, 1);
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(fs.existsSync(legacyLockPath), false);
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
      try { fs.unlinkSync(legacyLockPath); } catch {}
    }
  });
});

test('ensureStatusPane: 既存 process-lifecycle のstartup lockを専用キーで再利用する', () => {
  withTempWorkspace((workspace) => {
    const processLifecycle = require('../scripts/process-lifecycle');
    const lockPath = processLifecycle.startupLockPath(
      workspace,
      ensureStatusPaneLib.STATUS_PANE_LOCK_SCRIPT,
      ensureStatusPaneLib.STATUS_PANE_LOCK_WORKER,
    );
    let launched = false;

    const result = ensureStatusPane({
      workspace,
      scriptsPath: path.join(__dirname, '..', 'scripts'),
    }, {
      loadStatusPaneFn: () => null,
      isPaneAliveFn: () => false,
      launchInSplitPaneFn: () => {
        launched = true;
        assert.ok(fs.existsSync(lockPath), '起動中は専用startup lockを保持する');
        return { paneId: 'lock-test' };
      },
      saveStatusPaneFn: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(launched, true);
    assert.equal(fs.existsSync(lockPath), false, '完了時にstartup lockを解放する');
  });
});
