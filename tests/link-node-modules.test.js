'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { linkNodeModules } = require('../lib/link-node-modules');

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
    fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });

    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 1, `linked: ${linked}`);
    assert.equal(skipped.length, 0);
    assert.equal(missing.length, 0);
    assert.ok(fs.existsSync(path.join(worktree, 'node_modules')));
  });
});

test('workspaceにnode_modulesがなければmissingに報告する', () => {
  withDirs((workspace, worktree) => {
    fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
    // workspaceにnode_modulesを作らない

    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 0);
    assert.equal(missing.length, 1, `missing: ${missing}`);
    assert.ok(!fs.existsSync(path.join(worktree, 'node_modules')));
  });
});

test('worktreeにすでにnode_modulesがあればskipする', () => {
  withDirs((workspace, worktree) => {
    fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(worktree,  'node_modules'), { recursive: true });

    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(missing.length, 0);
  });
});

test('package.jsonがなければnode_modulesを作成しない', () => {
  withDirs((workspace, worktree) => {
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    // package.jsonを作らない

    const { linked, skipped, missing } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 0);
    assert.equal(skipped.length, 0);
    assert.equal(missing.length, 0);
    assert.ok(!fs.existsSync(path.join(worktree, 'node_modules')));
  });
});

test('サブディレクトリのpackage.jsonも処理する', () => {
  withDirs((workspace, worktree) => {
    const subWorktree  = path.join(worktree,  'packages', 'app');
    const subWorkspace = path.join(workspace, 'packages', 'app');
    fs.mkdirSync(subWorktree,  { recursive: true });
    fs.mkdirSync(subWorkspace, { recursive: true });
    fs.writeFileSync(path.join(subWorktree,  'package.json'), '{}');
    fs.mkdirSync(path.join(subWorkspace, 'node_modules'), { recursive: true });

    const { linked } = linkNodeModules(worktree, workspace);

    assert.equal(linked.length, 1);
    assert.ok(fs.existsSync(path.join(subWorktree, 'node_modules')));
  });
});

test('node_modulesディレクトリ自体には再帰しない', () => {
  withDirs((workspace, worktree) => {
    // workspace/node_modules/some-pkg/package.json があっても処理しない
    const pkgDir = path.join(workspace, 'node_modules', 'some-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'package.json'), '{}');

    const { linked } = linkNodeModules(worktree, workspace);
    // worktree root の junction 1つのみ（some-pkg は処理しない）
    assert.equal(linked.length, 1);
  });
});
