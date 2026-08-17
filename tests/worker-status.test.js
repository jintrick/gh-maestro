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
