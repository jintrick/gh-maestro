'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { linkNodeModules } = require('../scripts/link-node-modules');

function withDirs(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-test-'));
  const workspace  = path.join(base, 'workspace');
  const worktree   = path.join(base, 'worktree');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(worktree,  { recursive: true });
  try {
    return fn(workspace, worktree);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('workspaceにnode_modulesがあればjunctionを作成する', () => {
  withDirs((workspace, worktree) => {
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });

    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 1, `linked: ${linked}`);
    assert.equal(skipped.length, 0);
    assert.equal(missing.length, 0);
    assert.ok(fs.existsSync(path.join(worktree, 'node_modules')));
  });
});

test('workspaceにnode_modulesがなければjunctionは作成されない', () => {
  withDirs((workspace, worktree) => {
    // workspace に node_modules を作らない
    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 0);
    assert.equal(missing.length, 0, 'workspaceにnode_modulesがない場合はエラーではない');
    assert.ok(!fs.existsSync(path.join(worktree, 'node_modules')));
  });
});

test('worktreeにすでにnode_modulesがあればskipする', () => {
  withDirs((workspace, worktree) => {
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(worktree,  'node_modules'), { recursive: true });

    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(missing.length, 0);
  });
});

test('workspaceのサブディレクトリのnode_modulesもjunctionを作成する', () => {
  withDirs((workspace, worktree) => {
    // npm workspaces非hoisted構成: packages/app が自前のnode_modulesを持つ
    const subWorkspace = path.join(workspace, 'packages', 'app');
    const subWorktree  = path.join(worktree,  'packages', 'app');
    fs.mkdirSync(path.join(subWorkspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(subWorktree, { recursive: true });

    const { linked } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 1);
    assert.ok(fs.existsSync(path.join(subWorktree, 'node_modules')));
  });
});

test('hoisted構成ではルートのみjunctionを作成しサブパッケージをmissingにしない', () => {
  withDirs((workspace, worktree) => {
    // npm workspaces hoisted構成: ルートにのみnode_modulesが存在する
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    // packages/app, packages/server はpackage.jsonを持つがnode_modulesを持たない
    const subWs1 = path.join(workspace, 'packages', 'app');
    const subWs2 = path.join(workspace, 'packages', 'server');
    fs.mkdirSync(subWs1, { recursive: true });
    fs.mkdirSync(subWs2, { recursive: true });
    fs.writeFileSync(path.join(subWs1, 'package.json'), '{}');
    fs.writeFileSync(path.join(subWs2, 'package.json'), '{}');

    const { linked, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 1, 'ルートのjunctionのみ作成される');
    assert.equal(missing.length, 0, 'サブパッケージのnode_modules不在はエラーではない');
  });
});

test('node_modulesディレクトリ自体には再帰しない', () => {
  withDirs((workspace, worktree) => {
    // workspace/node_modules/some-pkg/node_modules があっても内部には入らない
    const pkgDir = path.join(workspace, 'node_modules', 'some-pkg');
    fs.mkdirSync(path.join(pkgDir, 'node_modules'), { recursive: true });

    const { linked } = linkNodeModules(worktree, workspace);

    // worktree root の junction 1つのみ（some-pkg/node_modules には入らない）
    assert.equal(linked.length, 1);
  });
});
