'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  RESIDENT_SPECS,
  buildRestartArgs,
  captureResidentEntries,
  formatResidentResult,
  parseSessionPid,
  replaceSessionPid,
  restartResidents,
  restartStatusPane,
  formatStatusPaneResult,
  stopResidentEntry,
} = require('../scripts/shared/restart-residents');
const { main, USAGE, writeResult } = require('../scripts/restart-residents');
const {
  createNormalWorkerStore,
  releaseResidentLeaseForProcess,
  roleLeaseKey,
} = require('../scripts/shared/worker-lease');

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-resident-restart-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

const STATUS_PANE_CONTEXT = Object.freeze({
  unixSocket: 'C:\\wezterm\\test-socket',
  targetPaneId: 'base-pane',
});

function makeHarness(workspace, options = {}) {
  const oldEntries = options.entries || [];
  const entries = oldEntries.map((entry) => ({ ...entry, args: entry.args ? [...entry.args] : entry.args }));
  const live = new Set([...oldEntries.map((entry) => entry.pid), 9000]);
  let nextPid = 2000;
  const spawned = [];
  const unregistered = [];
  const hooks = {
    findRunningInstances: (ws, opts = {}) => entries.filter((entry) => (
      live.has(entry.pid)
      && entry.workspace === ws
      && (!opts.script || entry.script === opts.script)
      && (entry.workerName ?? null) === (opts.workerName ?? null)
    )),
    unregisterProcess: (ws, pid) => {
      unregistered.push(pid);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].workspace === ws && entries[i].pid === pid) entries.splice(i, 1);
      }
    },
    verifyProcessIdentity: (pid) => ({ match: live.has(pid), reason: live.has(pid) ? undefined : 'not alive' }),
    isProcessAlive: (pid) => live.has(pid),
    findSessionRootPid: () => 9000,
    killProcessTree: (pid) => {
      if (options.kill) options.kill(pid, live);
      else live.delete(pid);
    },
    spawn: (cmd, args, spawnOptions) => {
      if (options.spawn) return options.spawn(cmd, args, spawnOptions, { entries, live, spawned });
      const pid = nextPid++;
      const child = new EventEmitter();
      child.pid = pid;
      child.unref = () => {};
      const script = path.basename(args[0]);
      entries.push({
        pid,
        script,
        workerName: null,
        workspace,
        startTime: `new-${pid}`,
        args: args.slice(1),
      });
      live.add(pid);
      spawned.push({ cmd, args, spawnOptions, pid });
      return child;
    },
    sleep: () => {},
  };
  return { hooks, entries, live, spawned, unregistered };
}

function residentEntries(workspace) {
  return [
    {
      pid: 101,
      script: 'worker-supervisor.js',
      workerName: null,
      workspace,
      startTime: 'old-101',
      args: ['--workspace', workspace, '--session-pid', '9000'],
    },
    {
      pid: 102,
      script: 'msg-poll.js',
      workerName: null,
      workspace,
      startTime: 'old-102',
      args: ['orchestrator', '--workspace', workspace, '--session-pid', '9000'],
    },
    {
      pid: 103,
      script: 'poll-pr.js',
      workerName: null,
      workspace,
      startTime: 'old-103',
      args: ['334', '--workspace', workspace, '--base-branch', 'dev', '--session-pid', '9000'],
    },
    {
      pid: 104,
      script: 'poll-reviews.js',
      workerName: null,
      workspace,
      startTime: 'old-104',
      args: ['77', workspace, '30', '--session-pid', '9000'],
    },
  ];
}

test('parseSessionPid/replaceSessionPid: 既存PIDを安全に抽出・置換する', () => {
  const args = ['orchestrator', '--workspace', 'C:\\workspace', '--session-pid', '1234'];
  assert.equal(parseSessionPid(args), 1234);
  assert.deepEqual(replaceSessionPid(args, 5678), [
    'orchestrator', '--workspace', 'C:\\workspace', '--session-pid', '5678',
  ]);
  assert.equal(parseSessionPid(['--session-pid', 'bad']), null);
});

