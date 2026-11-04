'use strict';

// Issue #740: 作業場所を削除する中核手順（リンク確認 → git 削除 → prune → 力ずくの削除）の共有関数。
// 守るべき性質は Issue #737 と同じ: リンクを外せたと確認できないとき、リンク先（作業場所の外）の
// 番兵ファイルを消す操作を一切行わない。番兵はリンク先に置き、「リンクをたどって消す」削除を
// 注入して、共有関数が削除へ進んだ場合に番兵が実際に消えるようにしている。すべて一時ディレクトリだけを使う。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withTempDir } = require('../scripts/shared/temp-directory');
const { removeWorktreeWithLinkGuard } = require('../scripts/shared/worktree-removal');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const SENTINEL = 'must survive';
const FALLBACKS = ['onGitFailure', 'always', 'whenDirRemains'];

function guardError(code) {
  const e = new Error(`test: ${code}`);
  e.code = code;
  return e;
}

// 作業場所に node_modules junction を張り、リンク先（作業場所の外）に番兵を置く。
function setupLinkedWorktree(base) {
  const wt = path.join(base, 'wt');
  const outside = path.join(base, 'outside-node_modules');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), SENTINEL, 'utf8');
  fs.symlinkSync(outside, path.join(wt, 'node_modules'), 'junction');
  return { wt, sentinel: path.join(outside, 'sentinel.txt') };
}

// git worktree remove --force がリンクをたどって中身を消す壊れ方を再現する。
function destroyThroughLink(wt) {
  fs.rmSync(path.join(wt, 'node_modules', 'sentinel.txt'), { force: true });
}

function readSentinel(sentinel) {
  return fs.readFileSync(sentinel, 'utf8');
}

test('removeWorktreeWithLinkGuard: 1回目の確認で失敗したら throw し、どの fallback でも削除段へ進まず番兵を残す', () => {
  for (const fallback of FALLBACKS) {
    withTempDir('ghm-wr-first-', (base) => {
      const { wt, sentinel } = setupLinkedWorktree(base);
      const calls = [];
      const deps = {
        unlinkJunctionsAndVerify: () => { calls.push('unlink'); throw guardError('WORKTREE_LINKS_REMAIN'); },
        worktreeRemove: () => { calls.push('remove'); destroyThroughLink(wt); },
        worktreePrune: () => { calls.push('prune'); },
        forceRemoveFn: () => { calls.push('force'); destroyThroughLink(wt); },
      };

      assert.throws(
        () => removeWorktreeWithLinkGuard(wt, base, { fallback, order: 'pruneFirst', deps }),
        (err) => err.code === 'WORKTREE_LINKS_REMAIN',
        `fallback=${fallback}`,
      );
      assert.deepEqual(calls, ['unlink'], `fallback=${fallback}: 1回目の失敗後に削除段へ進んだ`);
      assert.equal(readSentinel(sentinel), SENTINEL, `fallback=${fallback}: 判定できないのにリンク先の番兵を消した`);
    });
  }
});

test('removeWorktreeWithLinkGuard: git 削除内の2回目の確認で失敗したら throw し、prune と力ずくの削除へ進まず番兵を残す', () => {
  for (const fallback of FALLBACKS) {
    withTempDir('ghm-wr-second-', (base) => {
      const { wt, sentinel } = setupLinkedWorktree(base);
      const calls = [];
      const deps = {
        unlinkJunctionsAndVerify: () => { calls.push('unlink'); },
        // git 削除の内部で2回目の確認が失敗した状態（git は呼ばれず、番兵には触れない）
        worktreeRemove: () => { calls.push('remove'); throw guardError('WORKTREE_LINKS_UNVERIFIABLE'); },
        worktreePrune: () => { calls.push('prune'); },
        forceRemoveFn: () => { calls.push('force'); destroyThroughLink(wt); },
      };

      assert.throws(
        () => removeWorktreeWithLinkGuard(wt, base, { fallback, order: 'forceFirst', deps }),
        (err) => err.code === 'WORKTREE_LINKS_UNVERIFIABLE',
        `fallback=${fallback}`,
      );
      assert.deepEqual(calls, ['unlink', 'remove'], `fallback=${fallback}: 2回目の失敗後に削除段へ進んだ`);
      assert.equal(readSentinel(sentinel), SENTINEL, `fallback=${fallback}: 判定できないのにリンク先の番兵を消した`);
    });
  }
});

test('removeWorktreeWithLinkGuard: リンク以外の git 失敗は throw せず、prune と力ずくの削除へ進む（順序は指定どおり）', () => {
  withTempDir('ghm-wr-gitfail-', (base) => {
    const { wt, sentinel } = setupLinkedWorktree(base);
    const logs = [];
    const calls = [];
    const deps = {
      // 実際の unlink を使う: junction は外れ、リンク先の番兵は残る
      worktreeRemove: () => { calls.push('remove'); throw new Error('git worktree remove exited with 128'); },
      worktreePrune: () => { calls.push('prune'); },
    };

    const r = removeWorktreeWithLinkGuard(wt, base, {
      fallback: 'onGitFailure',
      order: 'pruneFirst',
      log: (m) => logs.push(m),
      deps,
    });

    assert.deepEqual(calls, ['remove', 'prune']);
    assert.equal(r.removed, true, '力ずくの削除後に作業場所が残っている');
    assert.equal(fs.existsSync(wt), false);
    assert.equal(readSentinel(sentinel), SENTINEL, 'junction を外した後の削除でリンク先の番兵が消えた');
    assert.ok(logs.some((m) => m.includes('git worktree remove 失敗')), `理由が記録されること: ${JSON.stringify(logs)}`);
  });
});

