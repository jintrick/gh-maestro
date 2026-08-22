'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { getProcessStartTime, isProcessAlive } = require('../scripts/process-lifecycle');
const { cleanSpawnEnv } = require('./_spawn-env');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'stop-worker.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: cleanSpawnEnv() });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-stop-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

test('stop-worker: 正常系: 同一性が一致するプロセスを停止し、worktreeとworkers.jsonを保持する', () => {
  withTempDir((dir) => {
    const worktreeDir = path.join(dir, '.gh-maestro', 'worktrees', 'test-worker');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'sample.txt'), 'hello', 'utf8');

    // 長時間動くダミー子プロセスを起動
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    assert.ok(pid > 0);

    try {
      const startTime = getProcessStartTime(pid);
      assert.ok(startTime, 'ダミープロセスの起動時刻を取得できること');

      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'test-worker': {
            pid,
            startTime,
            issue: 10,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );

      const r = run(['test-worker', '--workspace', dir]);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /終了しました/);

      // プロセスが停止していることを確認
      assert.equal(isProcessAlive(pid), false, 'プロセスが終了していること');

      // worktreeディレクトリと中身が残っていることを確認
      assert.ok(fs.existsSync(worktreeDir), 'worktreeディレクトリが残っていること');
      assert.ok(fs.existsSync(path.join(worktreeDir, 'sample.txt')), 'worktree内のファイルが残っていること');

      // workers.json のエントリが残っていることを確認
      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.ok('test-worker' in workers, 'workers.jsonにエントリが残っていること');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
});

test('stop-worker: 拒否側: PIDは生存しているが起動時刻が不一致（PID再利用）の場合、プロセスをkillせずエラー終了する', () => {
  withTempDir((dir) => {
    const worktreeDir = path.join(dir, '.gh-maestro', 'worktrees', 'mismatch-worker');
    fs.mkdirSync(worktreeDir, { recursive: true });

    // 長時間動くダミー子プロセスを起動
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    assert.ok(pid > 0);

    try {
      // 意図的に全く異なる過去の起動時刻を登録
      const fakeStartTime = '2000-01-01T00:00:00.000Z';

      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'mismatch-worker': {
            pid,
            startTime: fakeStartTime,
            issue: 20,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );

      const r = run(['mismatch-worker', '--workspace', dir]);
      assert.notEqual(r.status, 0, '同一性不一致時は終了コード1でエラーになること');
      assert.match(r.stderr, /同一性確認に失敗しました/);

      // プロセスが kill されず生存し続けていることを検証（最重要の拒否側テスト）
      assert.equal(isProcessAlive(pid), true, '同一性不一致のプロセスはkillされず生存し続けること');

      // worktree と workers.json も残っていること
      assert.ok(fs.existsSync(worktreeDir), 'worktreeディレクトリが残っていること');
      const workers = JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'));
      assert.ok('mismatch-worker' in workers, 'workers.jsonにエントリが残っていること');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
});

test('stop-worker: 〈--issue + --skill〉指定で解決して停止できる', () => {
  withTempDir((dir) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    try {
      const startTime = getProcessStartTime(pid);
      fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.gh-maestro', 'workers.json'),
        JSON.stringify({
          'issue-30-coder': {
            pid,
            startTime,
            issue: 30,
            skill: 'gh-maestro-coder',
          },
        }),
        'utf8'
      );

      const r = run(['--issue', '30', '--skill', 'gh-maestro-coder', '--workspace', dir]);
      assert.equal(r.status, 0);
      assert.equal(isProcessAlive(pid), false, 'プロセスが終了していること');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
});
