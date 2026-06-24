'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { unlinkJunctions } = require('../lib/unlink-junctions');

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
  });
});

test('reset-session.js: robocopyRemove が /XJ フラグを含む（junction を追跡しない）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'scripts', 'reset-session.js'),
    'utf8'
  );
  assert.ok(
    src.includes('/XJ'),
    'reset-session.js の robocopy コマンドに /XJ がない — robocopy が junction を追跡して workspace/node_modules を空にする'
  );
});
