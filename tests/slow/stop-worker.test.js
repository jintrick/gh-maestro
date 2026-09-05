'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { getProcessStartTime, isProcessAlive } = require('../../scripts/process-lifecycle');
const { cleanSpawnEnv } = require('../_spawn-env');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'stop-worker.js');

// 停止対象の実プロセスツリーとtaskkill境界は実際に通す。一方、子CLI内部の
// 起動時刻取得は、親テストが対象PIDについて一度だけ取得した値を環境経由で
// 渡して再利用する。これによりWMIのプロセス起動コストを削減しつつ、通常系は
// 実PIDの起動時刻一致、拒否系は同じ実PIDと過去時刻の不一致を検証できる。
const TEST_START_TIME_ENV = 'GHM_TEST_WORKER_START_TIME';
const FAST_WORKER_CLI_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-stop-worker-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../../scripts/process-lifecycle');
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
    `const lifecycle = require(${JSON.stringify(lifecyclePath)});`,
    'lifecycle.getProcessStartTime = (pid) => {',
    '  const value = process.env.GHM_TEST_WORKER_START_TIME;',
    '  return value && isAlive(pid) ? value : null;',
    '};',
  ].join('\n');
  fs.writeFileSync(file, source, 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return file;
})();

function run(args, env = {}) {
  return spawnSync(process.execPath, ['-r', FAST_WORKER_CLI_PRELOAD, SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...cleanSpawnEnv(), ...env },
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-stop-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * 実際のワーカー構造（親プロセス＋子プロセス）を模したプロセスツリーを起動する。
 * 親プロセス（シム役）の下に子プロセス（エージェント役）がぶら下がる木構造を作る。
 */
function spawnProcessTree(dir) {
  const childInfoFile = path.join(dir, `child-pid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(process.argv[1], String(child.pid), 'utf8');
    setInterval(() => {}, 1000);
  `, childInfoFile], { detached: true, stdio: 'ignore', windowsHide: true });

  const parentPid = parent.pid;
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(childInfoFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!fs.existsSync(childInfoFile)) {
    try { process.kill(parentPid, 'SIGKILL'); } catch {}
    throw new Error('子プロセスの起動・PID取得に失敗しました');
  }
  const childPid = parseInt(fs.readFileSync(childInfoFile, 'utf8'), 10);
  return { parentPid, childPid };
}

test('stop-worker: --help はUsageを表示して終了コード0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node stop-worker\.js/);
  assert.match(r.stdout, /<workerName>/);
  assert.match(r.stdout, /--issue/);
  assert.match(r.stdout, /--skill/);
});

test('stop-worker: -h もUsageを表示して終了コード0', () => {
  const r = run(['-h']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node stop-worker\.js/);
});

test('stop-worker: 引数なしはUsageエラーで終了コード1', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node stop-worker\.js/);
});

test('stop-worker: workerName位置引数と〈--issue+--skill〉の併用はエラー終了する', () => {
  const r = run(['issue-5-x', '--issue', '5', '--skill', 'gh-maestro-coder']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /併用できません/);
});

test('stop-worker: 余剰な位置引数はエラー終了する', () => {
  const r = run(['issue-5-x', 'extra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /予期しない位置引数/);
});

test('stop-worker: 未知のフラグはエラー終了する', () => {
  const r = run(['issue-5-x', '--bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知のフラグ/);
});

test('stop-worker: --issue のみ（--skill 欠落）はUsageエラーで終了コード1', () => {
  const r = run(['--issue', '5']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node stop-worker\.js/);
});

test('stop-worker: workers.json 不在時はエラー終了する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    const r = run(['issue-1-x', '--workspace', dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /workers\.json が見つかりません/);
  });
});

test('stop-worker: 対象ワーカーエントリ不在時はエラー終了する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gh-maestro', 'workers.json'),
      JSON.stringify({ 'other-worker': { pid: 1234 } }),
      'utf8'
    );
    const r = run(['target-worker', '--workspace', dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /見つかりません/);
  });
});

test('stop-worker: プロセスが既に停止している場合は終了コード0で正常終了する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gh-maestro', 'workers.json'),
      JSON.stringify({ 'stopped-worker': { pid: 999999999, startTime: '2026-01-01T00:00:00.000Z' } }),
      'utf8'
    );
    const r = run(['stopped-worker', '--workspace', dir]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /既に停止しています/);
  });
});

