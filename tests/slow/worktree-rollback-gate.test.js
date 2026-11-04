'use strict';

// Issue #740 レビュー対応: spawn-worker の rollbackWorktree で、リンクを外せたか判定できないとき
// 作業場所もブランチも消さず、理由を出して失敗終了することを、実 git・実 CLI で確かめる。
// 後段の linkNodeModules で止めて rollback へ到達させる（既存の残骸テストと同じ方法）。
// 番兵はリンク先（作業場所の外）に置く。すべて一時ディレクトリだけを使う。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'spawn-worker.js');
const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

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

// 同名の残骸が無い状態で起動し、worktree 作成後・rollback の対象になる時点まで進める。
function setupFresh(base, workerName) {
  const ws = path.join(base, 'ws');
  const home = path.join(base, 'home');
  makeRepo(ws);
  fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), JSON.stringify({
    agents: { 'test-agent': { id: 'test-agent', command: process.execPath, extraArgs: [], promptDelivery: 'positional' } },
  }), 'utf8');
  require('../../scripts/shared/read-state').initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });
  const sentinelDir = path.join(base, 'outside-node_modules');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'sentinel.txt'), 'must survive', 'utf8');
  return {
    ws,
    home,
    wt: path.join(ws, '.gh-maestro', 'worktrees', workerName),
    sentinelDir,
  };
}

// linkNodeModules の中で、作業場所に node_modules junction を張ってから失敗させる。
// unlinkJunctionsAndVerify は「リンクを外せたか判定できない」を注入する。
// そのため rollback は作業場所を消せず、理由を出して戻る。
function writeRollbackPreload(home, sentinelDir) {
  const preload = path.join(home, 'preload-rollback.js');
  const req = (p) => JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', p));
  fs.writeFileSync(preload, [
    `const closedGuard = require(${req('closed-pr-guard.js')});`,
    'closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });',
    `const ghComments = require(${req('gh-comments.js')});`,
    "ghComments.listComments = () => ({ status: 0, stdout: '[]' });",
    `const nm = require(${req('link-node-modules.js')});`,
    `nm.linkNodeModules = (wt) => {
      require('fs').symlinkSync(${JSON.stringify(sentinelDir)}, require('path').join(wt, 'node_modules'), 'junction');
      throw new Error('test: link failed after junction');
    };`,
    `const uj = require(${req('unlink-junctions.js')});
     uj.unlinkJunctionsAndVerify = () => { const e = new Error('test: cannot verify links'); e.code = 'WORKTREE_LINKS_UNVERIFIABLE'; throw e; };`,
  ].join('\n'), 'utf8');
  return preload;
}

function runSpawn(home, ws, preload, workerName) {
  return spawnSync(process.execPath, ['-r', preload, SCRIPT,
    '--skill', 'gh-maestro-coder', '--issue', '740', '--description', workerName.slice('issue-740-coder-'.length),
    '--repo', 'o/r', '--workspace', ws, '--agent', 'test-agent', '--session-id', 'valid-test-session'],
  { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 120000 });
}

test('spawn-worker rollback: リンクを外せないときは作業場所もブランチも消さず、理由を出して失敗終了する（Issue #740）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-spawn-rollback-gate-'));
  try {
    const workerName = 'issue-740-coder-rollback-gate';
    const { ws, home, wt, sentinelDir } = setupFresh(base, workerName);
    const preload = writeRollbackPreload(home, sentinelDir);

    const r = runSpawn(home, ws, preload, workerName);

    assert.notEqual(r.status, 0, `非ゼロ終了であること: ${r.stderr}`);
    assert.match(r.stderr, /worktreeをロールバックします/, `rollback へ到達したこと: ${r.stderr}`);
    assert.match(
      r.stderr,
      /rollback: リンクを外せないため作業場所を削除しません/,
      `理由が出力されていること: ${r.stderr}`,
    );
    assert.equal(fs.existsSync(wt), true, '判定できないのに作業場所を消した');
    const branch = spawnSync('git', ['branch', '--list', workerName], { cwd: ws, encoding: 'utf8' });
    assert.match(branch.stdout, new RegExp(workerName), 'rollback が止まらず、ブランチを消した');
    assert.equal(
      fs.readFileSync(path.join(sentinelDir, 'sentinel.txt'), 'utf8'),
      'must survive',
      '判定できないのにリンク先の番兵が消えた',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
