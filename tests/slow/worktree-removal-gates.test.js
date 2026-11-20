'use strict';

// Issue #737 / PR #738 レビュー指摘: 作業場所を削除する各経路で、リンクを外せたか判定できないとき
// 作業場所を消さず、理由を出し、後続の削除手段を呼ばないことを確かめる。
// 検証失敗は実 junction から作れないため、(a) 実ファイルで失敗を作る、(b) 検証関数を preload で
// 差し替える、のどちらかで再現する。すべて一時ディレクトリだけを使う。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { cleanSpawnEnv } = require('../_spawn-env');
const { withTempDir } = require('../../scripts/shared/temp-directory');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const UNLINK_PATH = path.join(SCRIPTS, 'shared', 'unlink-junctions.js');

// 検証関数を「リンクが残った」扱いに差し替える preload。CLI の require より前に読ませる。
function writeLinksRemainPreload(dir) {
  const file = path.join(dir, 'preload-links-remain.js');
  fs.writeFileSync(file, [
    `const uj = require(${JSON.stringify(UNLINK_PATH)});`,
    'uj.unlinkJunctionsAndVerify = () => {',
    "  const e = new Error('test: links remain');",
    "  e.code = 'WORKTREE_LINKS_REMAIN';",
    '  e.paths = [];',
    '  throw e;',
    '};',
  ].join('\n'), 'utf8');
  return file;
}

function gitInit(dir) {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// ── run-review-manager: setup / teardown（実ファイルで検証失敗を作る） ──────────

test('run-review-manager setup: リンクを外せない（readdir 不能）作業場所は削除せず、worktree を作り直さずに throw する', () => {
  withTempDir('ghm-rrm-setup-gate-', (ws) => {
    gitInit(ws);
    const { reviewWorktreeDir } = require('../../scripts/shared/review-manager-paths');
    const { setupReviewWorktree } = require('../../scripts/run-review-manager');
    const dir = reviewWorktreeDir(ws, 9001);
    // 作業場所の位置に通常ファイルを置く。readdir が失敗し、リンクの有無を判定できない状態になる。
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'keep-me', 'utf8');

    assert.throws(
      () => setupReviewWorktree(ws, 9001, () => {}),
      (err) => err.code === 'WORKTREE_LINKS_UNVERIFIABLE',
    );
    // 後続の rmSync・prune・worktreeAdd へ進んでいれば、このファイルは消えているか別物になる
    assert.equal(fs.readFileSync(dir, 'utf8'), 'keep-me', '判定できないのに作業場所へ手を入れた');
  });
});

test('run-review-manager teardown: リンクを外せない作業場所は削除せず、理由を出力する', () => {
  withTempDir('ghm-rrm-teardown-gate-', (ws) => {
    gitInit(ws);
    const { reviewWorktreeDir } = require('../../scripts/shared/review-manager-paths');
    const { teardownReviewWorktree } = require('../../scripts/run-review-manager');
    const dir = reviewWorktreeDir(ws, 9002);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'keep-me', 'utf8');

    const logs = [];
    assert.doesNotThrow(() => teardownReviewWorktree(ws, 9002, (m) => logs.push(m)));
    assert.equal(fs.readFileSync(dir, 'utf8'), 'keep-me', '判定できないのに作業場所を削除した');
    assert.ok(
      logs.some((m) => m.includes('リンクを外せないため worktree を削除しません')),
      `理由が出力されること: ${JSON.stringify(logs)}`,
    );
  });
});

// ── poll-pr: cleanupDetachedSlowWorktree（依存を注入して検証） ──────────────

test('poll-pr cleanupDetachedSlowWorktree: リンク除去の検証が失敗したら worktree 削除も一時ディレクトリ掃除もしない', () => {
  const { cleanupDetachedSlowWorktree } = require('../../scripts/poll-pr');
  const calls = { remove: 0, cleanup: 0 };
  const scope = { cleanup: () => { calls.cleanup += 1; } };
  const failure = Object.assign(new Error('リンクを外せませんでした'), { code: 'WORKTREE_LINKS_REMAIN' });

  assert.throws(
    () => cleanupDetachedSlowWorktree(
      { scope, worktree: '/unused/worktree', workspace: '/unused/ws', worktreeAdded: true },
      {
        unlinkJunctionsFn: () => { throw failure; },
        worktreeRemoveFn: () => { calls.remove += 1; },
      },
    ),
    (err) => err === failure,
  );
  assert.equal(calls.remove, 0, 'リンク検証に失敗したのに git worktree remove を呼んだ');
  assert.equal(calls.cleanup, 0, 'リンク検証に失敗したのに一時ディレクトリを掃除した');
});

