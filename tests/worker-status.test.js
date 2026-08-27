'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const workerStatus = require('../scripts/worker-status');
const { cleanSpawnEnv } = require('./_spawn-env');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'worker-status.js');

function createWorkspace(prefix = 'gh-maestro-worker-status-') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

function workersPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'workers.json');
}

function writeWorkers(workspace, workers) {
  fs.writeFileSync(workersPath(workspace), JSON.stringify(workers), 'utf8');
}

function removeWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });
}

function runMain(args) {
  const workspaceEnv = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return workerStatus.main(args);
  } finally {
    if (workspaceEnv === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
    else process.env.GH_MAESTRO_WORKSPACE = workspaceEnv;
  }
}

test('CLI_USAGE: status・workspace・worker-name・出力形式が定義されている', () => {
  assert.match(workerStatus.CLI_USAGE, /worker-status\.js/);
  assert.match(workerStatus.CLI_USAGE, /status --workspace <path> --worker-name <name>/);
  assert.match(workerStatus.CLI_USAGE, /running/);
});

test('main: --help は code 0 で usage を返す', () => {
  const result = runMain(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.lines.join('\n'), /worker-status\.js/);
  assert.deepEqual(result.errLines, []);
});

test('main: サブコマンド・workspace・worker-name の誤用は照会せず code 1', () => {
  const workspace = createWorkspace();
  try {
    for (const args of [
      [],
      ['unknown', '--workspace', workspace, '--worker-name', 'worker'],
      ['status', '--workspace', workspace],
      ['status', '--worker-name', 'worker'],
    ]) {
      const result = runMain(args);
      assert.equal(result.code, 1, `args=${JSON.stringify(args)}`);
      assert.deepEqual(result.lines, [], `args=${JSON.stringify(args)}`);
      assert.ok(result.errLines.length > 0, `args=${JSON.stringify(args)}`);
    }
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: worker-name の値が --help の場合は help に握り潰さず code 1', () => {
  const workspace = createWorkspace();
  try {
    const result = runMain(['status', '--workspace', workspace, '--worker-name', '--help']);
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, []);
    assert.ok(result.errLines.some((line) => line.includes('値が必要です')));
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: 無効なworkspaceは状態を出さず code 1', () => {
  const result = runMain([
    'status', '--workspace', os.homedir(), '--worker-name', 'worker',
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(result.lines, []);
  assert.match(result.errLines.join('\n'), /ワークスペースを解決できません/);
});

test('main: 生存中・停止済み・未登録ワーカーの状態を既存述語経由で返す', () => {
  const workspace = createWorkspace();
  try {
    writeWorkers(workspace, {
      alive: { pid: process.pid },
      stopped: { pid: 999999999 },
    });

    const alive = runMain([
      'status', '--workspace', workspace, '--worker-name', 'alive',
    ]);
    assert.equal(alive.code, 0);
    assert.deepEqual(JSON.parse(alive.lines[0]), {
      workerName: 'alive', running: true, pid: process.pid,
    });

    const stopped = runMain([
      'status', '--workspace', workspace, '--worker-name', 'stopped',
    ]);
    assert.equal(stopped.code, 0);
    assert.deepEqual(JSON.parse(stopped.lines[0]), {
      workerName: 'stopped', running: false, pid: 999999999,
    });

    const missing = runMain([
      'status', '--workspace', workspace, '--worker-name', 'missing',
    ]);
    assert.equal(missing.code, 0);
    assert.deepEqual(JSON.parse(missing.lines[0]), {
      workerName: 'missing', running: false, pid: null,
    });
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: workers.json 不在は空レジストリとして running:false を返す', () => {
  const workspace = createWorkspace();
  try {
    const result = runMain([
      'status', '--workspace', workspace, '--worker-name', 'missing',
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.lines[0]), {
      workerName: 'missing', running: false, pid: null,
    });
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: 壊れた workers.json は状態を出さず code 1', () => {
  const workspace = createWorkspace();
  try {
    fs.writeFileSync(workersPath(workspace), '{ broken json', 'utf8');
    const result = runMain([
      'status', '--workspace', workspace, '--worker-name', 'worker',
    ]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, []);
    assert.match(result.errLines.join('\n'), /workers\.json/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('サブプロセス: --help は code 0 で usage を表示する', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worker-status\.js/);
});

test('サブプロセス: status は workers.json の生存状態をJSONで返す', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-cli-');
  try {
    writeWorkers(workspace, { alive: { pid: process.pid } });
    const result = runCli([
      'status', '--workspace', workspace, '--worker-name', 'alive',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      workerName: 'alive', running: true, pid: process.pid,
    });
  } finally {
    removeWorkspace(workspace);
  }
});

test('サブプロセス: workers.json の読み取り失敗は running:false に握り潰さず code 1', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-cli-broken-');
  try {
    fs.writeFileSync(workersPath(workspace), '{ broken json', 'utf8');
    const result = runCli([
      'status', '--workspace', workspace, '--worker-name', 'worker',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /status の照会に失敗しました/);
    assert.match(result.stderr, /workers\.json/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('formatJstTime: エポックミリ秒を日本時間(UTC+9)のHH:mm:ss形式に変換する', () => {
  // UTC 12:00:00 -> JST 21:00:00
  const t1 = new Date('2026-08-26T12:00:00.000Z').getTime();
  assert.equal(workerStatus.formatJstTime(t1), '21:00:00');

  // UTC 00:00:00 -> JST 09:00:00
  const t2 = new Date('2026-08-26T00:00:00.000Z').getTime();
  assert.equal(workerStatus.formatJstTime(t2), '09:00:00');

  // UTC 15:30:45 -> JST 00:30:45 (翌日)
  const t3 = new Date('2026-08-26T15:30:45.000Z').getTime();
  assert.equal(workerStatus.formatJstTime(t3), '00:30:45');

  // UTC 23:59:59 -> JST 08:59:59 (翌日)
  const t4 = new Date('2026-08-26T23:59:59.000Z').getTime();
  assert.equal(workerStatus.formatJstTime(t4), '08:59:59');
});

test('stripWorkerNamePrefix: 先頭の issue-<N>- を除去し、パターン外はそのまま返す', () => {
  assert.equal(workerStatus.stripWorkerNamePrefix('issue-403-explorer-explore-pane-info'), 'explorer-explore-pane-info');
  assert.equal(workerStatus.stripWorkerNamePrefix('issue-12-coder-impl'), 'coder-impl');
  assert.equal(workerStatus.stripWorkerNamePrefix('issue-0-diagnostician'), 'diagnostician');
  assert.equal(workerStatus.stripWorkerNamePrefix('non-issue-worker'), 'non-issue-worker');
  assert.equal(workerStatus.stripWorkerNamePrefix('issue-abc-worker'), 'issue-abc-worker');
  assert.equal(workerStatus.stripWorkerNamePrefix(''), '');
  assert.equal(workerStatus.stripWorkerNamePrefix(null), '');
});

test('formatDuration: 秒数を適切にフォーマットする', () => {
  assert.equal(workerStatus.formatDuration(0), '0s');
  assert.equal(workerStatus.formatDuration(45), '45s');
  assert.equal(workerStatus.formatDuration(60), '1m 0s');
  assert.equal(workerStatus.formatDuration(125), '2m 5s');
  assert.equal(workerStatus.formatDuration(3600), '1h 0m 0s');
  assert.equal(workerStatus.formatDuration(3665), '1h 1m 5s');
});

test('renderUptimeBars: 空ワーカー・単一ワーカー・複数ワーカーの横棒グラフを生成する（Issue番号・短縮名・agentId含む）', () => {
  // 0件
  assert.deepEqual(workerStatus.renderUptimeBars([]), ['No workers registered.']);

  // 単一ワーカー
  const single = workerStatus.renderUptimeBars([
    {
      workerName: 'issue-403-worker-1',
      issue: 403,
      agentId: 'claude-code',
      pid: 1001,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 300,
    },
  ], { maxBarWidth: 10 });
  assert.equal(single.length, 1);
  assert.match(single[0], /^#403\s+worker-1\s+claude-code\s+\[running\]\s+5m 0s\s+██████████\s+\(pid: 1001\)$/);

  // 複数ワーカー（相対長、nullフォールバック、パターン外ワーカー名）
  const multi = workerStatus.renderUptimeBars([
    {
      workerName: 'issue-403-long-worker',
      issue: 403,
      agentId: 'gemini-cli',
      pid: 1001,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 1000,
    },
    {
      workerName: 'issue-403-half-worker',
      issue: 403,
      agentId: 'codex',
      pid: 1002,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 500,
    },
    {
      workerName: 'legacy-w',
      issue: null,
      agentId: null,
      pid: 1003,
      running: false,
      startTime: null,
      elapsedSeconds: 0,
    },
  ], { maxBarWidth: 10 });
  assert.equal(multi.length, 3);
  assert.match(multi[0], /#403\s+long-worker\s+gemini-cli\s+\[running\]\s+16m 40s\s+██████████\s+\(pid: 1001\)/);
  assert.match(multi[1], /#403\s+half-worker\s+codex\s+\[running\]\s+8m 20s\s+█████\s+\(pid: 1002\)/);
  assert.match(multi[2], /-\s+legacy-w\s+-\s+\[stopped\]\s+-\s+\(pid: 1003\)/);
});

test('main: list は全ワーカーの横棒グラフを出力する', () => {
  const workspace = createWorkspace();
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  workerStatus._setIsWorkerAlive((rawEntry) => rawEntry && rawEntry.pid !== 999999999);
  workerStatus._setGetProcessStartTime((pid) => {
    if (pid === 111) return '2026-08-26T11:50:00.000Z'; // 600s ago
    if (pid === 222) return '2026-08-26T11:55:00.000Z'; // 300s ago
    return null;
  });

  try {
    writeWorkers(workspace, {
      'issue-100-worker-a': { pid: 111, issue: 100, agentId: 'agent-1' },
      'issue-100-worker-b': { pid: 222, issue: 100, agentId: 'agent-2' },
      'worker-c': { pid: 999999999 }, // stopped, no issue/agentId
    });

    const result = runMain(['list', '--workspace', workspace]);
    assert.equal(result.code, 0);
    assert.equal(result.errLines.length, 0);
    assert.equal(result.lines.length, 3);
    assert.match(result.lines[0], /#100\s+worker-a\s+agent-1\s+\[running\]\s+10m 0s\s+█+/);
    assert.match(result.lines[1], /#100\s+worker-b\s+agent-2\s+\[running\]\s+5m 0s\s+█+/);
    assert.match(result.lines[2], /-\s+worker-c\s+-\s+\[stopped\]/);
  } finally {
    workerStatus._setNow(null);
    workerStatus._setIsWorkerAlive(null);
    workerStatus._setGetProcessStartTime(null);
    removeWorkspace(workspace);
  }
});

test('main: list --json は機械可読な JSON 配列を出力する', () => {
  const workspace = createWorkspace();
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  workerStatus._setIsWorkerAlive((rawEntry) => rawEntry && rawEntry.pid === 111);
  workerStatus._setGetProcessStartTime((pid) => {
    if (pid === 111) return '2026-08-26T11:50:00.000Z';
    return null;
  });

  try {
    writeWorkers(workspace, {
      'worker-a': { pid: 111 },
    });

    const result = runMain(['list', '--workspace', workspace, '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.errLines.length, 0);
    const parsed = JSON.parse(result.lines.join('\n'));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      workerName: 'worker-a',
      pid: 111,
      running: true,
      startTime: '2026-08-26T11:50:00.000Z',
      elapsedSeconds: 600,
    });
  } finally {
    workerStatus._setNow(null);
    workerStatus._setIsWorkerAlive(null);
    workerStatus._setGetProcessStartTime(null);
    removeWorkspace(workspace);
  }
});

test('main: list に --worker-name を指定すると code 1', () => {
  const workspace = createWorkspace();
  try {
    const result = runMain(['list', '--workspace', workspace, '--worker-name', 'worker-a']);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /--worker-name は list では使用できません/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('parseInterval: 既定値・正常値・範囲外値・不正値を検証する', () => {
  assert.equal(workerStatus.parseInterval(undefined), 3);
  assert.equal(workerStatus.parseInterval('1'), 1);
  assert.equal(workerStatus.parseInterval('5'), 5);
  assert.equal(workerStatus.parseInterval('3600'), 3600);

  // 下限違反 (0, 0.0001, -1)
  assert.throws(() => workerStatus.parseInterval('0'), /--interval には 1〜3600 の数値を指定してください/);
  assert.throws(() => workerStatus.parseInterval('0.0001'), /--interval には 1〜3600 の数値を指定してください/);
  assert.throws(() => workerStatus.parseInterval('-5'), /--interval には 1〜3600 の数値を指定してください/);

  // 上限違反 (3601, 2147484)
  assert.throws(() => workerStatus.parseInterval('3601'), /--interval には 1〜3600 の数値を指定してください/);
  assert.throws(() => workerStatus.parseInterval('2147484'), /--interval には 1〜3600 の数値を指定してください/);

  // 不正値 (NaN, 空文字, 文字列)
  assert.throws(() => workerStatus.parseInterval('abc'), /--interval には 1〜3600 の数値を指定してください/);
  assert.throws(() => workerStatus.parseInterval(''), /--interval には 1〜3600 の数値を指定してください/);
});

test('runWatchLoop: 初回描画・定期再描画・シグナルハンドラ・エラー耐性を検証する', () => {
  const workspace = createWorkspace();
  const stdoutChunks = [];
  const stderrChunks = [];
  const fakeStdout = { write: (chunk) => stdoutChunks.push(chunk) };
  const fakeStderr = { write: (chunk) => stderrChunks.push(chunk) };

  let timerCallback = null;
  let timerIntervalMs = null;
  let clearedTimer = null;
  const fakeSetInterval = (cb, ms) => {
    timerCallback = cb;
    timerIntervalMs = ms;
    return 12345;
  };
  const fakeClearInterval = (id) => {
    clearedTimer = id;
  };

  const signalHandlers = {};
  const fakeOnSignal = (sig, handler) => {
    signalHandlers[sig] = handler;
  };

  let exitCode = null;
  const fakeExit = (code) => {
    exitCode = code;
  };

  let currentTime = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => currentTime);
  workerStatus._setIsWorkerAlive((rawEntry) => rawEntry && rawEntry.pid === 111);
  workerStatus._setGetProcessStartTime((pid) => (pid === 111 ? '2026-08-26T11:55:00.000Z' : null));

  try {
    writeWorkers(workspace, { 'worker-a': { pid: 111 } });

    // ループ開始
    const handle = workerStatus.runWatchLoop(workspace, 2, {
      stdout: fakeStdout,
      stderr: fakeStderr,
      setIntervalFn: fakeSetInterval,
      clearIntervalFn: fakeClearInterval,
      onSignalFn: fakeOnSignal,
      exitFn: fakeExit,
    });

    // 1. 初回描画の検証（intervalMs, 画面クリア, ヘッダー, バー）
    assert.equal(timerIntervalMs, 2000);
    assert.equal(handle.timer, 12345);
    const initialOutput = stdoutChunks.join('');
    assert.match(initialOutput, /\x1b\[2J\x1b\[H/); // ANSI画面クリア
    assert.match(initialOutput, /=== gh-maestro worker status \(21:00:00, interval: 2s\) ===/);
    assert.match(initialOutput, /-\s+worker-a\s+-\s+\[running\]\s+5m 0s/);

    // 2. タイマーコールバック実行（定期再描画）
    stdoutChunks.length = 0;
    currentTime += 2000; // 2秒経過
    assert.ok(typeof timerCallback === 'function');
    timerCallback();

    const secondOutput = stdoutChunks.join('');
    assert.match(secondOutput, /\x1b\[2J\x1b\[H/);
    assert.match(secondOutput, /=== gh-maestro worker status \(21:00:02, interval: 2s\) ===/);
    assert.match(secondOutput, /-\s+worker-a\s+-\s+\[running\]\s+5m 2s/);

    // 3. エラー耐性（workers.json 破損時もループが落ちず stderr に書く）
    stdoutChunks.length = 0;
    fs.writeFileSync(workersPath(workspace), '{ broken json', 'utf8');
    timerCallback();
    assert.match(stderrChunks.join(''), /worker-status: watch 更新エラー/);

    // 4. シグナルハンドラ（SIGINT / SIGTERM でタイマー解除と exit(0)）
    assert.ok(typeof signalHandlers['SIGINT'] === 'function');
    assert.ok(typeof signalHandlers['SIGTERM'] === 'function');

    signalHandlers['SIGINT']();
    assert.equal(clearedTimer, 12345);
    assert.equal(exitCode, 0);
  } finally {
    workerStatus._setNow(null);
    workerStatus._setIsWorkerAlive(null);
    workerStatus._setGetProcessStartTime(null);
    removeWorkspace(workspace);
  }
});

test('main: watch はスナップショットとJSTヘッダー（時刻のみ）を出力する', () => {
  const workspace = createWorkspace();
  const fixedNow = new Date('2026-08-26T03:15:30.000Z').getTime(); // JST 12:15:30
  workerStatus._setNow(() => fixedNow);

  try {
    writeWorkers(workspace, {
      'issue-403-worker-a': { pid: process.pid, issue: 403, agentId: 'gemini' },
    });

    const result = runMain(['watch', '--workspace', workspace, '--interval', '5']);
    assert.equal(result.code, 0);
    assert.ok(result.isWatch);
    assert.equal(result.interval, 5);
    assert.equal(result.lines[0], '=== gh-maestro worker status (12:15:30, interval: 5s) ===');
    assert.match(result.lines[1], /#403\s+worker-a\s+gemini/);
  } finally {
    workerStatus._setNow(null);
    removeWorkspace(workspace);
  }
});

test('main: watch に無効な --interval を渡すと code 1', () => {
  const workspace = createWorkspace();
  try {
    const result1 = runMain(['watch', '--workspace', workspace, '--interval', '-5']);
    assert.equal(result1.code, 1);
    assert.match(result1.errLines.join('\n'), /--interval には 1〜3600 の数値を指定してください/);

    const result2 = runMain(['watch', '--workspace', workspace, '--interval', '0.0001']);
    assert.equal(result2.code, 1);
    assert.match(result2.errLines.join('\n'), /--interval には 1〜3600 の数値を指定してください/);

    const result3 = runMain(['watch', '--workspace', workspace, '--interval', '2147484']);
    assert.equal(result3.code, 1);
    assert.match(result3.errLines.join('\n'), /--interval には 1〜3600 の数値を指定してください/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: pane に無効な --interval を渡すと code 1', () => {
  const workspace = createWorkspace();
  try {
    const result = runMain(['pane', '--workspace', workspace, '--interval', '99999']);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /--interval には 1〜3600 の数値を指定してください/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: pane は WezTerm split-pane（既定: bottom 15%）を呼び出し STATUS_PANE_LAUNCHED を返す', () => {
  const workspace = createWorkspace();
  let capturedParams = null;
  workerStatus._setLaunchInSplitPane((params) => {
    capturedParams = params;
    return { paneId: '99' };
  });

  try {
    const result = runMain(['pane', '--workspace', workspace]);
    assert.equal(result.code, 0);
    assert.equal(result.paneId, '99');
    assert.match(result.lines[0], /STATUS_PANE_LAUNCHED: pane=99/);
    assert.equal(capturedParams.direction, 'bottom');
    assert.equal(capturedParams.percent, 15);
    assert.equal(capturedParams.cwd, workspace);
    assert.deepEqual(capturedParams.argv.slice(-5), ['watch', '--workspace', workspace, '--interval', '3']);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    removeWorkspace(workspace);
  }
});

test('main: pane は direction と percent をカスタマイズできる', () => {
  const workspace = createWorkspace();
  let capturedParams = null;
  workerStatus._setLaunchInSplitPane((params) => {
    capturedParams = params;
    return { paneId: '100' };
  });

  try {
    const result = runMain(['pane', '--workspace', workspace, '--direction', 'right', '--percent', '20', '--interval', '2']);
    assert.equal(result.code, 0);
    assert.equal(capturedParams.direction, 'right');
    assert.equal(capturedParams.percent, 20);
    assert.deepEqual(capturedParams.argv.slice(-5), ['watch', '--workspace', workspace, '--interval', '2']);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    removeWorkspace(workspace);
  }
});

test('main: pane に無効な direction や percent を渡すと code 1', () => {
  const workspace = createWorkspace();
  try {
    const badDir = runMain(['pane', '--workspace', workspace, '--direction', 'center']);
    assert.equal(badDir.code, 1);
    assert.match(badDir.errLines.join('\n'), /--direction は bottom\|right\|top\|left/);

    const badPct = runMain(['pane', '--workspace', workspace, '--percent', '150']);
    assert.equal(badPct.code, 1);
    assert.match(badPct.errLines.join('\n'), /--percent は 1〜99/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: pane の split-pane 失敗時はエラー行を出力して code 1', () => {
  const workspace = createWorkspace();
  workerStatus._setLaunchInSplitPane(() => {
    throw new Error('WezTerm not found');
  });

  try {
    const result = runMain(['pane', '--workspace', workspace]);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /WezTerm not found/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    removeWorkspace(workspace);
  }
});

test('main: pane は初回起動時に status-pane.json を保存し、2回目の実行時は既存ペインを再利用する', () => {
  const workspace = createWorkspace();
  let launchCallCount = 0;
  workerStatus._setLaunchInSplitPane((params) => {
    launchCallCount++;
    return { paneId: '201' };
  });

  const aliveSet = new Set(['201']);
  workerStatus._setIsPaneAlive((id) => aliveSet.has(String(id)));

  try {
    // 1回目の実行: split-pane が呼ばれ、status-pane.json が保存される
    const result1 = runMain(['pane', '--workspace', workspace]);
    assert.equal(result1.code, 0);
    assert.equal(result1.paneId, '201');
    assert.equal(result1.reused, false);
    assert.equal(launchCallCount, 1);
    assert.match(result1.lines[0], /STATUS_PANE_LAUNCHED: pane=201/);

    // 2回目の実行: 既存ペインが生存しているため launchInSplitPane は呼ばれず再利用される
    const result2 = runMain(['pane', '--workspace', workspace]);
    assert.equal(result2.code, 0);
    assert.equal(result2.paneId, '201');
    assert.equal(result2.reused, true);
    assert.equal(launchCallCount, 1); // 呼ばれていないことを検証
    assert.match(result2.lines[0], /STATUS_PANE_LAUNCHED: pane=201/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setIsPaneAlive(null);
    removeWorkspace(workspace);
  }
});

test('main: pane は記録されたペインが既に死亡している場合、新しく作成し記録を更新する', () => {
  const workspace = createWorkspace();
  let createdPaneId = '301';
  let launchCallCount = 0;
  workerStatus._setLaunchInSplitPane(() => {
    launchCallCount++;
    return { paneId: createdPaneId };
  });

  const aliveSet = new Set(['301']);
  workerStatus._setIsPaneAlive((id) => aliveSet.has(String(id)));

  try {
    // 初回起動
    const result1 = runMain(['pane', '--workspace', workspace]);
    assert.equal(result1.code, 0);
    assert.equal(result1.paneId, '301');
    assert.equal(launchCallCount, 1);

    // 人が手でペインを閉じた（死亡）
    aliveSet.delete('301');
    createdPaneId = '302';
    aliveSet.add('302');

    // 2回目実行: 死んだペインを検知し、新しく作り直す
    const result2 = runMain(['pane', '--workspace', workspace]);
    assert.equal(result2.code, 0);
    assert.equal(result2.paneId, '302');
    assert.equal(result2.reused, false);
    assert.equal(launchCallCount, 2);
    assert.match(result2.lines[0], /STATUS_PANE_LAUNCHED: pane=302/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setIsPaneAlive(null);
    removeWorkspace(workspace);
  }
});

test('main: close-pane は開いている監視ペインを kill して記録を削除する', () => {
  const workspace = createWorkspace();
  workerStatus._setLaunchInSplitPane(() => ({ paneId: '401' }));
  const aliveSet = new Set(['401']);
  workerStatus._setIsPaneAlive((id) => aliveSet.has(String(id)));

  let killedId = null;
  workerStatus._setKillPane((id) => {
    killedId = id;
    aliveSet.delete(String(id));
    return { ok: true, status: 0, stderr: '' };
  });

  try {
    // 起動
    runMain(['pane', '--workspace', workspace]);

    // close-pane
    const result = runMain(['close-pane', '--workspace', workspace]);
    assert.equal(result.code, 0);
    assert.equal(result.paneId, '401');
    assert.equal(killedId, '401');
    assert.match(result.lines[0], /STATUS_PANE_CLOSED: pane=401/);

    // 再度 close-pane: 既に削除済みなので NOT_FOUND で終了
    const resultNotFound = runMain(['close-pane', '--workspace', workspace]);
    assert.equal(resultNotFound.code, 0);
    assert.match(resultNotFound.lines[0], /STATUS_PANE_NOT_FOUND/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setIsPaneAlive(null);
    workerStatus._setKillPane(null);
    removeWorkspace(workspace);
  }
});

test('main: close-pane で kill に失敗した場合は code 1 を返す（フェイルクローズ）', () => {
  const workspace = createWorkspace();
  workerStatus._setLaunchInSplitPane(() => ({ paneId: '501' }));
  workerStatus._setIsPaneAlive(() => true);
  workerStatus._setKillPane(() => ({ ok: false, status: 1, stderr: 'permission denied' }));

  try {
    runMain(['pane', '--workspace', workspace]);
    const result = runMain(['close-pane', '--workspace', workspace]);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /permission denied/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setIsPaneAlive(null);
    workerStatus._setKillPane(null);
    removeWorkspace(workspace);
  }
});

test('main: pane は status-pane.json の保存に失敗した場合にエラーを出力し code 1 を返す', () => {
  const workspace = createWorkspace();
  workerStatus._setLaunchInSplitPane(() => ({ paneId: '601' }));
  workerStatus._setSaveStatusPane(() => {
    throw new Error('disk full');
  });

  try {
    const result = runMain(['pane', '--workspace', workspace]);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /監視ペイン状態の保存に失敗しました: disk full/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setSaveStatusPane(null);
    removeWorkspace(workspace);
  }
});



test('サブプロセス: list は全ワーカーの横棒グラフを表示する', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-list-cli-');
  try {
    writeWorkers(workspace, { alive: { pid: process.pid } });
    const result = runCli(['list', '--workspace', workspace]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /alive/);
    assert.match(result.stdout, /\[running\]/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: orchestrator を除外し、issue と agentId を収集する', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-collect-');
  try {
    writeWorkers(workspace, {
      orchestrator: { pid: process.pid, issue: null, agentId: 'lead' },
      'issue-403-coder-pane-display': { pid: process.pid, issue: 403, agentId: 'gemini-cli', skill: 'gh-maestro-coder' },
      'worker-legacy': { pid: null },
    });

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 2);

    const coder = results.find(w => w.workerName === 'issue-403-coder-pane-display');
    assert.ok(coder);
    assert.equal(coder.issue, 403);
    assert.equal(coder.agentId, 'gemini-cli');

    const legacy = results.find(w => w.workerName === 'worker-legacy');
    assert.ok(legacy);
    assert.equal(legacy.issue, null);
    assert.equal(legacy.agentId, null);
  } finally {
    removeWorkspace(workspace);
  }
});

test('renderUptimeBars: skill(役割)が独立列として出力されないこと、および不正/欠損値のフォールバックを検証する', () => {
  const workers = [
    {
      workerName: 'issue-403-coder-pane-display',
      issue: 403,
      agentId: 'claude-code',
      skill: 'gh-maestro-coder',
      pid: 100,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 60,
    },
    {
      workerName: 'unknown-prefix-worker',
      issue: null,
      agentId: null,
      skill: null,
      pid: null,
      running: false,
      startTime: null,
      elapsedSeconds: 0,
    },
  ];

  const lines = workerStatus.renderUptimeBars(workers);
  assert.equal(lines.length, 2);

  // 1行目: #403 coder-pane-display claude-code [running] 1m 0s ...
  // skill 名 'gh-maestro-coder' そのものが独立列として含まれていないことを確認
  assert.ok(!lines[0].includes('gh-maestro-coder'));
  assert.match(lines[0], /^#403\s+coder-pane-display\s+claude-code\s+\[running\]\s+1m 0s/);

  // 2行目: - unknown-prefix-worker - [stopped] -
  assert.match(lines[1], /^-\s+unknown-prefix-worker\s+-\s+\[stopped\]\s+-$/);
});

test('サブプロセス: list --json は機械可読な JSON 配列を返す', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-list-json-');
  try {
    writeWorkers(workspace, { alive: { pid: process.pid } });
    const result = runCli(['list', '--workspace', workspace, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].workerName, 'alive');
    assert.equal(parsed[0].running, true);
    assert.equal(parsed[0].pid, process.pid);
    assert.ok(typeof parsed[0].elapsedSeconds === 'number');
  } finally {
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: 稼働中 Review Manager を収集し、PR番号・ワーカー名・agentId を設定する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  workerStatus._setIsProcessAlive((pid) => pid === 5001);
  workerStatus._setGetProcessStartTime((pid) => (pid === 5001 ? '2026-08-26T11:50:00.000Z' : null));

  try {
    const reviewDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '404', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '5001\n', 'utf8');

    // workspace config で reviewer agent をカスタマイズ
    fs.writeFileSync(path.join(workspace, '.gh-maestro', 'config.json'), JSON.stringify({
      skillAgentMap: { 'gh-maestro-reviewer': 'codex-custom' },
    }), 'utf8');

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      workerName: 'review-manager-pr-404',
      pid: 5001,
      running: true,
      startTime: '2026-08-26T11:50:00.000Z',
      elapsedSeconds: 600,
      issue: null,
      pr: 404,
      agentId: 'codex-custom',
    });
  } finally {
    workerStatus._setNow(null);
    workerStatus._setIsProcessAlive(null);
    workerStatus._setGetProcessStartTime(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus / renderUptimeBars: resolveSkillAgentMap が例外を投げた場合に agentId が null / - となる縮退動作を検証する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-throw-');
  workerStatus._setIsProcessAlive((pid) => pid === 6001);
  workerStatus._setResolveSkillAgentMap(() => {
    throw new Error('config parse error');
  });

  try {
    const reviewDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '501', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '6001\n', 'utf8');

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 1);
    assert.equal(results[0].agentId, null);

    const lines = workerStatus.renderUptimeBars(results);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^PR#501\s+review-manager-pr-501\s+-\s+\[running\]/);
  } finally {
    workerStatus._setIsProcessAlive(null);
    workerStatus._setResolveSkillAgentMap(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus / renderUptimeBars: skillAgentMap[\'gh-maestro-reviewer\'] が未設定・null・非文字列の場合に agentId が null / - となる縮退動作を検証する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-unset-');
  workerStatus._setIsProcessAlive(() => true);

  try {
    const reviewDir1 = path.join(workspace, '.gh-maestro', 'records', 'pr', '601', 'review');
    const reviewDir2 = path.join(workspace, '.gh-maestro', 'records', 'pr', '602', 'review');
    const reviewDir3 = path.join(workspace, '.gh-maestro', 'records', 'pr', '603', 'review');
    fs.mkdirSync(reviewDir1, { recursive: true });
    fs.mkdirSync(reviewDir2, { recursive: true });
    fs.mkdirSync(reviewDir3, { recursive: true });
    fs.writeFileSync(path.join(reviewDir1, 'manager.running'), '7001\n', 'utf8');
    fs.writeFileSync(path.join(reviewDir2, 'manager.running'), '7002\n', 'utf8');
    fs.writeFileSync(path.join(reviewDir3, 'manager.running'), '7003\n', 'utf8');

    // 1. 未設定（空オブジェクト）
    workerStatus._setResolveSkillAgentMap(() => ({}));
    const res1 = workerStatus.collectWorkersStatus(workspace);
    const rm1 = res1.find((r) => r.pr === 601);
    assert.ok(rm1);
    assert.equal(rm1.agentId, null);
    assert.match(workerStatus.renderUptimeBars([rm1])[0], /^PR#601\s+review-manager-pr-601\s+-\s+\[running\]/);

    // 2. null
    workerStatus._setResolveSkillAgentMap(() => ({ 'gh-maestro-reviewer': null }));
    const res2 = workerStatus.collectWorkersStatus(workspace);
    const rm2 = res2.find((r) => r.pr === 602);
    assert.ok(rm2);
    assert.equal(rm2.agentId, null);
    assert.match(workerStatus.renderUptimeBars([rm2])[0], /^PR#602\s+review-manager-pr-602\s+-\s+\[running\]/);

    // 3. 非文字列（数値）
    workerStatus._setResolveSkillAgentMap(() => ({ 'gh-maestro-reviewer': 12345 }));
    const res3 = workerStatus.collectWorkersStatus(workspace);
    const rm3 = res3.find((r) => r.pr === 603);
    assert.ok(rm3);
    assert.equal(rm3.agentId, null);
    assert.match(workerStatus.renderUptimeBars([rm3])[0], /^PR#603\s+review-manager-pr-603\s+-\s+\[running\]/);
  } finally {
    workerStatus._setIsProcessAlive(null);
    workerStatus._setResolveSkillAgentMap(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: 死亡した Review Manager の PID は収集しない', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-dead-');
  workerStatus._setIsProcessAlive(() => false);

  try {
    const reviewDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '404', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '999999999\n', 'utf8');

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 0);
  } finally {
    workerStatus._setIsProcessAlive(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: manager.running が破損・空・非数値でも全体が失敗せず既存ワーカーを返す (tolerant)', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-corrupt-');
  workerStatus._setIsWorkerAlive((rawEntry) => rawEntry && rawEntry.pid === 111);

  try {
    writeWorkers(workspace, {
      'issue-100-worker-a': { pid: 111, issue: 100, agentId: 'agent-1' },
    });

    const badReviewDir1 = path.join(workspace, '.gh-maestro', 'records', 'pr', '401', 'review');
    const badReviewDir2 = path.join(workspace, '.gh-maestro', 'records', 'pr', '402', 'review');
    fs.mkdirSync(badReviewDir1, { recursive: true });
    fs.mkdirSync(badReviewDir2, { recursive: true });
    fs.writeFileSync(path.join(badReviewDir1, 'manager.running'), 'not-a-number\n', 'utf8');
    fs.writeFileSync(path.join(badReviewDir2, 'manager.running'), '', 'utf8');

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 1);
    assert.equal(results[0].workerName, 'issue-100-worker-a');
  } finally {
    workerStatus._setIsWorkerAlive(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: 複数 PR の Review Manager が同時に存在する場合それぞれ収集する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-multi-');
  workerStatus._setIsProcessAlive((pid) => pid === 101 || pid === 102);
  workerStatus._setGetProcessStartTime(() => '2026-08-26T11:55:00.000Z');

  try {
    const reviewDir1 = path.join(workspace, '.gh-maestro', 'records', 'pr', '10', 'review');
    const reviewDir2 = path.join(workspace, '.gh-maestro', 'records', 'pr', '20', 'review');
    fs.mkdirSync(reviewDir1, { recursive: true });
    fs.mkdirSync(reviewDir2, { recursive: true });
    fs.writeFileSync(path.join(reviewDir1, 'manager.running'), '101\n', 'utf8');
    fs.writeFileSync(path.join(reviewDir2, 'manager.running'), '102\n', 'utf8');

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.workerName === 'review-manager-pr-10' && r.pr === 10 && r.pid === 101));
    assert.ok(results.some((r) => r.workerName === 'review-manager-pr-20' && r.pr === 20 && r.pid === 102));
  } finally {
    workerStatus._setIsProcessAlive(null);
    workerStatus._setGetProcessStartTime(null);
    removeWorkspace(workspace);
  }
});

test('renderUptimeBars: Review Manager の行が PR#<PR> および review-manager-pr-<PR> 形式で描画される', () => {
  const workers = [
    {
      workerName: 'issue-403-worker-1',
      issue: 403,
      pr: null,
      agentId: 'claude-code',
      pid: 1001,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 300,
    },
    {
      workerName: 'review-manager-pr-404',
      issue: null,
      pr: 404,
      agentId: 'codex',
      pid: 1002,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 600,
    },
  ];

  const lines = workerStatus.renderUptimeBars(workers, { maxBarWidth: 10 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^#403\s+worker-1\s+claude-code\s+\[running\]\s+5m 0s\s+█████\s+\(pid: 1001\)$/);
  assert.match(lines[1], /^PR#404\s+review-manager-pr-404\s+codex\s+\[running\]\s+10m 0s\s+██████████\s+\(pid: 1002\)$/);
});

test('main: list および list --json で Review Manager を表示する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-main-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  workerStatus._setIsWorkerAlive((rawEntry) => rawEntry && rawEntry.pid === 111);
  workerStatus._setIsProcessAlive((pid) => pid === 222);
  workerStatus._setGetProcessStartTime((pid) => {
    if (pid === 111) return '2026-08-26T11:50:00.000Z'; // 600s
    if (pid === 222) return '2026-08-26T11:55:00.000Z'; // 300s
    return null;
  });

  try {
    writeWorkers(workspace, {
      'issue-100-worker-a': { pid: 111, issue: 100, agentId: 'agent-1' },
    });

    fs.writeFileSync(path.join(workspace, '.gh-maestro', 'config.json'), JSON.stringify({
      skillAgentMap: { 'gh-maestro-reviewer': 'codex' },
    }), 'utf8');

    const reviewDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '405', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), '222\n', 'utf8');

    // 1. list (テキスト行)
    const listResult = runMain(['list', '--workspace', workspace]);
    assert.equal(listResult.code, 0);
    assert.equal(listResult.lines.length, 2);
    assert.match(listResult.lines[0], /#100\s+worker-a\s+agent-1\s+\[running\]\s+10m 0s/);
    assert.match(listResult.lines[1], /PR#405\s+review-manager-pr-405\s+codex\s+\[running\]\s+5m 0s/);

    // 2. list --json (機械可読JSON)
    const jsonResult = runMain(['list', '--workspace', workspace, '--json']);
    assert.equal(jsonResult.code, 0);
    const parsed = JSON.parse(jsonResult.lines.join('\n'));
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      workerName: 'issue-100-worker-a',
      pid: 111,
      running: true,
      startTime: '2026-08-26T11:50:00.000Z',
      elapsedSeconds: 600,
    });
    assert.deepEqual(parsed[1], {
      workerName: 'review-manager-pr-405',
      pid: 222,
      running: true,
      startTime: '2026-08-26T11:55:00.000Z',
      elapsedSeconds: 300,
    });
  } finally {
    workerStatus._setNow(null);
    workerStatus._setIsWorkerAlive(null);
    workerStatus._setIsProcessAlive(null);
    workerStatus._setGetProcessStartTime(null);
    removeWorkspace(workspace);
  }
});


