'use strict';

// Issue #737: 同じ作業場所（worktree）が前回の残骸として残っていると、git worktree remove --force は
// 残ったjunctionをたどり、作業場所の外（本体の node_modules など）の中身まで消す。
// この slow 層テストは、実 git・実 CLI で「リンク先の番兵が残る」ことを確かめる。
// すべて一時ディレクトリだけを使い、実リポジトリのパスは渡さない。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'spawn-worker.js');

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'initial commit');
}

function makeSentinel(base) {
  const target = path.join(base, 'outside-node_modules');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'sentinel.txt'), 'must survive', 'utf8');
  return target;
}

test('worktreeRemove: 残ったjunctionがあっても、リンク先（作業場所の外）の番兵は残る', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-wt-residue-'));
  try {
    const repo = path.join(base, 'repo');
    makeRepo(repo);
    const wt = path.join(base, 'wt');
    const sentinelDir = makeSentinel(base);
    const add = spawnSync('git', ['worktree', 'add', '-q', wt, '-b', 'issue-737-residue'], { cwd: repo, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    fs.symlinkSync(sentinelDir, path.join(wt, 'node_modules'), 'junction');

    const { worktreeRemove } = require('../../scripts/shared/git-worktree');
    worktreeRemove(wt, repo);

    assert.equal(fs.existsSync(wt), false, '作業場所が消えていない');
    assert.equal(
      fs.readFileSync(path.join(sentinelDir, 'sentinel.txt'), 'utf8'),
      'must survive',
      'リンク先の番兵が消えた（junction をたどって削除した）',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// 残骸の作業場所（登録済み worktree + junction）を作り、同名ワーカーの起動を再現する。
function setupResidue(base, workerName) {
  const ws = path.join(base, 'ws');
  const home = path.join(base, 'home');
  makeRepo(ws);
  fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), JSON.stringify({
    agents: { 'test-agent': { id: 'test-agent', command: process.execPath, extraArgs: [], promptDelivery: 'positional' } },
  }), 'utf8');
  const wt = path.join(ws, '.gh-maestro', 'worktrees', workerName);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = spawnSync('git', ['worktree', 'add', '-q', wt, '-b', workerName], { cwd: ws, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const sentinelDir = makeSentinel(base);
  fs.symlinkSync(sentinelDir, path.join(wt, 'node_modules'), 'junction');
  require('../../scripts/shared/read-state').initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });
  return { ws, home, wt, sentinelDir };
}

// 後段（linkNodeModules）で止める preload。unlinkThrows=true なら、リンクを外せたか判定できない状態を注入する。
function writeStopPreload(home, { unlinkThrows }) {
  const preload = path.join(home, 'preload.js');
  const req = (p) => JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', p));
  fs.writeFileSync(preload, [
    `const closedGuard = require(${req('closed-pr-guard.js')});`,
    'closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });',
    `const ghComments = require(${req('gh-comments.js')});`,
    "ghComments.listComments = () => ({ status: 0, stdout: '[]' });",
    `const nm = require(${req('link-node-modules.js')});`,
    "nm.linkNodeModules = () => ({ linked: [], skipped: [], missing: ['stop (test)'] });",
    unlinkThrows
      ? `const uj = require(${req('unlink-junctions.js')});
         uj.unlinkJunctionsAndVerify = () => { const e = new Error('test: cannot verify links'); e.code = 'WORKTREE_LINKS_UNVERIFIABLE'; throw e; };`
      : '',
  ].join('\n'), 'utf8');
  return preload;
}

function runSpawn(home, ws, preload, workerName) {
  return spawnSync(process.execPath, ['-r', preload, SCRIPT,
    '--skill', 'gh-maestro-coder', '--issue', '737', '--description', workerName.slice('issue-737-coder-'.length),
    '--repo', 'o/r', '--workspace', ws, '--agent', 'test-agent', '--session-id', 'valid-test-session'],
  { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 120000 });
}

test('spawn-worker: 同名の残骸を作り直しても、リンク先の番兵が残る（Issue #737）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-spawn-residue-'));
  try {
    const workerName = 'issue-737-coder-residue-restart';
    const { ws, home, sentinelDir } = setupResidue(base, workerName);
    const preload = writeStopPreload(home, { unlinkThrows: false });

    runSpawn(home, ws, preload, workerName);

    assert.equal(
      fs.readFileSync(path.join(sentinelDir, 'sentinel.txt'), 'utf8'),
      'must survive',
      '同名ワーカーの再起動で、本体側（リンク先）の番兵が消えた',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('spawn-worker: リンクを外せたか判定できないときは作業場所を消さず、理由を出して失敗終了する（Issue #737）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-spawn-residue-fail-'));
  try {
    const workerName = 'issue-737-coder-residue-unverifiable';
    const { ws, home, wt, sentinelDir } = setupResidue(base, workerName);
    const preload = writeStopPreload(home, { unlinkThrows: true });

    const r = runSpawn(home, ws, preload, workerName);

    assert.notEqual(r.status, 0, `非ゼロ終了であること: ${r.stderr}`);
    assert.match(r.stderr, /test: cannot verify links/, `理由が出力されていること: ${r.stderr}`);
    assert.equal(fs.existsSync(wt), true, '判定できないのに作業場所を消した');
    assert.equal(
      fs.readFileSync(path.join(sentinelDir, 'sentinel.txt'), 'utf8'),
      'must survive',
      '判定できないのにリンク先の番兵が消えた',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