test('removeWorktreeWithLinkGuard: forceFirst では力ずくの削除を prune より先に行う', () => {
  withTempDir('ghm-wr-order-', (base) => {
    const { wt } = setupLinkedWorktree(base);
    const calls = [];
    const deps = {
      worktreeRemove: () => { throw new Error('git failed'); },
      worktreePrune: () => { calls.push('prune'); },
      forceRemoveFn: (dir) => { calls.push('force'); fs.rmSync(dir, { recursive: true, force: true }); },
    };

    removeWorktreeWithLinkGuard(wt, base, { fallback: 'onGitFailure', order: 'forceFirst', log: () => {}, deps });

    assert.deepEqual(calls, ['force', 'prune']);
  });
});

test('removeWorktreeWithLinkGuard: git 削除が成功したとき、onGitFailure は prune も力ずくの削除も行わない', () => {
  withTempDir('ghm-wr-ok-', (base) => {
    const { wt } = setupLinkedWorktree(base);
    const calls = [];
    const deps = {
      worktreeRemove: (dir) => { calls.push('remove'); fs.rmSync(dir, { recursive: true, force: true }); },
      worktreePrune: () => { calls.push('prune'); },
      forceRemoveFn: () => { calls.push('force'); },
    };

    const r = removeWorktreeWithLinkGuard(wt, base, { fallback: 'onGitFailure', deps });

    assert.deepEqual(calls, ['remove']);
    assert.equal(r.removed, true);
  });
});

test('removeWorktreeWithLinkGuard: always は git 削除が成功しても prune を行う（作業場所が消えていれば力ずくの削除は行わない）', () => {
  withTempDir('ghm-wr-always-', (base) => {
    const { wt } = setupLinkedWorktree(base);
    const calls = [];
    const deps = {
      worktreeRemove: (dir) => { calls.push('remove'); fs.rmSync(dir, { recursive: true, force: true }); },
      worktreePrune: () => { calls.push('prune'); },
      forceRemoveFn: () => { calls.push('force'); },
    };

    const r = removeWorktreeWithLinkGuard(wt, base, { fallback: 'always', deps });

    assert.deepEqual(calls, ['remove', 'prune']);
    assert.equal(r.removed, true);
  });
});

test('removeWorktreeWithLinkGuard: whenDirRemains は git 削除の後に作業場所が残っているときだけ prune と力ずくの削除を行う', () => {
  withTempDir('ghm-wr-whenremains-', (base) => {
    // 作業場所が消えた場合: prune しない
    const gone = setupLinkedWorktree(path.join(base, 'a'));
    const goneCalls = [];
    const goneDeps = {
      worktreeRemove: (dir) => { goneCalls.push('remove'); fs.rmSync(dir, { recursive: true, force: true }); },
      worktreePrune: () => { goneCalls.push('prune'); },
      forceRemoveFn: () => { goneCalls.push('force'); },
    };
    fs.mkdirSync(path.join(base, 'a'), { recursive: true });
    assert.equal(removeWorktreeWithLinkGuard(gone.wt, base, { fallback: 'whenDirRemains', deps: goneDeps }).removed, true);
    assert.deepEqual(goneCalls, ['remove']);

    // 作業場所が残った場合（git が何もしなかった）: prune の後に力ずくの削除で消える
    const kept = setupLinkedWorktree(path.join(base, 'b'));
    const keptCalls = [];
    const keptDeps = {
      worktreeRemove: () => { keptCalls.push('remove'); },
      worktreePrune: () => { keptCalls.push('prune'); },
      forceRemoveFn: (dir) => { keptCalls.push('force'); fs.rmSync(dir, { recursive: true, force: true }); },
    };
    assert.equal(removeWorktreeWithLinkGuard(kept.wt, base, { fallback: 'whenDirRemains', deps: keptDeps }).removed, true);
    assert.deepEqual(keptCalls, ['remove', 'prune', 'force']);
  });
});

test('removeWorktreeWithLinkGuard: 不正なオプションは削除を始める前に TypeError で止める', () => {
  withTempDir('ghm-wr-badopt-', (base) => {
    const { wt, sentinel } = setupLinkedWorktree(base);
    const calls = [];
    const deps = {
      unlinkJunctionsAndVerify: () => { calls.push('unlink'); },
      worktreeRemove: () => { calls.push('remove'); destroyThroughLink(wt); },
    };
    assert.throws(() => removeWorktreeWithLinkGuard(wt, base, { fallback: 'bogus', deps }), TypeError);
    assert.throws(() => removeWorktreeWithLinkGuard(wt, base, { forceRemove: 'bogus', deps }), TypeError);
    assert.deepEqual(calls, []);
    assert.equal(readSentinel(sentinel), SENTINEL);
  });
});

test('作業場所を削除する4経路は、リンク検証の判定と git 削除を自前で持たず共有関数を通す', () => {
  for (const f of ['remove-worker.js', 'reset-session.js', 'run-review-manager.js', 'spawn-worker.js']) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    assert.equal(src.includes('isLinkGuardError'), false, `${f} が isLinkGuardError を直接判定している`);
    assert.equal(/\bunlinkJunctionsAndVerify\(/.test(src), false, `${f} が unlinkJunctionsAndVerify を直接呼んでいる`);
    assert.equal(/\bworktreeRemove\(/.test(src), false, `${f} が worktreeRemove を直接呼んでいる`);
    assert.ok(src.includes("require('./shared/worktree-removal')"), `${f} が共有関数を使っていない`);
  }
});
