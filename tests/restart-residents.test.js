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
} = require('../scripts/shared/restart-residents');
const { main, USAGE } = require('../scripts/restart-residents');

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-resident-restart-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

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
      script: 'inbox-supervisor.js',
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

test('buildRestartArgs: inbox-supervisorの旧引数が無い場合だけ親チェーンをフォールバックに使う', () => {
  const workspace = makeWorkspace();
  try {
    const harness = makeHarness(workspace);
    const result = buildRestartArgs(
      { script: 'inbox-supervisor.js', workerName: null },
      { script: 'inbox-supervisor.js', args: [] },
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

test('restartResidents: 4種を停止して現行スクリプトを起動し、poll-reviewsは親へ委譲する', () => {
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
      'replaced', 'replaced', 'replaced', 'delegated',
    ]);
    assert.equal(result.results[1].monitorRequired, true);
    assert.equal(result.results[2].monitorRequired, true);
    assert.equal(result.results[3].verified, true);
    assert.equal(result.results[3].monitorScript, 'poll-pr.js');
    assert.equal(harness.spawned.length, 3, 'poll-reviewsは単独spawnせずpoll-prへ委譲する');
    assert.ok(harness.spawned.some((item) => path.basename(item.args[0]) === 'poll-pr.js'));
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

test('restartResidents: session-pidを引き継げないMonitor常駐は推測起動せず失敗する', () => {
  const workspace = makeWorkspace();
  try {
    const old = residentEntries(workspace).slice(1, 2).map((entry) => ({ ...entry, args: ['orchestrator', '--workspace', workspace] }));
    const harness = makeHarness(workspace, { entries: old });
    const result = restartResidents(workspace, {
      scriptsPath: workspace,
      hooks: harness.hooks,
      maxAttempts: 1,
      waitMs: 0,
    });
    assert.equal(harness.spawned.length, 0);
    assert.equal(result.results[1].status, 'failed');
    assert.match(result.results[1].reason, /Monitorから起動/);
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
    assert.ok(result.lines.some((line) => line.includes('script=msg-poll.js') && line.includes('status=replaced')));
    assert.ok(result.lines.some((line) => line.startsWith('MONITOR_REATTACH_REQUIRED script=msg-poll.js')));
    assert.equal(USAGE.includes('resident-restart-logs'), true);
  } finally {
    if (oldEnv === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
    else process.env.GH_MAESTRO_WORKSPACE = oldEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('formatResidentResult: statusと検証結果を機械可読な1行へ整形する', () => {
  const line = formatResidentResult({
    script: 'msg-poll.js', status: 'replaced', oldPids: [10], newPid: 20, verified: true,
  });
  assert.match(line, /^RESIDENT script=msg-poll\.js status=replaced oldPid=10 newPid=20 verified=true$/);
});
