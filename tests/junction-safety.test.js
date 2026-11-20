'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { unlinkJunctions } = require('../scripts/shared/unlink-junctions');

function withDirs(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-junction-test-'));
  try {
    return fn(base);
  } finally {
    // 後片付け：junction が残っていても rmSync は追跡しない
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
}

// junction 作成後に unlinkJunctions を呼んでも、ターゲットの中身が消えないことを確認する。
// Windows junction は lstatSync で isDirectory()=true / isSymbolicLink()=false と見えるため
// 旧実装では junction を通り抜けて再帰し、robocopy /MIR でターゲットを空にする危険があった。
test('unlinkJunctions: junction 除去後もターゲット (workspace/node_modules) の中身が残る', () => {
  withDirs((base) => {
    const workspace = path.join(base, 'workspace');
    const worktree  = path.join(base, 'worktree');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'must survive');
    fs.mkdirSync(worktree, { recursive: true });

    // junction（Windows）または symlink（非Windows）を作成
    fs.symlinkSync(
      path.join(workspace, 'node_modules'),
      path.join(worktree,  'node_modules'),
      'junction'
    );

    // junction 越しにファイルが見えることを確認
    assert.ok(fs.existsSync(path.join(worktree, 'node_modules', 'sentinel.txt')));

    unlinkJunctions(worktree);

    // worktree/node_modules の junction が除去されている
    assert.ok(
      !fs.existsSync(path.join(worktree, 'node_modules')),
      'junction が除去されていない'
    );

    // workspace/node_modules の中身が壊れていない（ここが今回のバグ再現ポイント）
    assert.ok(
      fs.existsSync(path.join(workspace, 'node_modules', 'sentinel.txt')),
      'workspace/node_modules の中身が消えた — unlinkJunctions が junction を追跡して中身を削除した'
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'utf8'),
      'must survive'
    );
  });
});

test('unlinkJunctions: 実ディレクトリと junction が混在しても実ディレクトリの中身は壊れない', () => {
  withDirs((base) => {
    const workspace = path.join(base, 'workspace');
    const worktree  = path.join(base, 'worktree');

    // workspace/node_modules に番兵ファイル
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'must survive');

    // worktree に実ディレクトリ src/ と junction node_modules/
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'index.js'), '// keep');
    fs.symlinkSync(
      path.join(workspace, 'node_modules'),
      path.join(worktree,  'node_modules'),
      'junction'
    );

    unlinkJunctions(worktree);

    // junction は除去
    assert.ok(!fs.existsSync(path.join(worktree, 'node_modules')));
    // ターゲットは無傷
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules', 'sentinel.txt')));
    // 実ディレクトリ src/ の中身も残る（junction 除去の際に実ディレクトリを壊さない）
    assert.equal(fs.readFileSync(path.join(worktree, 'src', 'index.js'), 'utf8'), '// keep');
  });
});

test('reset-session.js: robocopyRemove が /XJ フラグを含む（junction を追跡しない）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'reset-session.js'),
    'utf8'
  );
  assert.ok(
    src.includes('/XJ'),
    'reset-session.js の robocopy コマンドに /XJ がない — robocopy が junction を追跡して workspace/node_modules を空にする'
  );
});

// ── unlinkJunctionsAndVerify（Issue #737） ─────────────────────────────────
// 削除の前に「リンクが1つも残っていない」ことを確かめる関数。確かめられなければ throw する。
const { unlinkJunctionsAndVerify } = require('../scripts/shared/unlink-junctions');

test('unlinkJunctionsAndVerify: junction を外せたら throw せず、リンク先の番兵も残る', () => {
  withDirs((base) => {
    const workspace = path.join(base, 'workspace');
    const worktree  = path.join(base, 'worktree');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'must survive');
    fs.mkdirSync(worktree, { recursive: true });
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(worktree, 'node_modules'), 'junction');

    assert.doesNotThrow(() => unlinkJunctionsAndVerify(worktree));
    assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), false, 'junction が外れていない');
    assert.equal(fs.readFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'utf8'), 'must survive');
  });
});

