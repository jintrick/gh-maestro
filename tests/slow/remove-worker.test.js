'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'remove-worker.js');
// workspace引数を省略する経路が実ワークスペースを読まないよう env を外す。
// 明示した --workspace は GH_MAESTRO_WORKSPACE env より優先される。
// （共通ヘルパー tests/_spawn-env.js の cleanSpawnEnv。ワーカー文脈環境変数も除去する）。
const { cleanSpawnEnv } = require('../_spawn-env');
const FAST_WORKER_CLI_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-remove-worker-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const source = [
    "'use strict';",
    `const childProcess = require(${JSON.stringify(childProcessPath)});`,
    'const realExecSync = childProcess.execSync;',
    'const isAlive = (pid) => {',
    '  try { process.kill(Number(pid), 0); return true; }',
    "  catch (e) { return e && e.code !== 'ESRCH'; }",
    '};',
    'childProcess.execSync = (command, opts) => {',
    "  if (String(command).includes('Get-CimInstance Win32_Process')) {",
    '    const match = /ProcessId=(\\d+)/.exec(String(command));',
    '    const startTime = process.env.GHM_TEST_WORKER_START_TIME;',
    '    return match && startTime && isAlive(Number(match[1])) ? `${startTime}\\n` : "";',
    '  }',
    '  return realExecSync(command, opts);',
    '};',
  ].join('\n');
  fs.writeFileSync(file, source, 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return file;
})();

function run(args, env = {}) {
  const workspaceIndex = args.indexOf('--workspace');
  const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  return spawnSync(process.execPath, ['-r', FAST_WORKER_CLI_PRELOAD, SCRIPT, ...args], {
    encoding: 'utf8', env: {
      ...cleanSpawnEnv(),
      ...(workspace ? { GH_MAESTRO_RUNTIME_DIR: path.join(workspace, '.test-runtime') } : {}),
      ...env,
    },
  });
}
function isProcessAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error && error.code !== 'ESRCH'; }
}
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-rmw-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * 実際のワーカー構造（親プロセス＋子プロセス）を模したプロセスツリーを起動する。
 */
function spawnProcessTree(dir, workerName, claimLiveness = true) {
  const childInfoFile = path.join(dir, `child-pid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  const livenessPath = require.resolve('../../scripts/shared/process-liveness');
  const ownerSetup = claimLiveness
    ? `const liveness = require(${JSON.stringify(livenessPath)}); const ref = liveness.captureSelf({ workspace: process.env.GH_MAESTRO_WORKSPACE, kind: 'worker', name: process.env.GHM_TEST_WORKER_NAME });`
    : '';
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const fs = require('fs');
    ${ownerSetup}
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const info = ${claimLiveness ? "JSON.stringify({ ...liveness.writeRef({}, ref), childPid: child.pid })" : "JSON.stringify({ childPid: child.pid })"};
    fs.writeFileSync(process.argv[1], info, 'utf8');
    setInterval(() => {}, 1000);
  `, childInfoFile], {
    detached: true,
    env: {
      ...cleanSpawnEnv(),
      GH_MAESTRO_WORKSPACE: dir,
      GH_MAESTRO_RUNTIME_DIR: path.join(dir, '.test-runtime'),
      GHM_TEST_WORKER_NAME: workerName,
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  const parentPid = parent.pid;
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(childInfoFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!fs.existsSync(childInfoFile)) {
    try { process.kill(parentPid, 'SIGKILL'); } catch {}
    throw new Error('子プロセスの起動・PID取得に失敗しました');
  }
  const processRecord = JSON.parse(fs.readFileSync(childInfoFile, 'utf8'));
  return { parentPid, childPid: processRecord.childPid, processRecord };
}

test('--help はUsageを表示して終了コード0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node remove-worker\.js/);
  assert.match(r.stdout, /<workerName>/);
  assert.match(r.stdout, /--issue/);
  assert.match(r.stdout, /--skill/);
});

test('引数なしはUsageエラーで終了コード1', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node remove-worker\.js/);
});