test('poll-pr cleanupDetachedSlowWorktree: 事前検証は通り、worktreeRemove 内の再検証だけがリンク検証エラーで失敗しても、一時ルートの掃除をしない', () => {
  const { cleanupDetachedSlowWorktree } = require('../../scripts/poll-pr');
  const calls = { cleanup: 0 };
  const scope = { cleanup: () => { calls.cleanup += 1; } };
  const failure = Object.assign(new Error('worktree remove 内の再検証で失敗'), { code: 'WORKTREE_LINKS_UNVERIFIABLE' });

  assert.throws(
    () => cleanupDetachedSlowWorktree(
      { scope, worktree: '/unused/worktree', workspace: '/unused/ws', worktreeAdded: true },
      {
        unlinkJunctionsFn: () => {},          // 事前検証は成功
        worktreeRemoveFn: () => { throw failure; }, // 2回目の検証だけ失敗
      },
    ),
    (err) => err === failure,
  );
  assert.equal(calls.cleanup, 0, 'リンク検証に失敗したのに一時ルートを再帰削除した');
});

test('poll-pr cleanupDetachedSlowWorktree: リンク除去の検証に成功したときだけ worktree 削除と掃除へ進む（対照）', () => {
  const { cleanupDetachedSlowWorktree } = require('../../scripts/poll-pr');
  const calls = { remove: 0, cleanup: 0 };
  const scope = { cleanup: () => { calls.cleanup += 1; } };

  cleanupDetachedSlowWorktree(
    { scope, worktree: '/unused/worktree', workspace: '/unused/ws', worktreeAdded: true },
    {
      unlinkJunctionsFn: () => {},
      worktreeRemoveFn: () => { calls.remove += 1; },
    },
  );
  assert.equal(calls.remove, 1);
  assert.equal(calls.cleanup, 1);
});

// ── remove-worker / reset-session: CLI 経路（検証関数を preload で失敗させる） ──

test('remove-worker: リンクを外せないときは作業場所を削除せず、理由を出力する', () => {
  withTempDir('ghm-rw-gate-', (ws) => {
    const workerName = 'issue-737-coder-gate';
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(path.join(ghDir, 'worktrees', workerName), { recursive: true });
    const marker = path.join(ghDir, 'worktrees', workerName, 'keep-me.txt');
    fs.writeFileSync(marker, 'keep-me', 'utf8');
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({
      [workerName]: { paneId: '11', issue: 737, skill: 'gh-maestro-coder' },
    }), 'utf8');

    const preload = writeLinksRemainPreload(ws);
    const r = spawnSync(process.execPath, ['-r', preload, path.join(SCRIPTS, 'remove-worker.js'),
      workerName, '--workspace', ws], {
      encoding: 'utf8',
      env: cleanSpawnEnv(),
      timeout: 120000,
    });

    assert.match(r.stderr, /リンクを外せないため worktree を削除しません/, `理由が出力されること: ${r.stderr}`);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep-me', '判定できないのに作業場所の中身を消した');
  });
});

test('reset-session: リンクを外せない作業場所は削除も quarantine もせず、理由を出力する', () => {
  withTempDir('ghm-rs-gate-', (ws) => {
    const wtDir = path.join(ws, '.gh-maestro', 'worktrees', 'leftover-gate');
    fs.mkdirSync(wtDir, { recursive: true });
    const marker = path.join(wtDir, 'keep-me.txt');
    fs.writeFileSync(marker, 'keep-me', 'utf8');

    const preload = writeLinksRemainPreload(ws);
    const r = spawnSync(process.execPath, ['-r', preload, path.join(SCRIPTS, 'reset-session.js'),
      '--workspace', ws, '--quiet'], {
      encoding: 'utf8',
      env: cleanSpawnEnv(),
      timeout: 120000,
    });

    assert.match(r.stderr, /リンクを外せないため削除しません/, `理由が出力されること: ${r.stderr}`);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep-me', '判定できないのに作業場所の中身を消した');
    const worktreesDir = path.join(ws, '.gh-maestro', 'worktrees');
    const orphans = fs.readdirSync(worktreesDir).filter((e) => e.startsWith('__orphan_'));
    assert.deepEqual(orphans, [], '判定できないのに quarantine へ退避した');
  });
});
