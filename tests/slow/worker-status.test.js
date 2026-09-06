'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { beforeEach, test } = require('node:test');

const workerStatus = require('../../scripts/worker-status');
const workerLiveness = require('../../scripts/shared/worker-liveness');
const { cleanSpawnEnv } = require('../_spawn-env');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'worker-status.js');

// status/list の実CLI境界は維持する。各子プロセスの初期化で発生する
// process-lifecycle のWindows WMI照会だけを固定観測へ差し替え、PIDだけの
// 表示ケースを不要なPowerShell待ちから分離する。PID再利用の同一性は
// process-lifecycle.test.js とこのファイルの明示的なidentityケースで検証する。
const FAST_STATUS_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-worker-status-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../../scripts/process-lifecycle');
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
    'lifecycle.getProcessStartTime = () => fixedStartTime;',
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
  workerStatus._setFindRunningInstances(() => []);
  // Review-manager fixtures below inject identity verification themselves; a
  // null observation here keeps the non-identity-focused cases from invoking
  // the platform WMI probe.  PID-reuse behavior remains covered by the
  // dedicated process-lifecycle tests and the explicit cache tests above.
  workerStatus._setGetProcessStartTime(() => null);
  // pane の各入力・出力ケースは、明示的な lock 拒否ケース以外では
  // ロック取得のOS照会を検証対象にしない。実際の lock 拒否は専用ケースで
  // false を注入して確認する。
  workerStatus._setAcquireStatusPaneLock(() => true);
  workerStatus._setReleaseStatusPaneLock(() => {});
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
  fs.writeFileSync(file, JSON.stringify({ pid, startTime }), 'utf8');
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































test('サブプロセス: list はサイクル行と状態ドットを表示する', () => {
  const workspace = createWorkspace('gh-maestro-worker-status-list-cli-');
  try {
    writeWorkers(workspace, { alive: { pid: process.pid } });
    const result = runCli(['list', '--workspace', workspace]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /alive/);
    assert.match(result.stdout, /#\? 計0s/);
    assert.match(result.stdout, /● alive/);
    assert.doesNotMatch(result.stdout, /\[running\]/);
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
