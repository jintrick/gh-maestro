'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'gh-maestro-reviewer', 'scripts', 'get-review-policy.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('--workspace 引数なしでエラー終了する', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('グローバルポリシーのみ存在する場合に内容を出力する', () => {
  withTempDir(fakeHome => {
    const globalDir = path.join(fakeHome, '.gh-maestro');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'review-policy.md'), '# Global Policy\nHello', 'utf8');

    withTempDir(workspace => {
      const r = run(['--workspace', workspace], {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Global Policy/);
    });
  });
});

test('プロジェクト固有ポリシーがグローバルポリシーにマージされる', () => {
  withTempDir(fakeHome => {
    const globalDir = path.join(fakeHome, '.gh-maestro');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'review-policy.md'), '# Global', 'utf8');

    withTempDir(workspace => {
      const projectDir = path.join(workspace, '.gh-maestro');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'review-policy.md'), '# Project Specific', 'utf8');

      const r = run(['--workspace', workspace], {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Global/);
      assert.match(r.stdout, /Project Specific/);
      assert.match(r.stdout, /プロジェクト固有ポリシー/);
    });
  });
});

test('ポリシーファイルが存在しない場合に警告を出して終了コード0で返る', () => {
  withTempDir(fakeHome => {
    withTempDir(workspace => {
      const r = run(['--workspace', workspace], {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /Warning/);
    });
  });
});