test('buildRestartArgs: msg-pollはrestart CLIの親PIDを使わずregistryのsession-pidを引き継ぐ', () => {
  const workspace = makeWorkspace();
  try {
    const harness = makeHarness(workspace);
    const result = buildRestartArgs(
      { script: 'msg-poll.js', workerName: null },
      residentEntries(workspace)[1],
      workspace,
      harness.hooks,
    );
    assert.equal(result.sessionPid, 9000);
    assert.equal(result.sessionPidSource, 'registry-args');
    assert.deepEqual(result.args.slice(-2), ['--session-pid', '9000']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('captureResidentEntries: session-pidなしでも対象常駐自身の親チェーンから解決する', () => {
  const workspace = makeWorkspace();
  try {
    const entry = { ...residentEntries(workspace)[1], args: ['orchestrator', '--workspace', workspace] };
    const harness = makeHarness(workspace, { entries: [entry] });
    harness.hooks.findSessionRootPid = (pid) => {
      assert.equal(pid, entry.pid, 'restart CLI自身ではなく停止前の常駐PIDを起点にする');
      return 9000;
    };
    const captured = captureResidentEntries(workspace, harness.hooks);
    assert.equal(captured[0].restartSessionPid, 9000);
    assert.equal(captured[0].restartSessionPidSource, 'resident-parent-chain');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildRestartArgs: worker-supervisorの旧引数が無い場合だけ親チェーンをフォールバックに使う', () => {
  const workspace = makeWorkspace();
  try {
    const harness = makeHarness(workspace);
    const result = buildRestartArgs(
      { script: 'worker-supervisor.js', workerName: null },
      { script: 'worker-supervisor.js', args: [] },
      workspace,
      harness.hooks,
    );
    assert.equal(result.sessionPid, 9000);
    assert.equal(result.sessionPidSource, 'restart-cli-parent-chain');
    assert.deepEqual(result.args, ['--workspace', workspace, '--session-pid', '9000']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: inboxだけdetached起動し、Monitor常駐は再接続要求、poll-reviewsは親へ委譲する', () => {
  const workspace = makeWorkspace();
  try {
    const harness = makeHarness(workspace, { entries: residentEntries(workspace) });
    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.results.length, RESIDENT_SPECS.length);
    assert.deepEqual(result.results.map((item) => item.status), [
      'replaced', 'monitor-required', 'monitor-required', 'delegated',
    ]);
    assert.equal(result.results[1].monitorRequired, true);
    assert.equal(result.results[2].monitorRequired, true);
    assert.equal(result.results[1].commands.length, 1);
    assert.equal(result.results[2].commands.length, 1);
    assert.equal(result.results[3].monitorRequired, false);
    assert.equal(result.results[3].monitorScript, 'poll-pr.js');
    assert.equal(harness.spawned.length, 1, 'Monitor常駐はdetached起動せず、inboxだけ起動する');
    assert.ok(harness.spawned.every((item) => path.basename(item.args[0]) === 'worker-supervisor.js'));
    assert.ok(harness.unregistered.includes(101));
    assert.ok(harness.unregistered.includes(104));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: registryが読めない場合はkill/spawnせず全対象をfailedにする', () => {
  const workspace = makeWorkspace();
  try {
    let spawnCalled = false;
    const result = restartResidents(workspace, {
      scriptsPath: workspace,
      hooks: {
        findRunningInstances: () => { throw new Error('registry unreadable'); },
        spawn: () => { spawnCalled = true; throw new Error('must not spawn'); },
      },
    });
    assert.equal(spawnCalled, false);
    assert.equal(result.results.every((item) => item.status === 'failed'), true);
    assert.match(result.errors[0], /registry unreadable/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 停止確認に失敗した場合は再起動せず、残存プロセスを維持する', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(0, 1);
    const harness = makeHarness(workspace, { entries: old, kill: () => {} });
    const result = restartResidents(workspace, {
      scriptsPath: workspace,
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(harness.spawned.length, 0);
    assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].reason, /停止確認/);
    assert.equal(harness.live.has(old[0].pid), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('stopResidentEntry: 停止済み常駐のregistryとworker-supervisorのlegacy leaseを解放確認する', () => {
  const workspace = makeWorkspace();
  const registryPath = path.join(workspace, 'pid-registry.json');
  const legacyRegistryPath = path.join(workspace, 'legacy-pid-registry.json');
  try {
    fs.writeFileSync(registryPath, '{}', 'utf8');
    fs.writeFileSync(legacyRegistryPath, '{}', 'utf8');
    const entry = {
      pid: 4242,
      script: 'worker-supervisor.js',
      workerName: null,
      workspace,
      startTime: '2026-07-29T00:00:00.424Z',
      args: [],
    };
    const releasedRoles = [];
    const hooks = {
      isProcessAlive: () => false,
      unregisterProcess: () => {
        fs.unlinkSync(registryPath);
        fs.unlinkSync(legacyRegistryPath);
      },
      pidFilePath: () => registryPath,
      legacyPidFilePath: () => legacyRegistryPath,
      releaseResidentLeaseForProcess: ({ role, pid, startTime }) => {
        releasedRoles.push({ role, pid, startTime });
        return { released: true, remaining: false };
      },
    };

    const result = stopResidentEntry(workspace, entry, hooks);

    assert.deepEqual(result, { ok: true });
    assert.equal(fs.existsSync(registryPath), false);
    assert.equal(fs.existsSync(legacyRegistryPath), false);
    assert.deepEqual(releasedRoles, [
      { role: 'worker-supervisor', pid: 4242, startTime: entry.startTime },
      { role: 'inbox-supervisor', pid: 4242, startTime: entry.startTime },
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 無関係なstale resident leaseがあってもteardownを中断しない', () => {
  const workspace = makeWorkspace();
  const leaseStore = createNormalWorkerStore(workspace);
  const role = 'worker-supervisor';
  try {
    leaseStore.write(roleLeaseKey(role), {
      pid: 999999,
      startTime: '2026-07-29T00:00:00.999Z',
      workerName: role,
      phase: 'active',
    });
    const old = residentEntries(workspace).slice(0, 1);
    const harness = makeHarness(workspace, { entries: old });
    harness.hooks.releaseResidentLeaseForProcess = releaseResidentLeaseForProcess;

    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.results[0].status, 'replaced');
    assert.deepEqual(result.results[0].newPids, [2000]);
    assert.deepEqual(leaseStore.read(roleLeaseKey(role)), {
      pid: 999999,
      startTime: '2026-07-29T00:00:00.999Z',
      workerName: role,
      phase: 'active',
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: session-pidも親チェーンも解決できないMonitor常駐は停止せず失敗する', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(1, 2).map((entry) => ({ ...entry, args: ['orchestrator', '--workspace', workspace] }));
    const harness = makeHarness(workspace, { entries: old });
    harness.hooks.findSessionRootPid = () => null;
    const result = restartResidents(workspace, {
      scriptsPath: workspace,
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(harness.spawned.length, 0);
    assert.equal(result.results[1].status, 'failed');
    assert.match(result.results[1].reason, /Monitorから起動/);
    assert.equal(harness.live.has(old[0].pid), true, '再起動不能な対象は停止しない');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 同一スクリプトの複数poll-prを停止数と同じ件数でMonitor再接続要求する', () => {
  const workspace = makeWorkspace();
  try {
    const entries = [0, 1].map((index) => ({
      ...residentEntries(workspace)[2],
      pid: 103 + index * 10,
      args: [String(334 + index), '--workspace', workspace, '--session-pid', '9000'],
    }));
    const harness = makeHarness(workspace, { entries });
    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.results[2].status, 'monitor-required');
    assert.equal(result.results[2].oldPids.length, 2);
    assert.equal(result.results[2].commands.length, 2);
    assert.equal('command' in result.results[2], false);
    assert.deepEqual(harness.unregistered.sort((a, b) => a - b), [103, 113]);
    assert.equal(harness.spawned.length, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 同一worker-supervisor複数件も停止数と同じ件数をdetached起動する', () => {
  const workspace = makeWorkspace();
  try {
    const entries = [0, 1].map((index) => ({
      ...residentEntries(workspace)[0],
      pid: 101 + index * 10,
      args: ['--workspace', workspace, '--session-pid', '9000'],
    }));
    const harness = makeHarness(workspace, { entries });
    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.results[0].status, 'replaced');
    assert.deepEqual(result.results[0].newPids, [2000, 2001]);
    assert.equal('newPid' in result.results[0], false);
    assert.equal('command' in result.results[0], false);
    assert.equal(harness.spawned.length, 2);
    assert.equal(harness.unregistered.length, 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: detached起動直後にregistry登録が遅れても成功をfailedと報告しない', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(0, 1);
    const harness = makeHarness(workspace, {
      entries: old,
      spawn: (cmd, args, spawnOptions, state) => {
        const child = new EventEmitter();
        child.pid = 2000;
        child.unref = () => {};
        state.spawned.push({ cmd, args, spawnOptions, pid: child.pid });
        return child;
      },
    });
    const originalFind = harness.hooks.findRunningInstances;
    let lookupCount = 0;
    harness.hooks.findRunningInstances = (...args) => {
      lookupCount += 1;
      if (lookupCount === 3) {
        harness.entries.push({
          ...old[0],
          pid: 2000,
          startTime: 'new-2000',
        });
        harness.live.add(2000);
      }
      return originalFind(...args);
    };

    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.results[0].status, 'replaced');
    assert.deepEqual(result.results[0].newPids, [2000]);
    assert.equal('newPid' in result.results[0], false);
    assert.equal('command' in result.results[0], false);
    assert.equal(lookupCount, 3);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 子プロセスがregistry登録前に終了した場合は終了診断を残して失敗する', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(0, 1);
    const harness = makeHarness(workspace, {
      entries: old,
      spawn: (cmd, args, spawnOptions, state) => {
        const child = new EventEmitter();
        child.pid = 2000;
        child.unref = () => {};
        state.spawned.push({ cmd, args, spawnOptions, pid: child.pid });
        return child;
      },
    });
    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });

    assert.equal(result.errors.length, 1);
    assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].reason, /起動PID 2000 はregistry登録を確認する前に終了しました/);
    assert.match(result.results[0].reason, /起動ログ: .+resident-restart-logs/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 子プロセスが生存したままregistry登録されない場合は遅延診断を残して失敗する', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(0, 1);
    const harness = makeHarness(workspace, {
      entries: old,
      spawn: (cmd, args, spawnOptions, state) => {
        const child = new EventEmitter();
        child.pid = 2000;
        child.unref = () => {};
        state.live.add(child.pid);
        state.spawned.push({ cmd, args, spawnOptions, pid: child.pid });
        return child;
      },
    });
    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 2,
      waitMs: 0,
    });

    assert.equal(result.errors.length, 1);
    assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].reason, /起動PID 2000 は生存していますが/);
    assert.match(result.results[0].reason, /登録遅延またはregistry可視化遅延/);
    assert.match(result.results[0].reason, /起動ログ: .+resident-restart-logs/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartResidents: 起動PIDの生存確認に失敗した場合は判定不能として失敗する', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(0, 1);
    const harness = makeHarness(workspace, {
      entries: old,
      spawn: (cmd, args, spawnOptions, state) => {
        const child = new EventEmitter();
        child.pid = 2000;
        child.unref = () => {};
        state.spawned.push({ cmd, args, spawnOptions, pid: child.pid });
        return child;
      },
    });
    const originalIsProcessAlive = harness.hooks.isProcessAlive;
    harness.hooks.isProcessAlive = (pid) => {
      if (pid === 2000) throw new Error('liveness unavailable');
      return originalIsProcessAlive(pid);
    };
    const result = restartResidents(workspace, {
      scriptsPath: path.join(workspace, 'scripts'),
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });

    assert.equal(result.errors.length, 1);
    assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].reason, /生存確認にも失敗したため/);
    assert.match(result.results[0].reason, /登録前終了か登録遅延か判定できません/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('captureResidentEntries: worker modeのmsg-pollは常駐対象から除外する', () => {
  const workspace = makeWorkspace();
  try {
    const entries = residentEntries(workspace);
    entries.push({ ...entries[1], pid: 105, workerName: 'issue-334-coder' });
    const harness = makeHarness(workspace, { entries });
    const captured = captureResidentEntries(workspace, harness.hooks);
    assert.deepEqual(captured.map((entry) => entry.pid), [101, 102, 103, 104]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restart-residents CLI: helpは0、引数不備は1、通常出力はMonitor再接続を区別する', () => {
  assert.equal(main(['--help']).code, 0);
  assert.match(main(['--help']).lines[0], /restart-residents\.js/);
  assert.equal(main(['--unknown']).code, 1);

  const workspace = makeWorkspace();
  const oldEnv = process.env.GH_MAESTRO_WORKSPACE;
  process.env.GH_MAESTRO_WORKSPACE = workspace;
  try {
    const harness = makeHarness(workspace, { entries: residentEntries(workspace) });
    const result = main([], {
      hooks: harness.hooks,
      scriptsPath: path.join(workspace, 'scripts'),
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(result.code, 0);
    assert.ok(result.lines.some((line) => line.includes('script=msg-poll.js') && line.includes('status=monitor-required')));
    assert.ok(result.lines.some((line) => line.startsWith('MONITOR_REATTACH_REQUIRED script=msg-poll.js')));
    assert.equal(USAGE.includes('resident-restart-logs'), true);
    assert.equal(USAGE.includes('oldPaneId=<id> newPaneId=<id>'), true);
  } finally {
    if (oldEnv === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
    else process.env.GH_MAESTRO_WORKSPACE = oldEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('formatResidentResult: statusと検証結果を機械可読な1行へ整形する', () => {
  const singleLine = formatResidentResult({
    script: 'msg-poll.js', status: 'replaced', oldPids: [10], newPids: [20], verified: true,
  });
  assert.match(singleLine, /^RESIDENT script=msg-poll\.js status=replaced oldPid=10 newPid=20 verified=true$/);

  const multipleLine = formatResidentResult({
    script: 'msg-poll.js', status: 'replaced', oldPids: [10, 11], newPids: [20, 21], verified: true,
  });
  assert.match(multipleLine, /^RESIDENT script=msg-poll\.js status=replaced oldPid=10,11 newPid=20,21 verified=true$/);
});

test('restartStatusPane: 既存ペインをclose-pane後に同じIssueでpane起動しpaneId変更を確認する', () => {
  const workspace = makeWorkspace();
  try {
    let registry = { paneId: 'old-pane', ...STATUS_PANE_CONTEXT, issue: '471' };
    const calls = [];
    const result = restartStatusPane(workspace, path.join(workspace, 'scripts'), {
      loadStatusPaneFn: () => registry,
      spawnSyncFn: (command, args, options) => {
        calls.push({ command, args, options });
        const subcommand = args[1];
        if (subcommand === 'close-pane') registry = null;
        if (subcommand === 'pane') {
          const issue = args[args.indexOf('--issue') + 1];
          registry = { paneId: 'new-pane', ...STATUS_PANE_CONTEXT, issue };
        }
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      statusPaneConfirmAttempts: 1,
      statusPaneWaitMs: 0,
    });

    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
      {
        command: process.execPath,
        args: [path.join(workspace, 'scripts', 'worker-status.js'), 'close-pane', '--workspace', workspace],
      },
      {
        command: process.execPath,
        args: [path.join(workspace, 'scripts', 'worker-status.js'), 'pane', '--workspace', workspace, '--issue', '471'],
      },
    ]);
    for (const call of calls) {
      assert.equal(call.options.cwd, workspace);
      assert.equal(call.options.encoding, 'utf8');
      assert.equal(call.options.env.WEZTERM_UNIX_SOCKET, STATUS_PANE_CONTEXT.unixSocket);
      assert.equal(call.options.env.WEZTERM_PANE, STATUS_PANE_CONTEXT.targetPaneId);
    }
    assert.deepEqual(result, {
      status: 'replaced',
      oldPaneIds: ['old-pane'],
      newPaneIds: ['new-pane'],
      verified: true,
    });
    assert.equal(formatStatusPaneResult(result), 'STATUS_PANE status=replaced oldPaneId=old-pane newPaneId=new-pane verified=true');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartStatusPane: 旧paneIdのままの場合はfailedになりrestartResidentsのerrorsへ伝播する', () => {
  const workspace = makeWorkspace();
  try {
    const statusPane = restartStatusPane(workspace, workspace, {
      loadStatusPaneFn: () => ({ paneId: 'old-pane', ...STATUS_PANE_CONTEXT, issue: '471' }),
      runStatusPaneCommandFn: ({ subcommand }) => {
        if (subcommand === 'pane') return { ok: true, status: 0, stdout: '', stderr: '' };
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      statusPaneConfirmAttempts: 1,
      statusPaneWaitMs: 0,
    });
    assert.deepEqual(statusPane, {
      status: 'failed',
      oldPaneIds: ['old-pane'],
      newPaneIds: ['old-pane'],
      verified: false,
      reason: '新しい監視ペインのpaneIdが旧paneIdから変わりませんでした',
    });

    const residents = restartResidents(workspace, {
      scriptsPath: workspace,
      preCapturedEntries: [],
      restartStatusPane: true,
      loadStatusPaneFn: () => ({ paneId: 'old-pane', ...STATUS_PANE_CONTEXT, issue: '471' }),
      runStatusPaneCommandFn: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
      statusPaneConfirmAttempts: 1,
      statusPaneWaitMs: 0,
    });
    assert.equal(residents.statusPane.status, 'failed');
    assert.match(residents.errors.join('\n'), /status-pane: 新しい監視ペインのpaneIdが旧paneIdから変わりませんでした/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartStatusPane: 新paneIdを確認できない場合はfailedを返す', () => {
  const workspace = makeWorkspace();
  try {
    let loadCount = 0;
    const result = restartStatusPane(workspace, workspace, {
      loadStatusPaneFn: () => {
        loadCount += 1;
        return loadCount === 1 ? { paneId: 'old-pane', issue: '471' } : null;
      },
      runStatusPaneCommandFn: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
      statusPaneConfirmAttempts: 1,
      statusPaneWaitMs: 0,
    });

    assert.deepEqual(result, {
      status: 'failed',
      oldPaneIds: ['old-pane'],
      newPaneIds: [],
      verified: false,
      reason: '監視ペインの旧paneIdまたは新paneIdを確認できませんでした',
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restartStatusPane: WezTermの終了失敗はunavailableとして返し、installの常駐結果を壊さない', () => {
  const workspace = makeWorkspace();
  try {
    const result = restartStatusPane(workspace, workspace, {
      loadStatusPaneFn: () => ({ paneId: 'old-pane', ...STATUS_PANE_CONTEXT, issue: '471' }),
      runStatusPaneCommandFn: () => ({ ok: false, status: 1, stderr: 'wezterm unavailable' }),
    });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.oldPaneIds, ['old-pane']);
    assert.match(result.reason, /wezterm unavailable/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('restart-residents CLI: 結果行はstdout、診断行はstderrへ書き分ける', () => {
  const stdout = [];
  const stderr = [];
  const code = writeResult({
    code: 1,
    lines: ['RESIDENT script=worker-supervisor.js status=failed'],
    errLines: ['restart-residents: 起動確認に失敗しました'],
  }, { write: (line) => stdout.push(line) }, { write: (line) => stderr.push(line) });

  assert.equal(code, 1);
  assert.deepEqual(stdout, ['RESIDENT script=worker-supervisor.js status=failed\n']);
  assert.deepEqual(stderr, ['restart-residents: 起動確認に失敗しました\n']);
});
