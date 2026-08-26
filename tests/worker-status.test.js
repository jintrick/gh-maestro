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

test('formatDuration: 秒数を適切にフォーマットする', () => {
  assert.equal(workerStatus.formatDuration(0), '0s');
  assert.equal(workerStatus.formatDuration(45), '45s');
  assert.equal(workerStatus.formatDuration(60), '1m 0s');
  assert.equal(workerStatus.formatDuration(125), '2m 5s');
  assert.equal(workerStatus.formatDuration(3600), '1h 0m 0s');
  assert.equal(workerStatus.formatDuration(3665), '1h 1m 5s');
});

test('renderUptimeBars: 空ワーカー・単一ワーカー・複数ワーカーの横棒グラフを生成する', () => {
  // 0件
  assert.deepEqual(workerStatus.renderUptimeBars([]), ['No workers registered.']);

  // 単一ワーカー
  const single = workerStatus.renderUptimeBars([
    { workerName: 'worker-1', pid: 1001, running: true, startTime: '2026-08-26T00:00:00Z', elapsedSeconds: 300 },
  ], { maxBarWidth: 10 });
  assert.equal(single.length, 1);
  assert.match(single[0], /worker-1/);
  assert.match(single[0], /\[running\]/);
  assert.match(single[0], /5m 0s/);
  assert.match(single[0], /██████████/); // 最長なので最大長
  assert.match(single[0], /\(pid: 1001\)/);

  // 複数ワーカー（相対長）
  const multi = workerStatus.renderUptimeBars([
    { workerName: 'long-worker', pid: 1001, running: true, startTime: '2026-08-26T00:00:00Z', elapsedSeconds: 1000 },
    { workerName: 'half-worker', pid: 1002, running: true, startTime: '2026-08-26T00:00:00Z', elapsedSeconds: 500 },
    { workerName: 'stopped-w', pid: 1003, running: false, startTime: null, elapsedSeconds: 0 },
  ], { maxBarWidth: 10 });
  assert.equal(multi.length, 3);
  assert.match(multi[0], /██████████/); // 1000s -> 10 chars
  assert.match(multi[1], /█████/); // 500s -> 5 chars
  assert.match(multi[2], /\[stopped\]/);
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
      'worker-a': { pid: 111 },
      'worker-b': { pid: 222 },
      'worker-c': { pid: 999999999 }, // stopped
    });

    const result = runMain(['list', '--workspace', workspace]);
    assert.equal(result.code, 0);
    assert.equal(result.errLines.length, 0);
    assert.equal(result.lines.length, 3);
    assert.match(result.lines[0], /worker-a.*\[running\].*10m 0s.*█+/);
    assert.match(result.lines[1], /worker-b.*\[running\].*5m 0s.*█+/);
    assert.match(result.lines[2], /worker-c.*\[stopped\]/);
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

test('main: watch はスナップショットとヘッダーを出力する', () => {
  const workspace = createWorkspace();
  try {
    writeWorkers(workspace, {
      'worker-a': { pid: process.pid },
    });

    const result = runMain(['watch', '--workspace', workspace, '--interval', '5']);
    assert.equal(result.code, 0);
    assert.ok(result.isWatch);
    assert.equal(result.interval, 5);
    assert.match(result.lines[0], /=== gh-maestro worker status .*interval: 5s/);
    assert.match(result.lines[1], /worker-a/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: watch に無効な --interval を渡すと code 1', () => {
  const workspace = createWorkspace();
  try {
    const result = runMain(['watch', '--workspace', workspace, '--interval', '-5']);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /--interval には正の数値を指定してください/);
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

