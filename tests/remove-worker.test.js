'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { getProcessStartTime, isProcessAlive } = require('../scripts/process-lifecycle');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'remove-worker.js');
// workspace引数を省略する経路が実ワークスペースを読まないよう env を外す。
// 明示した --workspace は GH_MAESTRO_WORKSPACE env より優先される。
// （共通ヘルパー tests/_spawn-env.js の cleanSpawnEnv。ワーカー文脈環境変数も除去する）。
const { cleanSpawnEnv } = require('./_spawn-env');
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: cleanSpawnEnv() });
}
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-rmw-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * 実際のワーカー構造（親プロセス＋子プロセス）を模したプロセスツリーを起動する。
 */
function spawnProcessTree(dir) {
  const childInfoFile = path.join(dir, `child-pid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid), 'utf8');
    setInterval(() => {}, 1000);
  `, childInfoFile], { detached: true, stdio: 'ignore' });

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
    const { parentPid, childPid } = spawnProcessTree(dir);
    try {
      const startTime = getProcessStartTime(parentPid);
      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'issue-50-coder': {
            pid: parentPid,
            startTime,
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

test('remove-worker: 拒否側: 起動時刻不一致（PID再利用）のプロセスツリーはkillをスキップしてエントリのみ削除する', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    const { parentPid, childPid } = spawnProcessTree(dir);
    try {
      const fakeStartTime = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'issue-51-coder': {
            pid: parentPid,
            startTime: fakeStartTime,
            issue: 51,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );
      const r = run(['issue-51-coder', '--workspace', dir]);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /同一性確認に失敗しました/);
      assert.match(r.stderr, /kill をスキップします/);

      // 親・子プロセスが kill されずに生存していることを検証（巻き添え防止の検証）
      assert.equal(isProcessAlive(parentPid), true, '再利用された親プロセスはkillされず生存し続けること');
      assert.equal(isProcessAlive(childPid), true, '再利用された子プロセスはkillされず生存し続けること');

      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.equal('issue-51-coder' in workers, false, 'workers.jsonからエントリは削除されること');
    } finally {
      try { process.kill(parentPid, 'SIGKILL'); } catch {}
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });
});