test('stop-worker: 正常系: 同一性が一致するプロセスツリー（親＋子）を停止し、worktreeとworkers.jsonを保持する', () => {
  withTempDir((dir) => {
    const worktreeDir = path.join(dir, '.gh-maestro', 'worktrees', 'test-worker');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'sample.txt'), 'hello', 'utf8');

    // 親子関係を持つプロセスツリーを起動
    const { parentPid, childPid } = spawnProcessTree(dir);
    assert.ok(parentPid > 0);
    assert.ok(childPid > 0);

    try {
      const startTime = getProcessStartTime(parentPid);
      assert.ok(startTime, '親プロセスの起動時刻を取得できること');

      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'test-worker': {
            pid: parentPid,
            startTime,
            issue: 10,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );

      const r = run(['test-worker', '--workspace', dir], { [TEST_START_TIME_ENV]: startTime });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /終了しました/);

      // 親プロセスだけでなく配下の子プロセスまで終了していることを検証（プロセスツリー全体の停止）
      assert.equal(isProcessAlive(parentPid), false, '親プロセスが終了していること');
      assert.equal(isProcessAlive(childPid), false, '子プロセス（配下のエージェント）が終了していること');

      // worktreeディレクトリと中身が残っていることを確認
      assert.ok(fs.existsSync(worktreeDir), 'worktreeディレクトリが残っていること');
      assert.ok(fs.existsSync(path.join(worktreeDir, 'sample.txt')), 'worktree内のファイルが残っていること');

      // workers.json のエントリが残っていることを確認
      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.ok('test-worker' in workers, 'workers.jsonにエントリが残っていること');
    } finally {
      try { process.kill(parentPid, 'SIGKILL'); } catch {}
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });
});

test('stop-worker: 拒否側: PIDは生存しているが起動時刻が不一致（PID再利用）の場合、プロセスツリーをkillせずエラー終了する', () => {
  withTempDir((dir) => {
    const worktreeDir = path.join(dir, '.gh-maestro', 'worktrees', 'mismatch-worker');
    fs.mkdirSync(worktreeDir, { recursive: true });

    // 親子関係を持つプロセスツリーを起動
    const { parentPid, childPid } = spawnProcessTree(dir);
    assert.ok(parentPid > 0);
    assert.ok(childPid > 0);

    try {
      // 意図的に全く異なる過去の起動時刻を登録
      const fakeStartTime = '2000-01-01T00:00:00.000Z';

      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'mismatch-worker': {
            pid: parentPid,
            startTime: fakeStartTime,
            issue: 20,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );

      const actualStartTime = getProcessStartTime(parentPid);
      assert.ok(actualStartTime, '実プロセスの起動時刻を取得できること');
      const r = run(['mismatch-worker', '--workspace', dir], { [TEST_START_TIME_ENV]: actualStartTime });
      assert.notEqual(r.status, 0, '同一性不一致時は終了コード1でエラーになること');
      assert.match(r.stderr, /同一性確認に失敗しました/);

      // 親・子ともに kill されず生存し続けていることを検証（巻き添え防止の検証）
      assert.equal(isProcessAlive(parentPid), true, '同一性不一致の親プロセスはkillされず生存し続けること');
      assert.equal(isProcessAlive(childPid), true, '同一性不一致の子プロセスはkillされず生存し続けること');

      // worktree と workers.json も残っていること
      assert.ok(fs.existsSync(worktreeDir), 'worktreeディレクトリが残っていること');
      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.ok('mismatch-worker' in workers, 'workers.jsonにエントリが残っていること');
    } finally {
      try { process.kill(parentPid, 'SIGKILL'); } catch {}
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });
});

test('stop-worker: 〈--issue + --skill〉指定で解決して停止できる', () => {
  withTempDir((dir) => {
    const { parentPid, childPid } = spawnProcessTree(dir);
    try {
      const startTime = getProcessStartTime(parentPid);
      fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'issue-30-coder': {
            pid: parentPid,
            startTime,
            issue: 30,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );

      const r = run(['--issue', '30', '--skill', 'gh-maestro-coder', '--workspace', dir], {
        [TEST_START_TIME_ENV]: startTime,
      });
      assert.equal(r.status, 0);
      assert.equal(isProcessAlive(parentPid), false, '親プロセスが終了していること');
      assert.equal(isProcessAlive(childPid), false, '子プロセスが終了していること');
    } finally {
      try { process.kill(parentPid, 'SIGKILL'); } catch {}
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });
});
