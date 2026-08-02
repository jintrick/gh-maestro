'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// remove-worker.js は実際の wezterm/git 操作を伴うため、ここでは「副作用に到達する前に
// fail-fast で終了する検証パス」だけをサブプロセス経由でテストする（対象を解決できない・
// 引数が矛盾している場合は、ペインkillやworktree削除に進む前に exit 1 で止まる）。

const SCRIPT = path.join(__dirname, '..', 'scripts', 'remove-worker.js');
// resolveWorkspace は --workspace 引数より GH_MAESTRO_WORKSPACE env を優先するため、
// テストが --workspace で渡した一時dirを無視して実ワークスペースを読まないよう env を外す
// （共通ヘルパー tests/_spawn-env.js の cleanSpawnEnv。ワーカー文脈環境変数も除去する）。
const { cleanSpawnEnv } = require('./_spawn-env');
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: cleanSpawnEnv() });
}
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-rmw-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('--help はUsageを表示して終了コード0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node remove-worker\.js/);
  assert.match(r.stdout, /--issue/);
  assert.match(r.stdout, /--skill/);
});

test('引数なしはUsageエラーで終了コード1', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node remove-worker\.js/);
});

test('--worker-name と〈--issue+--skill〉の併用はエラー終了する', () => {
  const r = run(['--worker-name', 'issue-5-x', '--issue', '5', '--skill', 'gh-maestro-coder']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /併用できません/);
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
  const r = run(['--worker-name', 'issue-5-x', 'extra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知の引数/);
  assert.match(r.stderr, /extra/);
});

test('未知のフラグはエラー終了する（黙って無視しない）', () => {
  const r = run(['--worker-name', 'issue-5-x', '--bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知の引数/);
  assert.match(r.stderr, /--bogus/);
});