test('workerName位置引数と〈--issue+--skill〉の併用はエラー終了する', () => {
  const r = run(['issue-5-x', '--issue', '5', '--skill', 'gh-maestro-coder']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /併用できません/);
});

test('旧来の--worker-name指定は未知フラグとして拒否する', () => {
  const r = run(['--worker-name', 'issue-5-x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知のフラグ/);
  assert.match(r.stderr, /--worker-name/);
});

test('--issue のみ（--skill 欠落）はUsageエラーで終了コード1', () => {
  const r = run(['--issue', '5']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node remove-worker\.js/);
});

test('--issue+--skill で該当ワーカーが無ければ解決エラーで終了する（副作用に到達しない）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gh-maestro', 'workers.json'),
      JSON.stringify({ 'issue-42-implement': { paneId: '11', issue: 42, skill: 'gh-maestro-coder' } }),
      'utf8'
    );
    const r = run(['--issue', '99', '--skill', 'gh-maestro-coder', '--workspace', dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /見つかりません/);
  });
});

test('--issue+--skill で複数該当なら候補付きエラーで終了する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gh-maestro', 'workers.json'),
      JSON.stringify({
        'issue-12-a': { paneId: '10', issue: 12, skill: 'gh-maestro-coder' },
        'issue-12-b': { paneId: '11', issue: 12, skill: 'gh-maestro-coder' },
      }),
      'utf8'
    );
    const r = run(['--issue', '12', '--skill', 'gh-maestro-coder', '--workspace', dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /複数のワーカーが該当/);
    assert.match(r.stderr, /issue-12-a/);
    assert.match(r.stderr, /issue-12-b/);
  });
});

test('余剰な位置引数はエラー終了する（黙って無視しない）', () => {
  const r = run(['issue-5-x', 'extra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /予期しない位置引数/);
  assert.match(r.stderr, /extra/);
});

test('未知のフラグはエラー終了する（黙って無視しない）', () => {
  const r = run(['issue-5-x', '--bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知のフラグ/);
  assert.match(r.stderr, /--bogus/);
});

test('remove-worker: 同一性一致のプロセスツリー（親＋子）を終了しエントリを削除する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    const { parentPid, childPid, processRecord } = spawnProcessTree(dir, 'issue-50-coder');
    try {
      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'issue-50-coder': {
            ...processRecord,
            issue: 50,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );
      const r = run(['issue-50-coder', '--workspace', dir]);
      assert.equal(r.status, 0);
      assert.equal(isProcessAlive(parentPid), false, '同一性が一致した親プロセスはkillされること');
      assert.equal(isProcessAlive(childPid), false, '同一性が一致した子プロセスもkillされること');
      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.equal('issue-50-coder' in workers, false, 'workers.jsonからエントリが削除されること');
    } finally {
      try { process.kill(parentPid, 'SIGKILL'); } catch {}
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });
});

test('remove-worker: PR1形式でPIDが存在する場合はunknownとしてkillせず記録を削除する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    const { parentPid, childPid } = spawnProcessTree(dir, 'issue-51-coder', false);
    try {
      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'issue-51-coder': {
            pid: parentPid,
            startTime: '2000-01-01T00:00:00.000Z',
            issue: 51,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );
      const r = run(['issue-51-coder', '--workspace', dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /生死を判定できません/);

      // 親・子プロセスが kill されずに生存していることを検証（巻き添え防止の検証）
      assert.equal(isProcessAlive(parentPid), true, 'PIDが存在するPR1記録では親プロセスをkillしないこと');
      assert.equal(isProcessAlive(childPid), true, 'PIDが存在するPR1記録では子プロセスをkillしないこと');

      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.equal('issue-51-coder' in workers, false, 'remove-workerはunknownを警告してworkers.jsonから除くこと');
    } finally {
      try { process.kill(parentPid, 'SIGKILL'); } catch {}
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });
});
