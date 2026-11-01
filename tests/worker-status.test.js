'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

// 描画された文字列の見た目（区切り記号・バーの本数・空白の詰め方・時間の書式・
// 見出しの文言）は検証しない。見た目の正否を判断できるのは人間であり、固定すると
// 表示を変えるたびにテストを直すことになる。ここで守るのは、画面を見ても分からない
// もの（行数・識別子・状態・幅に収まること・大小関係）だけである。
//
// 理由と経緯: docs/adr/0033-do-not-pin-rendered-appearance-in-tests.md

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { beforeEach, test } = require('node:test');

const workerStatus = require('../scripts/worker-status');
const workerLiveness = require('../scripts/shared/worker-liveness');
const { createResourceLiveness } = require('./helpers/process-liveness-test-double');
const paneLaunch = require('../scripts/shared/pane-launch');
const { cleanSpawnEnv } = require('./_spawn-env');
const { installWeztermCommandPorts, weztermCall } = require('./_wezterm-command-recorder');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'worker-status.js');
const DEFAULT_TEST_START_TIME = '2026-08-26T11:55:00.000Z';
let testProbePid = () => 'alive';
let testReadStartTime = (_pid, expectedStartTime) => expectedStartTime || DEFAULT_TEST_START_TIME;
let testWorkerPredicate = null;

function installTestLiveness() {
  workerStatus._setLiveness(workerStatus.createWorkerStatusLiveness({
    probePid: (pid) => testWorkerPredicate
      ? (testWorkerPredicate({ pid }) ? 'alive' : 'dead')
      : testProbePid(pid),
    readStartTime: testReadStartTime,
  }));
}

function setTestReadStartTime(fn) {
  testReadStartTime = fn || ((_pid, expectedStartTime) => expectedStartTime || DEFAULT_TEST_START_TIME);
  installTestLiveness();
}

function setTestProbePid(fn) {
  testProbePid = fn ? (pid) => (fn(pid) ? 'alive' : 'dead') : () => 'alive';
  testWorkerPredicate = null;
  installTestLiveness();
}

function setTestWorkerPredicate(fn) {
  testWorkerPredicate = fn;
  installTestLiveness();
}

const STATUS_PANE_CONTEXT = Object.freeze({
  unixSocket: 'C:\\wezterm\\test-socket',
  targetPaneId: 'base-pane',
});

function listCall(result, connection) {
  const env = { ...process.env };
  delete env.GH_MAESTRO_WORKSPACE;
  env.WEZTERM_UNIX_SOCKET = connection.unixSocket;
  return weztermCall(
    ['cli', '--no-auto-start', 'list', '--format', 'json'],
    result,
    { env },
  );
}

// status/list の実CLI境界は維持する。各子プロセスの初期化で発生する
// process-lifecycle のWindows WMI照会だけを固定観測へ差し替え、PIDだけの
// 表示ケースを不要なPowerShell待ちから分離する。PID再利用の同一性は
// process-lifecycle.test.js とこのファイルの明示的なidentityケースで検証する。
const FAST_STATUS_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-worker-status-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../scripts/process-lifecycle');
  const source = [
    "'use strict';",
    `const childProcess = require(${JSON.stringify(childProcessPath)});`,
    "const fixedStartTime = '2026-07-25T00:00:00.000Z';",
    'const realExecSync = childProcess.execSync;',
    'childProcess.execSync = (command, opts) => {',
    "  if (String(command).includes('Get-CimInstance Win32_Process')) return `${fixedStartTime}\\n`;",
    '  return realExecSync(command, opts);',
    '};',
    `const lifecycle = require(${JSON.stringify(lifecyclePath)});`,
    'lifecycle.findRunningInstances = () => [];',
  ].join('\n');
  fs.writeFileSync(file, source, 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return file;
})();

// Most unit-style collectWorkersStatus cases do not exercise review-job
// discovery.  Avoid launching the platform process scanner for those cases;
// the final review-job integration case injects its own representative data.
beforeEach(() => {
  testProbePid = () => 'alive';
  testReadStartTime = (_pid, expectedStartTime) => expectedStartTime || DEFAULT_TEST_START_TIME;
  testWorkerPredicate = null;
  installTestLiveness();
  workerStatus._setFindRunningInstances(() => []);
// Review-manager fixtures below inject their liveness observations; the
// non-identity-focused cases use a deterministic checker instead of WMI.
  // pane の各入力・出力ケースは、明示的な lock 拒否ケース以外では
  // ロック取得のOS照会を検証対象にしない。実際の lock 拒否は専用ケースで
  // false を注入して確認する。
  workerStatus._setAcquireStatusPaneLock(() => true);
  workerStatus._setReleaseStatusPaneLock(() => {});
  workerStatus._setGetCurrentPaneTarget(() => ({ ...STATUS_PANE_CONTEXT }));
});

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

function writeReviewManager(workspace, pr, pid, startTime = '2026-08-26T11:55:00.000Z') {
  const file = path.join(workspace, '.gh-maestro', 'records', 'pr', String(pr), 'review', 'manager.running');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    pid,
    resourceKey: `review-manager-${pr}`,
    instanceId: `review-manager-${pr}-instance`,
    startTime,
  }), 'utf8');
  return file;
}

function removeWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function runCli(args) {
  return spawnSync(process.execPath, ['-r', FAST_STATUS_PRELOAD, SCRIPT, ...args], {
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
  assert.match(workerStatus.CLI_USAGE, /socketの消滅/);
  assert.match(workerStatus.CLI_USAGE, /rebind/);
  assert.match(workerStatus.CLI_USAGE, /見出しとワーカー行/);
  assert.doesNotMatch(workerStatus.CLI_USAGE, /6区間/);
  assert.doesNotMatch(workerStatus.CLI_USAGE, /cycle metrics/);
});

test('main: --help は code 0 で usage を返し、新しい説明を含み旧来の文言を含まない', () => {
  const result = runMain(['--help']);
  assert.equal(result.code, 0);
  const helpText = result.lines.join('\n');
  assert.match(helpText, /worker-status\.js/);
  assert.match(helpText, /list\s+見出しとワーカーの稼働状況を表示する/);
  assert.match(helpText, /watch\s+見出しとワーカー行を画面クリアしながら定期更新する/);
  assert.match(helpText, /見出しとワーカー行/);
  assert.doesNotMatch(helpText, /6区間/);
  assert.doesNotMatch(helpText, /cycle metrics/);
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
  setTestProbePid((pid) => pid === process.pid);
  try {
    writeWorkers(workspace, {
      alive: require('../scripts/shared/process-liveness').writeRef({}, require('../scripts/shared/process-liveness').captureSelf()),
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
  assert.ok(single[0].includes('#403') && single[0].includes('worker-1') && single[0].includes('claude-code'));

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
  assert.ok(multi[0].includes('long-worker') && multi[0].includes('gemini-cli') && multi[0].includes('(pid: 1001)'));
  assert.ok(multi[1].includes('half-worker') && multi[1].includes('codex') && multi[1].includes('(pid: 1002)'));
  assert.ok(multi[2].includes('legacy-w') && multi[2].includes('[stopped]') && multi[2].includes('(pid: 1003)'));
  const barLength = line => (line.match(/█+/) || [''])[0].length;
  assert.ok(barLength(multi[0]) > barLength(multi[1]));

  const defaultWidthLines = workerStatus.renderUptimeBars([
    { workerName: 'issue-403-default-long', running: true, elapsedSeconds: 600, pid: 1004 },
    { workerName: 'issue-403-default-short', running: true, elapsedSeconds: 300, pid: 1005 },
  ]);
  assert.ok(barLength(defaultWidthLines[0]) > barLength(defaultWidthLines[1]));
  assert.ok(defaultWidthLines.every(line => Array.from(line).length <= 120));
});

test('snapshot: 見出しと最大4行のワーカー行（役職・モデル・時間・PID）を表示する', () => {
  const start = Date.parse('2026-08-26T00:00:00.000Z');
  const events = [
    { schemaVersion: 1, issue: 450, event: 'issue-created', at: new Date(start).toISOString() },
    { schemaVersion: 1, issue: 450, event: 'worker-started', at: new Date(start + 240000).toISOString(), workerName: 'issue-450-senior-coder-cycle-metrics', role: 'senior-coder', agentId: 'codex-luna-max', pid: 16924, startTime: new Date(start + 240000).toISOString() },
    { schemaVersion: 1, issue: 450, event: 'plan-reported', at: new Date(start + 780000).toISOString() },
    { schemaVersion: 1, issue: 450, event: 'implementation-approved', at: new Date(start + 2700000).toISOString() },
    { schemaVersion: 1, issue: 450, event: 'pr-created', at: new Date(start + 3060000).toISOString(), pr: 99 },
    { schemaVersion: 1, issue: 450, event: 'worker-stopped', at: new Date(start + 960000).toISOString(), workerName: 'issue-450-senior-coder-cycle-metrics', pid: 16924, exitCode: 0, abnormal: false },
  ];
  const lines = workerStatus.renderSnapshotLines('C:/temporary-workspace', 450, {
    cycleEvents: events,
    currentWorkers: [{
      workerName: 'issue-450-senior-coder-cycle-metrics',
      issue: 450,
      role: 'senior-coder',
      agentId: 'codex-luna-max',
      pid: 16924,
      running: false,
      startTime: null,
      elapsedSeconds: 0,
      durationKnown: false,
    }],
    now: start + 3600000,
    maxLineWidth: 120,
  });
  // 見た目（見出しの文言・区切り・バー・時間の書式）は検証しない。
  // 変えるたびにテストを直すことになるため、ワーカー行が1行だけ出ることと、
  // そこに識別に要る情報が載っていることだけを見る。
  const workerLines = lines.slice(1);
  assert.equal(workerLines.length, 1);
  assert.ok(workerLines[0].includes('senior-coder'));
  assert.ok(workerLines[0].includes('16924'));
  assert.ok(!workerLines[0].includes('issue-450-'));

  // A directly constructed projection is used for the width boundary below; the
  // assertion is intentionally about the rendered boundary, not the event fixture.
  const intervalProjection = require('../scripts/shared/cycle-metrics').intervalProjection(events);
  const narrowLine = workerStatus.renderUptimeBars(intervalProjection.intervals, {
    mode: 'interval', issue: 450, totalSeconds: intervalProjection.totalSeconds, maxLineWidth: 60,
  })[0];
  // 幅に収まることだけを見る。何を削ってどう詰めるかは見た目の問題であり、
  // 変えるたびにテストを直すことになるため検証しない。
  assert.ok(narrowLine.length <= 60);

  const fullLine = workerStatus.renderUptimeBars(intervalProjection.intervals, {
    mode: 'interval', issue: 450, totalSeconds: intervalProjection.totalSeconds, maxLineWidth: 120,
  })[0];
  assert.ok(Array.from(fullLine).length <= 120);

});

test('renderWorkerRows: 稼働優先・resume回数・状態ドット色・残数を表示する', () => {
  const lines = workerStatus.renderWorkerRows([
    { role: 'senior-coder', runNumber: 2, agentId: 'codex', running: true, durationKnown: true, elapsedSeconds: 180, pid: 2, startTime: '2026-08-26T01:00:00Z' },
    { role: 'explorer', agentId: 'agy', running: true, durationKnown: true, elapsedSeconds: 60, pid: 3, startTime: '2026-08-26T01:10:00Z' },
    { role: 'review-manager', agentId: 'agy', running: false, abnormal: true, durationKnown: true, elapsedSeconds: 30, pid: 4, startTime: '2026-08-26T01:20:00Z' },
    { role: 'architect', agentId: 'agy', running: false, durationKnown: true, elapsedSeconds: 30, pid: 5, startTime: '2026-08-26T01:30:00Z' },
    { role: 'coder', agentId: 'agy', running: false, durationKnown: true, elapsedSeconds: 30, pid: 6, startTime: '2026-08-26T01:40:00Z' },
  ], { maxRows: 4, colorize: true });

  assert.equal(lines.length, 4);
  // 見た目（丸印の個数・空白の詰め方・書式）は固定しない（docs/adr/0033）。状態と識別子だけを見る。
  assert.ok(lines[0].includes('senior-coder x2') && lines[0].includes('[codex]') && lines[0].includes('(pid: 2)'));
  assert.ok(lines[1].includes('explorer') && lines[1].includes('(pid: 3)'));
  assert.ok(lines[2].includes('review-manager') && lines[2].includes('(pid: 4)'));
  assert.ok(lines[3].includes('architect') && lines[3].includes('(pid: 5)') && lines[3].includes('+1件'));
  assert.ok(lines.every(line => !line.includes('[running]') && !line.includes('[stopped]') && !line.includes('█')));
});

test('mergeCycleWorkers: PID変更後は現在runの状態だけを採用し、履歴の異常停止を持ち越さない', () => {
  const resumedWorkerName = 'issue-478-coder-pane-dot-state';
  const resumedStart = '2026-09-07T05:00:00.000Z';
  const activeStart = '2026-09-07T05:10:00.000Z';
  const stoppedWorkerName = 'issue-478-abnormal-stop';
  const stoppedStart = '2026-09-07T05:20:00.000Z';

  const merged = workerStatus.mergeCycleWorkers([
    {
      workerName: resumedWorkerName,
      pid: 101,
      startTime: resumedStart,
      running: false,
      abnormal: true,
      elapsedSeconds: 60,
    },
    {
      workerName: resumedWorkerName,
      pid: 202,
      startTime: activeStart,
      running: true,
      abnormal: false,
      elapsedSeconds: 120,
    },
    {
      workerName: stoppedWorkerName,
      pid: 303,
      startTime: stoppedStart,
      running: false,
      abnormal: true,
      elapsedSeconds: 30,
    },
  ], [
    {
      workerName: resumedWorkerName,
      pid: 202,
      startTime: activeStart,
      running: true,
      elapsedSeconds: 45,
    },
    {
      workerName: stoppedWorkerName,
      pid: 303,
      startTime: null,
      running: false,
      elapsedSeconds: 0,
    },
  ]);

  const resumed = merged.find(worker => worker.workerName === resumedWorkerName);
  assert.equal(resumed.running, true);
  assert.equal(resumed.abnormal, false);

  const stopped = merged.find(worker => worker.workerName === stoppedWorkerName);
  assert.equal(stopped.running, false);
  assert.equal(stopped.abnormal, true);
});

test('workerStatusKind: 稼働状態を異常状態より優先する', () => {
  assert.equal(workerStatus.workerStatusKind({ running: true, abnormal: true }), 'running');
  assert.equal(workerStatus.workerStatusKind({ running: false, abnormal: true }), 'abnormal');
  assert.equal(workerStatus.workerStatusKind({ running: false, abnormal: false }), 'stopped');
});

test('renderWorkerRows: 子行があっても最後の表示ワーカーに非表示件数を付ける', () => {
  const lines = workerStatus.renderWorkerRows([
    {
      role: 'review-manager',
      agentId: 'codex',
      running: true,
      durationKnown: true,
      elapsedSeconds: 300,
      pid: 222,
      startTime: '2026-08-26T00:00:00Z',
      jobs: [{
        jobId: 'job-1',
        aspect: 'Correctness',
        agentId: 'codex',
        running: true,
        durationKnown: true,
        elapsedSeconds: 120,
        pid: 333,
        startTime: '2026-08-26T00:03:00Z',
      }],
    },
    {
      role: 'explorer',
      agentId: 'codex',
      running: true,
      durationKnown: true,
      elapsedSeconds: 60,
      pid: 444,
      startTime: '2026-08-26T00:04:00Z',
    },
  ], { maxRows: 1 });

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('review-manager') && lines[0].includes('[codex]') && lines[0].includes('(pid: 222)') && lines[0].includes('+1件'));
  assert.match(lines[1], /^  └─ job-1 \(Correctness\)/);
});

test('renderWorkerRows: role と agent を含む行を出し、suffixはASCII xNにする', () => {
  // 列の桁位置は見た目であり検査しない（ADR-0033）。検査するのは内容（役割・suffix の表記）。
  const lines = workerStatus.renderWorkerRows([
    { role: 'coder', agentId: 'a', running: true, durationKnown: true, elapsedSeconds: 60, pid: 1 },
    { role: 'senior-coder', runNumber: 2, agentId: 'long-agent', running: true, durationKnown: true, elapsedSeconds: 120, pid: 2 },
  ]);
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plain[0].includes('coder') && plain[1].includes('senior-coder'));
  assert.match(plain[1], /senior-coder x2/);
  assert.ok(!plain.join('\n').includes('×'));
});

test('renderSnapshotLines: 同一ワーカーのrunを1行へ畳み、最新PIDを表示する', () => {
  const base = Date.parse('2026-08-26T00:00:00.000Z');
  const events = [
    { schemaVersion: 1, issue: 467, event: 'worker-started', at: new Date(base).toISOString(), workerName: 'issue-467-senior-coder-status-rows', role: 'senior-coder', agentId: 'codex', pid: 101, startTime: new Date(base).toISOString() },
    { schemaVersion: 1, issue: 467, event: 'worker-stopped', at: new Date(base + 300000).toISOString(), workerName: 'issue-467-senior-coder-status-rows', pid: 101, exitCode: 0, abnormal: false },
    { schemaVersion: 1, issue: 467, event: 'worker-started', at: new Date(base + 600000).toISOString(), workerName: 'issue-467-senior-coder-status-rows', role: 'senior-coder', agentId: 'codex', pid: 202, startTime: new Date(base + 600000).toISOString() },
  ];
  const lines = workerStatus.renderSnapshotLines('C:/temporary-workspace', 467, {
    cycleEvents: events,
    currentWorkers: [{
      workerName: 'issue-467-senior-coder-status-rows',
      role: 'senior-coder',
      agentId: 'codex',
      pid: 202,
      running: true,
      startTime: new Date(base + 600000).toISOString(),
      elapsedSeconds: 60,
      durationKnown: true,
      issue: 467,
    }],
    now: base + 660000,
  });

  // run が2つあっても行は1つ。見た目ではなく行数と載っている値だけを見る。
  const collapsed = lines.slice(1);
  assert.equal(collapsed.length, 1);
  assert.equal((collapsed[0].match(/senior-coder/g) || []).length, 1);
  assert.ok(collapsed[0].includes('202'));

  const workspace = createWorkspace('gh-maestro-worker-status-no-stop-event-');
  workerStatus._setNow(() => base + 660000);
  workerStatus._setReadCycleEvents(() => [{
    schemaVersion: 1,
    issue: 467,
    event: 'worker-started',
    at: new Date(base).toISOString(),
    workerName: 'issue-467-senior-coder-status-rows',
    role: 'senior-coder',
    agentId: 'codex',
    pid: 999999999,
    startTime: new Date(base).toISOString(),
  }]);
  setTestWorkerPredicate(null);
  try {
    writeWorkers(workspace, {
      'issue-467-senior-coder-status-rows': {
        pid: 999999999,
        issue: 467,
        agentId: 'codex',
      },
    });

    const stoppedWithoutEvent = runMain([
      'watch', '--workspace', workspace, '--issue', '467', '--interval', '5',
    ]);
    assert.equal(stoppedWithoutEvent.code, 0);
    // 実在しないPIDなので停止として扱われること。行の見た目は検証しない。
    const stoppedLine = stoppedWithoutEvent.lines[1];
    assert.ok(stoppedLine.includes('senior-coder'));
    assert.ok(stoppedLine.includes('999999999'));
    assert.ok(stoppedLine.includes('senior-coder'));
  } finally {
    workerStatus._setNow(null);
    workerStatus._setReadCycleEvents(null);
    setTestWorkerPredicate(null);
    removeWorkspace(workspace);
  }
});

test('renderSnapshotLines: Review ManagerのworkerNameとstartTime基準が異なっても同一PID・PRを1行へ統合する', () => {
  const base = Date.parse('2026-09-17T00:00:00.000Z');
  const lines = workerStatus.renderSnapshotLines('C:/temporary-workspace', 563, {
    cycleEvents: [{
      schemaVersion: 1,
      issue: 563,
      event: 'worker-started',
      at: new Date(base).toISOString(),
      workerName: 'issue-563-review-manager-pr-415',
      role: 'review-manager',
      agentId: 'codex',
      pid: 4150,
      startTime: new Date(base).toISOString(),
      pr: 415,
    }],
    currentWorkers: [{
      workerName: 'review-manager-pr-415',
      role: 'review-manager',
      agentId: 'codex',
      pid: 4150,
      running: true,
      startTime: new Date(base + 30000).toISOString(),
      elapsedSeconds: 30,
      durationKnown: true,
      pr: 415,
      jobs: [{
        jobId: 'job-415-1',
        aspect: 'Correctness',
        agentId: 'codex',
        pid: 4151,
        running: true,
        startTime: new Date(base + 10000).toISOString(),
        elapsedSeconds: 20,
        durationKnown: true,
      }],
    }],
    now: base + 60000,
  });

  const workerLines = lines.slice(1);
  assert.equal(workerLines.length, 2);
  assert.equal((workerLines[0].match(/review-manager/g) || []).length, 1);
  assert.ok(workerLines[0].includes('(pid: 4150)'));
  assert.ok(workerLines[1].includes('job-415-1') && workerLines[1].includes('(pid: 4151)'));
});

test('mergeCycleWorkers: Review Managerのcycle eventにPIDが無ければ同一runと断定しない', () => {
  const merged = workerStatus.mergeCycleWorkers([{
    workerName: 'issue-563-review-manager-pr-415',
    role: 'review-manager',
    pr: 415,
    startTime: '2026-09-17T00:00:00.000Z',
    running: true,
  }], [{
    workerName: 'review-manager-pr-415',
    role: 'review-manager',
    pr: 415,
    pid: 4150,
    startTime: '2026-09-17T00:00:30.000Z',
    running: true,
    elapsedSeconds: 30,
    durationKnown: true,
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].runNumber, 2);
  assert.equal(merged[0].pid, 4150);
});

test('renderWorkerRows: Review Managerのジョブを監視用の子行として描画する', () => {
  const lines = workerStatus.renderWorkerRows([{
    role: 'review-manager',
    agentId: 'codex',
    running: true,
    durationKnown: true,
    elapsedSeconds: 300,
    pid: 222,
    startTime: '2026-08-26T00:00:00Z',
    jobs: [{
      jobId: 'job-1',
      aspect: 'Correctness',
      agentId: 'codex',
      running: true,
      durationKnown: true,
      elapsedSeconds: 120,
      pid: 333,
      startTime: '2026-08-26T00:03:00Z',
    }],
  }]);

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('review-manager') && lines[0].includes('[codex]') && lines[0].includes('(pid: 222)'));
  assert.ok(lines[1].includes('job-1 (Correctness)') && lines[1].includes('[codex]') && lines[1].includes('(pid: 333)'));
});

test('main: list は見出しと最大4件のワーカー行を出力する', () => {
  const workspace = createWorkspace();
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestWorkerPredicate((rawEntry) => rawEntry && rawEntry.pid !== 999999999);
  setTestReadStartTime((pid) => {
    if (pid === 111) return '2026-08-26T11:50:00.000Z'; // 600s ago
    if (pid === 222) return '2026-08-26T11:55:00.000Z'; // 300s ago
    return null;
  });

  try {
    writeWorkers(workspace, {
      'issue-100-worker-a': { pid: 111, startTime: '2026-08-26T11:50:00.000Z', issue: 100, agentId: 'agent-1' },
      'issue-100-worker-b': { pid: 222, startTime: '2026-08-26T11:55:00.000Z', issue: 100, agentId: 'agent-2' },
      'worker-c': { pid: 999999999 }, // stopped, no issue/agentId
    });

    const result = runMain(['list', '--workspace', workspace]);
    assert.equal(result.code, 0);
    assert.equal(result.errLines.length, 0);
    assert.equal(result.lines.length, 4);
    assert.ok(result.lines[0].includes('#100'));
    assert.ok(result.lines[1].includes('worker-a') && result.lines[1].includes('(pid: 111)'));
    assert.ok(result.lines[2].includes('worker-b') && result.lines[2].includes('(pid: 222)'));
    // 停止ワーカーの行が消えないこと。桁や空白の並びは見た目なので検査しない（ADR-0033）。
    assert.ok(result.lines[3].includes('worker-c') && result.lines[3].includes('(pid: 999999999)'));
  } finally {
    workerStatus._setNow(null);
    setTestWorkerPredicate(null);
    setTestReadStartTime(null);
    removeWorkspace(workspace);
  }
});

test('main: list --json は機械可読な JSON 配列を出力する', () => {
  const workspace = createWorkspace();
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestWorkerPredicate((rawEntry) => rawEntry && rawEntry.pid === 111);
  setTestReadStartTime((pid) => {
    if (pid === 111) return '2026-08-26T11:50:00.000Z';
    return null;
  });

  try {
    writeWorkers(workspace, {
      'worker-a': { pid: 111, startTime: '2026-08-26T11:50:00.000Z' },
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
    setTestWorkerPredicate(null);
    setTestReadStartTime(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: PID-only worker record is unknown and does not capture a replacement identity', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-pid-only-');
  let probeCalls = 0;
  let pidProbeCalls = 0;
  // PID の照会と endpoint の照会の回数を数える（どちらも呼ばれないことを検査する）
  workerStatus._setLiveness(createResourceLiveness({
    probePid: () => { pidProbeCalls++; return 'alive'; },
    probeEndpoint: () => { probeCalls++; return 'alive'; },
  }));

  try {
    writeWorkers(workspace, { 'worker-legacy': { pid: 4242 } });
    const workers = workerStatus.collectWorkersStatus(workspace);
    assert.equal(workers[0].running, false);
    assert.equal(workers[0].startTime, null);
    assert.equal(probeCalls, 0, 'a PID-only record has no resource endpoint to probe');
    assert.equal(pidProbeCalls, 0, 'a PID-only record is not checked by PID (PID reuse), so no replacement identity is captured');
  } finally {
    workerStatus._setLiveness(null);
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
  let startTimeCalls = 0;
  workerStatus._setLiveness(null);

  try {
    writeWorkers(workspace, { 'worker-a': { pid: 111, startTime: '2026-08-26T11:55:00.000Z' } });

    // ループ開始
    const handle = workerStatus.runWatchLoop(workspace, 2, {
      stdout: fakeStdout,
      stderr: fakeStderr,
      setIntervalFn: fakeSetInterval,
      clearIntervalFn: fakeClearInterval,
      onSignalFn: fakeOnSignal,
      exitFn: fakeExit,
      probePid: (pid) => pid === 111 ? 'alive' : 'dead',
      readStartTime: (pid) => {
        assert.equal(pid, 111);
        startTimeCalls++;
        return '2026-08-26T11:55:00.000Z';
      },
    });

    // 1. 初回描画の検証（intervalMs, 画面クリア, ヘッダー, サイクル行）
    assert.equal(timerIntervalMs, 2000);
    assert.equal(handle.timer, 12345);
    const initialOutput = stdoutChunks.join('');
    assert.match(initialOutput, /\x1b\[2J\x1b\[H/); // ANSI画面クリア
    assert.match(initialOutput, /issue#\?/);
    assert.doesNotMatch(initialOutput, /interval:|21:00:00/);
    assert.doesNotMatch(initialOutput, /準備 \| 計画 \| 承認 \| 実装 \| 査読 \| 統合/);
    assert.match(initialOutput, /worker-a\s+\[-\]\s+.*\(pid: 111\)/);
    assert.equal(startTimeCalls, 0, '生存確認はプロセス起動時刻を照会しない');

    // 2. タイマーコールバック実行（定期再描画）
    stdoutChunks.length = 0;
    currentTime += 2000; // 2秒経過
    assert.ok(typeof timerCallback === 'function');
    timerCallback();

    const secondOutput = stdoutChunks.join('');
    assert.match(secondOutput, /\x1b\[2J\x1b\[H/);
    assert.match(secondOutput, /issue#\?/);
    assert.doesNotMatch(secondOutput, /interval:|21:00:02/);
    assert.doesNotMatch(secondOutput, /準備 \| 計画 \| 承認 \| 実装 \| 査読 \| 統合/);
    assert.match(secondOutput, /worker-a\s+\[-\]\s+.*\(pid: 111\)/);
    assert.equal(startTimeCalls, 0, '再描画でもプロセス起動時刻を照会しない');

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
    workerStatus._setLiveness(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: 各観測でOS resourceを確認し、消失したworkerを停止表示する', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-start-cache-');
  const originalStartTime = '2026-08-26T11:55:00.000Z';
  let processAlive = true;
  let verifyCalls = 0;
  const liveness = workerStatus.createWorkerStatusLiveness({
    probePid: (pid) => {
      verifyCalls++;
      assert.equal(pid, 111);
      return processAlive ? 'alive' : 'dead';
    },
  });

  try {
    writeWorkers(workspace, {
      'worker-a': { pid: 111, startTime: originalStartTime },
    });

    const collectAt = (now) => {
      return workerStatus.collectWorkersStatus(workspace, { nowFn: () => now, liveness });
    };

    const first = collectAt(0);
    assert.equal(first[0].running, true);
    assert.equal(first[0].startTime, originalStartTime);
    assert.equal(verifyCalls, 1);

    const beforeExpiry = collectAt(2);
    assert.equal(beforeExpiry[0].running, true);
    assert.equal(beforeExpiry[0].startTime, originalStartTime);
    assert.equal(verifyCalls, 2, '観測ごとにOS resourceを再確認する');

    processAlive = false;
    const afterExpiry = collectAt(3);
    assert.equal(afterExpiry[0].running, false);
    assert.equal(afterExpiry[0].startTime, null);
    assert.equal(verifyCalls, 3, 'resource消失を次の観測で検出する');
    assert.match(workerStatus.renderUptimeBars(afterExpiry)[0], /\[stopped\]/);
  } finally {
    workerLiveness._setLiveness(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: OS resourceの観測がunknownなら状態をunknownとしてエラーにする', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-start-cache-null-');
  const registeredStartTime = '2026-08-26T11:55:00.000Z';
  let verifyCalls = 0;
  const liveness = workerStatus.createWorkerStatusLiveness({
    probePid: (pid) => {
      verifyCalls++;
      assert.equal(pid, 114);
      return 'unknown';
    },
  });

  try {
    writeWorkers(workspace, {
      'worker-a': { pid: 114, startTime: registeredStartTime },
    });

    const collectAt = (now) => {
      return workerStatus.collectWorkersStatus(workspace, { nowFn: () => now, liveness });
    };

    assert.throws(() => collectAt(0), /unknown/);
    assert.equal(verifyCalls, 1);

    assert.throws(() => collectAt(2), /unknown/);
    assert.equal(verifyCalls, 2);

    assert.throws(() => collectAt(3), /unknown/);
    assert.equal(verifyCalls, 3);
  } finally {
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: プロセス終了時はキャッシュを破棄して停止表示にする', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-start-cache-dead-');
  const startTime = '2026-08-26T11:55:00.000Z';
  let processAlive = true;
  let currentNow = 0;
  const liveness = workerStatus.createWorkerStatusLiveness({
    probePid: () => processAlive ? 'alive' : 'dead',
    nowFn: () => currentNow,
  });

  try {
    writeWorkers(workspace, {
      'worker-a': { pid: 112, startTime },
    });

    const collectAt = (now) => {
      currentNow = now;
      return workerStatus.collectWorkersStatus(workspace, { nowFn: () => now, liveness });
    };

    assert.equal(collectAt(0)[0].running, true);

    processAlive = false;
    const stopped = collectAt(3_000);
    assert.equal(stopped[0].running, false);
    assert.equal(stopped[0].startTime, null);
    assert.match(workerStatus.renderUptimeBars(stopped)[0], /\[stopped\]/);
  } finally {
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: Review ManagerもOS resourceで毎回観測する', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-start-cache-rm-');
  const firstStartTime = '2026-08-26T11:55:00.000Z';
  let managerAlive = true;
  let verifyCalls = 0;
  const liveness = workerStatus.createWorkerStatusLiveness({
    probePid: () => {
      verifyCalls++;
      return managerAlive ? 'alive' : 'dead';
    },
  });

  try {
    writeReviewManager(workspace, 407, 113, firstStartTime);

    const collectAt = (now) => {
      return workerStatus.collectWorkersStatus(workspace, { nowFn: () => now, liveness });
    };

    const first = collectAt(0);
    assert.equal(first[0].startTime, firstStartTime);
    const beforeExpiry = collectAt(2);
    assert.equal(beforeExpiry[0].startTime, firstStartTime);
    assert.equal(verifyCalls, 2);

    managerAlive = false;
    const afterExpiry = collectAt(3);
    assert.equal(afterExpiry.length, 0, '期限到達後にPID再利用を検出してRMを非表示にする');
    assert.equal(verifyCalls, 3);
  } finally {
    removeWorkspace(workspace);
  }
});

test('main: watch はスナップショットを先頭行から出力し、現在時刻ヘッダーを含めない', () => {
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
    // 見た目は検証しない。現在時刻と更新間隔が混ざらないことだけを見る。
    assert.ok(result.lines.some(line => line.includes('worker-a')));
    assert.doesNotMatch(result.lines.join('\n'), /interval:|12:15:30/);
  } finally {
    workerStatus._setNow(null);
    removeWorkspace(workspace);
  }
});

test('main: list --json と watch は同じ収集結果のワーカー集合・生死を表示する', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-list-watch-');
  const fixedNow = new Date('2026-08-26T03:15:30.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestWorkerPredicate(() => false);

  try {
    writeWorkers(workspace, {
      'issue-467-stopped-worker': { pid: 999, issue: 467, agentId: 'codex' },
    });

    const listResult = runMain(['list', '--workspace', workspace, '--json']);
    assert.equal(listResult.code, 0);
    const listed = JSON.parse(listResult.lines.join('\n'));
    assert.deepEqual(listed.map(worker => ({ workerName: worker.workerName, running: worker.running })), [
      { workerName: 'issue-467-stopped-worker', running: false },
    ]);

    const watchResult = runMain(['watch', '--workspace', workspace, '--interval', '5']);
    assert.equal(watchResult.code, 0);
    const workerLines = watchResult.lines.slice(1);
    assert.equal(workerLines.length, 1);
    assert.ok(workerLines[0].includes('stopped-worker'));
    assert.ok(workerLines[0].includes('999'));
  } finally {
    workerStatus._setNow(null);
    setTestWorkerPredicate(null);
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

test('main: pane の保証ロックを取得できない場合は起動せず code 1', () => {
  const workspace = createWorkspace();
  let launchCalled = false;
  workerStatus._setAcquireStatusPaneLock(() => false);
  workerStatus._setLaunchInSplitPane(() => {
    launchCalled = true;
    return { paneId: 'never' };
  });

  try {
    const result = runMain(['pane', '--workspace', workspace]);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /監視ペインの保証に失敗しました/);
    assert.equal(launchCalled, false);
  } finally {
    workerStatus._setAcquireStatusPaneLock(null);
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
  let aliveConnection = null;
  workerStatus._setIsPaneAlive((id, connection) => {
    aliveConnection = connection;
    return aliveSet.has(String(id));
  });

  try {
    // 1回目の実行: split-pane が呼ばれ、status-pane.json が保存される
    const result1 = runMain(['pane', '--workspace', workspace]);
    assert.equal(result1.code, 0);
    assert.equal(result1.paneId, '201');
    assert.equal(result1.reused, false);
    assert.equal(launchCallCount, 1);
    assert.match(result1.lines[0], /STATUS_PANE_LAUNCHED: pane=201/);
    const registry = require('../scripts/shared/status-pane-registry').loadStatusPane(workspace);
    assert.deepEqual(registry, {
      paneId: '201',
      ...STATUS_PANE_CONTEXT,
      launchedAt: registry.launchedAt,
    });
    assert.equal(Object.hasOwn(JSON.parse(
      fs.readFileSync(require('../scripts/shared/status-pane-registry').statusPanePath(workspace), 'utf8'),
    ), 'pid'), false);

    // 2回目の実行: 既存ペインが生存しているため launchInSplitPane は呼ばれず再利用される
    const result2 = runMain(['pane', '--workspace', workspace]);
    assert.equal(result2.code, 0);
    assert.equal(result2.paneId, '201');
    assert.equal(result2.reused, true);
    assert.equal(launchCallCount, 1); // 呼ばれていないことを検証
    assert.deepEqual(aliveConnection, {
      ...STATUS_PANE_CONTEXT,
    });
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

test('main: pane は消滅した記録接続先を現在のWezTermへrebindする', () => {
  const workspace = createWorkspace();
  const statusRegistry = require('../scripts/shared/status-pane-registry');
  statusRegistry.saveStatusPane(workspace, {
    paneId: 'stale-pane',
    unixSocket: path.join(workspace, 'deleted-socket'),
    targetPaneId: 'old-target',
    issue: '568',
  });
  installWeztermCommandPorts({
    listPanes: [listCall(
      { status: 1, stdout: '', stderr: 'failed to connect' },
      { unixSocket: path.join(workspace, 'deleted-socket') },
    )],
  });
  let launchParams = null;
  workerStatus._setIsPaneAlive(null);
  workerStatus._setLaunchInSplitPane((params) => {
    launchParams = params;
    return { paneId: 'rebound-pane' };
  });

  try {
    const result = runMain(['pane', '--workspace', workspace, '--issue', '569']);
    assert.equal(result.code, 0);
    assert.equal(result.paneId, 'rebound-pane');
    assert.equal(result.reused, false);
    assert.deepEqual(launchParams.connection, STATUS_PANE_CONTEXT);
    assert.equal(launchParams.targetPaneId, STATUS_PANE_CONTEXT.targetPaneId);
    assert.deepEqual(statusRegistry.loadStatusPane(workspace), {
      paneId: 'rebound-pane',
      ...STATUS_PANE_CONTEXT,
      issue: '569',
      launchedAt: statusRegistry.loadStatusPane(workspace).launchedAt,
    });
  } finally {
    paneLaunch._setWeztermListPanes(null);
    workerStatus._setIsPaneAlive(null);
    workerStatus._setLaunchInSplitPane(null);
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
    runMain(['pane', '--workspace', workspace, '--issue', '471']);

    // close-pane
    const result = runMain(['close-pane', '--workspace', workspace, '--issue', '471']);
    assert.equal(result.code, 0);
    assert.equal(result.paneId, '401');
    assert.equal(killedId, '401');
    assert.match(result.lines[0], /STATUS_PANE_CLOSED: pane=401/);

    // 再度 close-pane: 既に削除済みなので NOT_FOUND で終了
    const resultNotFound = runMain(['close-pane', '--workspace', workspace, '--issue', '471']);
    assert.equal(resultNotFound.code, 0);
    assert.match(resultNotFound.lines[0], /STATUS_PANE_NOT_FOUND/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setIsPaneAlive(null);
    workerStatus._setKillPane(null);
    removeWorkspace(workspace);
  }
});

test('main: close-pane は異なるIssueの監視ペインを終了せず記録を維持する', () => {
  const workspace = createWorkspace();
  workerStatus._setLaunchInSplitPane(() => ({ paneId: '451' }));
  workerStatus._setIsPaneAlive(() => true);
  let killed = false;
  workerStatus._setKillPane(() => {
    killed = true;
    return { ok: true, status: 0, stderr: '' };
  });

  try {
    const launched = runMain(['pane', '--workspace', workspace, '--issue', '471']);
    assert.equal(launched.code, 0);

    const result = runMain(['close-pane', '--workspace', workspace, '--issue', '472']);
    assert.equal(result.code, 0);
    assert.match(result.lines[0], /STATUS_PANE_NOT_FOUND/);
    assert.equal(killed, false);
    const registry = require('../scripts/shared/status-pane-registry').loadStatusPane(workspace);
    assert.deepEqual(registry, {
      paneId: '451',
      ...STATUS_PANE_CONTEXT,
      issue: '471',
      launchedAt: registry.launchedAt,
    });
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

test('main: close-pane のWezTerm pane一覧照会失敗時はregistryを削除せず閉鎖成功を報告しない', () => {
  const workspace = createWorkspace();
  const statusRegistry = require('../scripts/shared/status-pane-registry');
  statusRegistry.saveStatusPane(workspace, { paneId: '551', ...STATUS_PANE_CONTEXT, issue: 471 });
  installWeztermCommandPorts({
    listPanes: [listCall(
      { status: 1, stdout: '', stderr: 'wezterm unavailable' },
      STATUS_PANE_CONTEXT,
    )],
  });
  let killCalled = false;
  workerStatus._setIsPaneAlive(null);
  workerStatus._setKillPane(() => {
    killCalled = true;
    return { ok: true, status: 0, stderr: '' };
  });

  try {
    const result = runMain(['close-pane', '--workspace', workspace, '--issue', '471']);
    assert.equal(result.code, 1);
    assert.equal(killCalled, false);
    assert.equal(result.lines.some((line) => line.includes('STATUS_PANE_CLOSED')), false);
    assert.match(result.errLines.join('\n'), /外部コマンドの照会失敗/);
    const remaining = statusRegistry.loadStatusPane(workspace);
    assert.equal(remaining.paneId, '551');
    assert.equal(remaining.unixSocket, STATUS_PANE_CONTEXT.unixSocket);
    assert.equal(remaining.targetPaneId, STATUS_PANE_CONTEXT.targetPaneId);
    assert.equal(remaining.issue, '471');
    assert.equal(typeof remaining.launchedAt, 'string');
  } finally {
    paneLaunch._setWeztermListPanes(null);
    workerStatus._setKillPane(null);
    removeWorkspace(workspace);
  }
});

test('main: pane は初回のWezTerm接続先または基準ペインを取得できなければ起動しない', () => {
  const workspace = createWorkspace();
  let launchCalled = false;
  workerStatus._setGetCurrentPaneTarget(() => null);
  workerStatus._setLaunchInSplitPane(() => {
    launchCalled = true;
    return { paneId: 'never' };
  });

  try {
    const result = runMain(['pane', '--workspace', workspace]);
    assert.equal(result.code, 1);
    assert.equal(launchCalled, false);
    assert.match(result.errLines.join('\n'), /現在のWezTerm接続先または基準pane-idを取得できません/);
  } finally {
    workerStatus._setGetCurrentPaneTarget(null);
    workerStatus._setLaunchInSplitPane(null);
    removeWorkspace(workspace);
  }
});

test('main: close-pane は記録接続先の一覧に無いpaneを削除・killせず停止する', () => {
  const workspace = createWorkspace();
  const statusRegistry = require('../scripts/shared/status-pane-registry');
  statusRegistry.saveStatusPane(workspace, { paneId: '561', ...STATUS_PANE_CONTEXT, issue: 471 });
  installWeztermCommandPorts({
    listPanes: [listCall(
      { status: 0, stdout: JSON.stringify([{ pane_id: 'other-pane' }]), stderr: '' },
      STATUS_PANE_CONTEXT,
    )],
  });
  let killCalled = false;
  workerStatus._setIsPaneAlive(null);
  workerStatus._setKillPane(() => {
    killCalled = true;
    return { ok: true, status: 0, stderr: '' };
  });

  try {
    const result = runMain(['close-pane', '--workspace', workspace, '--issue', '471']);
    assert.equal(result.code, 1);
    assert.equal(killCalled, false);
    assert.equal(result.lines.some((line) => line.includes('STATUS_PANE_CLOSED')), false);
    assert.match(result.errLines.join('\n'), /一覧にありません/);
    assert.equal(statusRegistry.loadStatusPane(workspace).paneId, '561');
  } finally {
    paneLaunch._setWeztermListPanes(null);
    workerStatus._setKillPane(null);
    removeWorkspace(workspace);
  }
});

test('main: pane は status-pane.json の保存に失敗した場合にエラーを出力し code 1 を返す', () => {
  const workspace = createWorkspace();
  workerStatus._setLaunchInSplitPane(() => ({ paneId: '601' }));
  workerStatus._setKillPane(() => ({ ok: true, status: 0, stderr: '' }));
  workerStatus._setSaveStatusPane(() => {
    throw new Error('disk full');
  });

  try {
    const result = runMain(['pane', '--workspace', workspace]);
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /監視ペイン状態の保存に失敗しました: disk full/);
  } finally {
    workerStatus._setLaunchInSplitPane(null);
    workerStatus._setKillPane(null);
    workerStatus._setSaveStatusPane(null);
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

  // 1行目: #403 coder-pane-display claude-code [running] 0:01:00 ...
  // skill 名 'gh-maestro-coder' そのものが独立列として含まれていないことを確認
  assert.ok(!lines[0].includes('gh-maestro-coder'));
  assert.ok(lines[0].includes('#403') && lines[0].includes('coder-pane-display') && lines[0].includes('claude-code') && lines[0].includes('[running]'));

  // 2行目: 欠損値は「-」「[stopped]」に縮退する（空白の並びは見た目なので検査しない、ADR-0033）
  assert.ok(lines[1].includes('unknown-prefix-worker'));
  assert.ok(lines[1].includes('[stopped]'));
  assert.ok(lines[1].includes('-'));
});


test('collectWorkersStatus: 稼働中 Review Manager を収集し、PR番号・ワーカー名・agentId を設定する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestProbePid((pid) => pid === 5001);
  setTestReadStartTime((pid) => (pid === 5001 ? '2026-08-26T11:50:00.000Z' : null));

  try {
    writeReviewManager(workspace, 404, 5001, '2026-08-26T11:50:00.000Z');

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
    setTestProbePid(null);
    setTestReadStartTime(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus / renderUptimeBars: resolveSkillAgentMap が例外を投げた場合に agentId が null / - となる縮退動作を検証する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-throw-');
  setTestReadStartTime(() => '2026-08-26T11:55:00.000Z');
  setTestProbePid((pid) => pid === 6001);
  workerStatus._setResolveSkillAgentMap(() => {
    throw new Error('config parse error');
  });

  try {
    writeReviewManager(workspace, 501, 6001);

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 1);
    assert.equal(results[0].agentId, null);

    const lines = workerStatus.renderUptimeBars(results);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^PR#501\s+review-manager-pr-501\s+-\s+\[running\]/);
  } finally {
    setTestReadStartTime(null);
    setTestProbePid(null);
    workerStatus._setResolveSkillAgentMap(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus / renderUptimeBars: skillAgentMap[\'gh-maestro-reviewer\'] が未設定・null・非文字列の場合に agentId が null / - となる縮退動作を検証する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-unset-');
  setTestReadStartTime(() => '2026-08-26T11:55:00.000Z');
  setTestProbePid(() => true);

  try {
    writeReviewManager(workspace, 601, 7001);
    writeReviewManager(workspace, 602, 7002);
    writeReviewManager(workspace, 603, 7003);

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
    setTestReadStartTime(null);
    setTestProbePid(null);
    workerStatus._setResolveSkillAgentMap(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: 死亡した Review Manager の PID は収集しない', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-dead-');
  setTestProbePid(() => false);

  try {
    const reviewDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '404', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manager.running'), JSON.stringify({
      pid: 999999999,
      resourceKey: 'dead-review-manager',
      instanceId: 'dead-review-manager-instance',
      startTime: '2025-01-01T00:00:00.000Z',
    }), 'utf8');

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 0);
  } finally {
    setTestProbePid(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: manager.running が破損・空・非数値ならエラーを報告する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-corrupt-');
  setTestWorkerPredicate((rawEntry) => rawEntry && rawEntry.pid === 111);

  try {
    writeWorkers(workspace, {
      'issue-100-worker-a': {
        pid: 111, startTime: '2026-08-26T11:50:00.000Z', issue: 100, agentId: 'agent-1',
      },
    });

    const badReviewDir1 = path.join(workspace, '.gh-maestro', 'records', 'pr', '401', 'review');
    const badReviewDir2 = path.join(workspace, '.gh-maestro', 'records', 'pr', '402', 'review');
    fs.mkdirSync(badReviewDir1, { recursive: true });
    fs.mkdirSync(badReviewDir2, { recursive: true });
    fs.writeFileSync(path.join(badReviewDir1, 'manager.running'), 'not-a-number\n', 'utf8');
    fs.writeFileSync(path.join(badReviewDir2, 'manager.running'), '', 'utf8');

    assert.throws(() => workerStatus.collectWorkersStatus(workspace), /manager\.running/);
    assert.ok(fs.existsSync(path.join(badReviewDir1, 'manager.running')));
  } finally {
    setTestWorkerPredicate(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: 複数 PR の Review Manager が同時に存在する場合それぞれ収集する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-multi-');
  setTestProbePid((pid) => pid === 101 || pid === 102);
  setTestReadStartTime(() => '2026-08-26T11:55:00.000Z');

  try {
    writeReviewManager(workspace, 10, 101);
    writeReviewManager(workspace, 20, 102);

    const results = workerStatus.collectWorkersStatus(workspace);
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.workerName === 'review-manager-pr-10' && r.pr === 10 && r.pid === 101));
    assert.ok(results.some((r) => r.workerName === 'review-manager-pr-20' && r.pr === 20 && r.pid === 102));
  } finally {
    setTestProbePid(null);
    setTestReadStartTime(null);
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
  assert.ok(lines[0].includes('#403') && lines[0].includes('worker-1') && lines[0].includes('(pid: 1001)'));
  assert.ok(lines[1].includes('PR#404') && lines[1].includes('review-manager-pr-404') && lines[1].includes('(pid: 1002)'));
});

test('main: list および list --json で Review Manager を表示する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-main-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestWorkerPredicate((rawEntry) => rawEntry && rawEntry.pid === 111);
  setTestProbePid((pid) => pid === 111 || pid === 222);
  setTestReadStartTime((pid) => {
    if (pid === 111) return '2026-08-26T11:50:00.000Z'; // 600s
    if (pid === 222) return '2026-08-26T11:55:00.000Z'; // 300s
    return null;
  });

  try {
    writeWorkers(workspace, {
      'issue-100-worker-a': {
        pid: 111, startTime: '2026-08-26T11:50:00.000Z', issue: 100, agentId: 'agent-1',
      },
    });

    fs.writeFileSync(path.join(workspace, '.gh-maestro', 'config.json'), JSON.stringify({
      skillAgentMap: { 'gh-maestro-reviewer': 'codex' },
    }), 'utf8');

    writeReviewManager(workspace, 405, 222, '2026-08-26T11:55:00.000Z');

    // 1. list (テキスト行)
    const listResult = runMain(['list', '--workspace', workspace]);
    assert.equal(listResult.code, 0);
    assert.equal(listResult.lines.length, 3);
    assert.ok(listResult.lines[0].includes('#100'));
    assert.ok(listResult.lines[1].includes('worker-a') && listResult.lines[1].includes('(pid: 111)'));
    assert.ok(listResult.lines[2].includes('review-manager') && listResult.lines[2].includes('(pid: 222)'));

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
    setTestWorkerPredicate(null);
    setTestProbePid(null);
    setTestReadStartTime(null);
    removeWorkspace(workspace);
  }
});

test('renderUptimeBars: Review Manager 配下にレビュージョブをインデントして表示する', () => {
  const workers = [
    {
      workerName: 'review-manager-pr-415',
      pr: 415,
      agentId: 'codex',
      pid: 5678,
      running: true,
      startTime: '2026-08-26T00:00:00Z',
      elapsedSeconds: 300,
      jobs: [
        {
          jobId: 'job-1',
          aspect: 'design',
          agentId: 'codex',
          pid: 5680,
          running: true,
          startTime: '2026-08-26T00:02:00Z',
          elapsedSeconds: 180,
        },
        {
          jobId: 'job-2',
          aspect: 'correctness',
          agentId: 'codex',
          pid: 5681,
          running: true,
          startTime: '2026-08-26T00:03:00Z',
          elapsedSeconds: 120,
        },
      ],
    },
  ];

  const lines = workerStatus.renderUptimeBars(workers, { maxBarWidth: 10 });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('PR#415') && lines[0].includes('review-manager-pr-415') && lines[0].includes('(pid: 5678)'));
  assert.ok(lines[1].includes('job-1 (design)') && lines[1].includes('(pid: 5680)'));
  assert.ok(lines[2].includes('job-2 (correctness)') && lines[2].includes('(pid: 5681)'));
});

test('collectWorkersStatus & main: list / --json でレビュージョブを収集・出力する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-jobs-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestProbePid((pid) => pid === 222 || pid === 333 || pid === 444);
  setTestReadStartTime((pid) => {
    if (pid === 222) return '2026-08-26T11:55:00.000Z'; // 300s
    if (pid === 333) return '2026-08-26T11:57:00.000Z'; // 180s
    if (pid === 444) return '2026-08-26T11:58:00.000Z'; // 120s
    return null;
  });
  workerStatus._setFindRunningInstances((ws, opts) => {
    return [
      {
        pid: 333,
        script: 'review-job',
        pr: 415,
        jobId: 'job-1',
        aspect: 'Design',
        leafIds: ['leaf-1'],
        agentId: 'codex',
        startTime: '2026-08-26T11:57:00.000Z',
      },
      {
        pid: 444,
        script: 'review-job',
        pr: 415,
        jobId: 'job-2',
        aspect: 'Correctness',
        leafIds: ['leaf-2'],
        agentId: 'codex',
        startTime: '2026-08-26T11:58:00.000Z',
      },
      {
        pid: 555,
        script: 'review-job',
        pr: 999, // 別PRのジョブ
        jobId: 'job-other',
        aspect: 'Security',
        startTime: '2026-08-26T11:59:00.000Z',
      },
    ];
  });

  try {
    writeReviewManager(workspace, 415, 222, '2026-08-26T11:55:00.000Z');

    // 1. collectWorkersStatus
    const collected = workerStatus.collectWorkersStatus(workspace);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].workerName, 'review-manager-pr-415');
    assert.equal(collected[0].jobs.length, 2);
    assert.equal(collected[0].jobs[0].jobId, 'job-1');
    assert.equal(collected[0].jobs[0].aspect, 'Design');
    assert.equal(collected[0].jobs[0].pid, 333);
    assert.equal(collected[0].jobs[0].elapsedSeconds, 180);
    assert.equal(collected[0].jobs[1].jobId, 'job-2');
    assert.equal(collected[0].jobs[1].pid, 444);
    assert.equal(collected[0].jobs[1].elapsedSeconds, 120);

    // 2. list (テキスト行)
    const listResult = runMain(['list', '--workspace', workspace]);
    assert.equal(listResult.code, 0);
    assert.equal(listResult.lines.length, 4);
    assert.ok(listResult.lines[0].includes('#?'));
    assert.ok(listResult.lines[1].includes('review-manager') && listResult.lines[1].includes('(pid: 222)'));
    assert.ok(listResult.lines[2].includes('job-1 (Design)') && listResult.lines[2].includes('(pid: 333)'));
    assert.ok(listResult.lines[3].includes('job-2 (Correctness)') && listResult.lines[3].includes('(pid: 444)'));

    // 3. list --json
    const jsonResult = runMain(['list', '--workspace', workspace, '--json']);
    assert.equal(jsonResult.code, 0);
    const parsed = JSON.parse(jsonResult.lines.join('\n'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].jobs.length, 2);
    assert.deepEqual(parsed[0].jobs[0], {
      jobId: 'job-1',
      aspect: 'Design',
      leafIds: ['leaf-1'],
      pid: 333,
      running: true,
      startTime: '2026-08-26T11:57:00.000Z',
      elapsedSeconds: 180,
      agentId: 'codex',
    });
  } finally {
    workerStatus._setNow(null);
    setTestProbePid(null);
    setTestReadStartTime(null);
    workerStatus._setFindRunningInstances(null);
    removeWorkspace(workspace);
  }
});

// 退行C（監視ペイン）: 終わったレビュージョブ行が残る。ジョブは「その観測で見えたもの」だけから作られるべきで、
// 前の観測で見えたジョブが次の観測に残ってはならない。1回目の観測で出ることも確かめ、空振りを防ぐ。
test('collectWorkersStatus: 観測の間に終了したレビュージョブは次の観測に含めない', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-job-gone-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestProbePid((pid) => pid === 222);
  setTestReadStartTime(() => '2026-08-26T11:55:00.000Z');
  let observation = 0;
  workerStatus._setFindRunningInstances(() => {
    observation++;
    // 1回目の観測では job-1 が実行中、2回目の観測では終了している
    return observation === 1
      ? [{ pid: 333, script: 'review-job', pr: 417, jobId: 'job-1', aspect: 'Design', leafIds: ['leaf-1'], agentId: 'codex', startTime: '2026-08-26T11:57:00.000Z' }]
      : [];
  });

  try {
    writeReviewManager(workspace, 417, 222, '2026-08-26T11:55:00.000Z');

    const first = workerStatus.collectWorkersStatus(workspace);
    assert.equal(first[0].jobs.length, 1, '1回目の観測では実行中のジョブが見える');
    assert.equal(first[0].jobs[0].jobId, 'job-1');

    const second = workerStatus.collectWorkersStatus(workspace);
    assert.equal(second[0].running, true, 'Review Manager 自体は生存している');
    assert.equal((second[0].jobs || []).length, 0, '終了したジョブは次の観測に含めない');
    assert.equal(JSON.stringify(second).includes('job-1'), false);
  } finally {
    workerStatus._setNow(null);
    setTestProbePid(null);
    setTestReadStartTime(null);
    workerStatus._setFindRunningInstances(null);
    removeWorkspace(workspace);
  }
});

test('collectWorkersStatus: レビュージョブ取得失敗をReview Manager行に表示する', () => {
  const workspace = createWorkspace('gh-maestro-ws-rm-jobs-error-');
  const fixedNow = new Date('2026-08-26T12:00:00.000Z').getTime();
  workerStatus._setNow(() => fixedNow);
  setTestProbePid((pid) => pid === 222);
  setTestReadStartTime(() => '2026-08-26T11:55:00.000Z');
  workerStatus._setFindRunningInstances(() => {
    throw new Error('review-job scanner failed');
  });

  try {
    writeReviewManager(workspace, 416, 222, '2026-08-26T11:55:00.000Z');

    const collected = workerStatus.collectWorkersStatus(workspace);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].jobsError, true);
    assert.equal(collected[0].jobs, undefined);

    const listResult = runMain(['list', '--workspace', workspace]);
    assert.equal(listResult.code, 0);
    assert.equal(listResult.lines.length, 3);
    assert.ok(listResult.lines[1].includes('review-manager') && listResult.lines[1].includes('(pid: 222)'));
    assert.match(listResult.lines[2], /^  └─ review jobs unavailable \(取得失敗\)$/);

    const jsonResult = runMain(['list', '--workspace', workspace, '--json']);
    assert.equal(jsonResult.code, 0);
    const parsed = JSON.parse(jsonResult.lines.join('\n'));
    assert.equal(parsed[0].jobsError, true);
  } finally {
    workerStatus._setNow(null);
    setTestProbePid(null);
    setTestReadStartTime(null);
    workerStatus._setFindRunningInstances(null);
    removeWorkspace(workspace);
  }
});

test('buildStatusHeader: PRありの場合は <owner>/<repo> issue#<N>, PR#<M> 形式で表示する', () => {
  assert.equal(
    workerStatus.buildStatusHeader('jintrick/gh-maestro', 629, 630),
    'jintrick/gh-maestro issue#629, PR#630',
  );
  assert.equal(
    workerStatus.buildStatusHeader('jintrick/gh-maestro', '629', '630'),
    'jintrick/gh-maestro issue#629, PR#630',
  );
});

test('buildStatusHeader: PR未作成の場合は <owner>/<repo> issue#<N> 形式で表示し、計時間を含まない', () => {
  assert.equal(
    workerStatus.buildStatusHeader('jintrick/gh-maestro', 629, null),
    'jintrick/gh-maestro issue#629',
  );
  assert.equal(
    workerStatus.buildStatusHeader('jintrick/gh-maestro', 629),
    'jintrick/gh-maestro issue#629',
  );
  assert.equal(
    workerStatus.buildStatusHeader('jintrick/gh-maestro', 629, ''),
    'jintrick/gh-maestro issue#629',
  );
  const header = workerStatus.buildStatusHeader('jintrick/gh-maestro', 629, 630);
  assert.ok(!header.includes('計'));
  assert.ok(!header.includes('==='));
});

test('buildStatusHeader: repoまたはissueが未解決の場合はフォールバックする', () => {
  assert.equal(
    workerStatus.buildStatusHeader(null, 629),
    'unknown issue#629',
  );
  assert.equal(
    workerStatus.buildStatusHeader('', 629),
    'unknown issue#629',
  );
  assert.equal(
    workerStatus.buildStatusHeader('jintrick/gh-maestro', null),
    'jintrick/gh-maestro issue#?',
  );
});

test('renderSnapshotLines: 区間時間行を表示せず、見出しにリポジトリ名を表示する', () => {
  const lines = workerStatus.renderSnapshotLines('C:/temporary-workspace', 629, {
    repo: 'jintrick/gh-maestro',
    currentWorkers: [],
    cycleEvents: [{ schemaVersion: 1, issue: 629, event: 'pr-created', at: '2026-10-20T00:00:00Z', pr: 630 }],
  });
  assert.equal(lines[0], 'jintrick/gh-maestro issue#629, PR#630');
  assert.ok(!lines.some(l => l.includes('準備') && l.includes('計画') && l.includes('承認')));
});

test('_getRepo: 解決失敗後のクールダウン期間内は外部コマンドを呼ばず即座にnull(unknown)を返し、成功時にキャッシュする', () => {
  workerStatus._clearRepoCache();
  let calls = 0;
  let now = 100000;
  workerStatus._setResolveRepo(() => {
    calls++;
    if (calls === 1) return { ok: false, error: 'fail' };
    return { ok: true, repo: 'jintrick/gh-maestro' };
  });

  const ws = 'C:/test-ws-retry';
  // 1回目: 失敗
  const res1 = workerStatus._getRepo(ws, { nowFn: () => now });
  assert.equal(res1, null);
  assert.equal(calls, 1);

  // 10秒後 (クールダウン30秒以内): 外部関数を呼ばずに即座にnullを返す
  now += 10000;
  const res2 = workerStatus._getRepo(ws, { nowFn: () => now });
  assert.equal(res2, null);
  assert.equal(calls, 1);

  // 31秒後 (クールダウン経過): 再試行する
  now += 21000;
  const res3 = workerStatus._getRepo(ws, { nowFn: () => now });
  assert.equal(res3, 'jintrick/gh-maestro');
  assert.equal(calls, 2);

  // 3回目 (成功後キャッシュ): 外部関数を呼ばない
  now += 5000;
  const res4 = workerStatus._getRepo(ws, { nowFn: () => now });
  assert.equal(res4, 'jintrick/gh-maestro');
  assert.equal(calls, 2);

  workerStatus._setResolveRepo(null);
  workerStatus._clearRepoCache();
});

test('_getRepo: 既定の timeoutMs に REPO_RESOLVE_TIMEOUT_MS (3000ms) を渡す', () => {
  workerStatus._clearRepoCache();
  let capturedDeps = null;
  const ws = 'C:/test-ws-timeout';
  workerStatus._setResolveRepo((params, deps) => {
    capturedDeps = deps;
    return { ok: true, repo: 'jintrick/gh-maestro' };
  });

  workerStatus._getRepo(ws);
  assert.ok(capturedDeps && typeof capturedDeps.ghRepoViewFn === 'function');
  assert.equal(workerStatus.REPO_RESOLVE_TIMEOUT_MS, 3000);
  assert.equal(workerStatus.REPO_RETRY_INTERVAL_MS, 30000);

  workerStatus._setResolveRepo(null);
  workerStatus._clearRepoCache();
});


// ── Issue #692: 稼働時間の合計（投影と現在のレジストリの突き合わせ） ─────────

test('mergeCycleWorkers: 現在runの登録時刻が投影と数ミリ秒ずれても二重計上せず、過去runと合算する', () => {
  // 過去run（停止済み60秒）と現在run（投影は未停止・登録は +3ms）。
  const merged = workerStatus.mergeCycleWorkers([
    { workerName: 'issue-692-coder-x', pid: 101, startTime: '2026-09-10T05:00:00.000Z', stopTime: '2026-09-10T05:01:00.000Z', running: false, abnormal: false, elapsedSeconds: 60 },
    { workerName: 'issue-692-coder-x', pid: 202, startTime: '2026-09-10T05:10:00.000Z', running: true, abnormal: false, elapsedSeconds: null },
  ], [
    { workerName: 'issue-692-coder-x', pid: 202, startTime: '2026-09-10T05:10:00.003Z', running: true, abnormal: false, elapsedSeconds: 120, durationKnown: true },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].runNumber, 2);
  assert.equal(merged[0].running, true);
  // 期待値: 過去run 60秒 + 現在run 120秒（登録の経過）= 180秒。
  assert.equal(merged[0].durationKnown, true);
  assert.equal(merged[0].elapsedSeconds, 180);
});

test('mergeCycleWorkers: 停止記録のない過去runがあれば合計は不明にし、推測値を出さない', () => {
  const merged = workerStatus.mergeCycleWorkers([
    { workerName: 'issue-692-coder-y', pid: 101, startTime: '2026-09-10T05:00:00.000Z', running: true, abnormal: false, elapsedSeconds: null },
    { workerName: 'issue-692-coder-y', pid: 202, startTime: '2026-09-10T05:10:00.000Z', running: true, abnormal: false, elapsedSeconds: null },
  ], [
    { workerName: 'issue-692-coder-y', pid: 202, startTime: '2026-09-10T05:10:00.000Z', running: true, abnormal: false, elapsedSeconds: 120, durationKnown: true },
  ]);
  assert.equal(merged[0].durationKnown, false);
  assert.equal(merged[0].elapsedSeconds, null);
  // 表示上も 0 や推測値にせず、不明だと分かる記号になる。
  const lines = workerStatus.renderWorkerRows([merged[0]], { maxRows: 4 });
  assert.ok(lines[0].includes('??:??'));
});

test('mergeCycleWorkers: 停止済みworkerは登録時刻と停止の開始時刻が数ミリ秒ずれても「不明」にならない', () => {
  const merged = workerStatus.mergeCycleWorkers([
    { workerName: 'issue-692-coder-z', pid: 101, startTime: '2026-09-10T05:00:00.000Z', stopTime: '2026-09-10T05:01:30.000Z', running: false, abnormal: false, elapsedSeconds: 90 },
  ], [
    { workerName: 'issue-692-coder-z', pid: 101, startTime: '2026-09-10T05:00:00.003Z', running: false, abnormal: false, elapsedSeconds: 0, durationKnown: false },
  ]);
  assert.equal(merged[0].running, false);
  assert.equal(merged[0].durationKnown, true);
  assert.equal(merged[0].elapsedSeconds, 90);
  const lines = workerStatus.renderWorkerRows([merged[0]], { maxRows: 4 });
  // 期待値: 開始 05:00:00 から停止 05:01:30 までの 90 秒（01:30）。
  assert.ok(lines[0].includes('01:30'));
  assert.ok(!lines[0].includes('??:??'));
});