test('unlinkJunctionsAndVerify: dir が存在しなければ何もせず throw しない', () => {
  withDirs((base) => {
    assert.doesNotThrow(() => unlinkJunctionsAndVerify(path.join(base, 'absent')));
  });
});

test('unlinkJunctionsAndVerify: リンクが残ったら WORKTREE_LINKS_REMAIN で throw し、残ったパスを示す', () => {
  withDirs((base) => {
    const workspace = path.join(base, 'workspace');
    const worktree  = path.join(base, 'worktree');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const link = path.join(worktree, 'node_modules');
    fs.symlinkSync(path.join(workspace, 'node_modules'), link, 'junction');

    // 外す処理が何もしなかった場合を注入で再現する（実際にリンクが残る状態）
    assert.throws(
      () => unlinkJunctionsAndVerify(worktree, { unlinkFn: () => {} }),
      (err) => err.code === 'WORKTREE_LINKS_REMAIN' && Array.isArray(err.paths) && err.paths.includes(link)
    );
    // 判定に失敗しても、リンク先の中身は消えない
    assert.ok(fs.existsSync(path.join(workspace, 'node_modules')));
  });
});

test('unlinkJunctionsAndVerify: 木を読めない（readdir 失敗）場合は WORKTREE_LINKS_UNVERIFIABLE で throw する', () => {
  withDirs((base) => {
    // ディレクトリではなくファイルを dir として渡すと、existsSync は真だが readdir が失敗する
    const notADir = path.join(base, 'not-a-dir');
    fs.writeFileSync(notADir, 'x');
    assert.throws(
      () => unlinkJunctionsAndVerify(notADir),
      (err) => err.code === 'WORKTREE_LINKS_UNVERIFIABLE'
    );
  });
});

// ── PR #738 レビュー指摘: junction の判定を isSymbolicLink() だけに頼らない ──────
test('unlinkJunctionsAndVerify: isSymbolicLink()=false に見える junction（Windows の stat 形）も残存リンクとして throw し、リンク先をたどらない', () => {
  withDirs((base) => {
    const workspace = path.join(base, 'workspace');
    const worktree  = path.join(base, 'worktree');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'must survive');
    fs.mkdirSync(worktree, { recursive: true });
    const link = path.join(worktree, 'node_modules');
    fs.symlinkSync(path.join(workspace, 'node_modules'), link, 'junction');

    const { lstatSync } = fs;
    // Windows の junction は isDirectory()=true / isSymbolicLink()=false と見える環境を再現する
    const windowsShapedLstat = (p) => {
      const st = lstatSync(p);
      if (p !== link) return st;
      return { isSymbolicLink: () => false, isDirectory: () => true };
    };
    // 外す処理は何もしない（残った junction を検出できるかだけを見る）
    assert.throws(
      () => unlinkJunctionsAndVerify(worktree, { unlinkFn: () => {}, lstatFn: windowsShapedLstat }),
      (err) => err.code === 'WORKTREE_LINKS_REMAIN' && Array.isArray(err.paths) && err.paths.includes(link),
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, 'node_modules', 'sentinel.txt'), 'utf8'),
      'must survive',
    );
  });
});

test('unlinkJunctionsAndVerify: readlink が判定不能（EACCES）なら、通常ディレクトリでも UNVERIFIABLE で throw する', () => {
  withDirs((base) => {
    const worktree = path.join(base, 'worktree');
    // 空ディレクトリは既定の外し処理が消してしまうため、中身を入れて検証まで届かせる
    fs.mkdirSync(path.join(worktree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'sub', 'keep.txt'), 'x');
    const readlinkFn = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
    assert.throws(
      () => unlinkJunctionsAndVerify(worktree, { readlinkFn }),
      (err) => err.code === 'WORKTREE_LINKS_UNVERIFIABLE',
    );
  });
});

test('unlinkJunctionsAndVerify: lstat が失敗したら UNVERIFIABLE で throw する', () => {
  withDirs((base) => {
    const worktree = path.join(base, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'x');
    const lstatFn = () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; };
    assert.throws(
      () => unlinkJunctionsAndVerify(worktree, { lstatFn }),
      (err) => err.code === 'WORKTREE_LINKS_UNVERIFIABLE',
    );
  });
});
