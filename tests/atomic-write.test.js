'use strict';
// tests/atomic-write.test.js
//
// 共有 atomic write ヘルパー（scripts/shared/atomic-write.js）の単体テスト。
// 実プロセスを spawn しない（.claude/rules/test-process-spawn-safety.md 準拠）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atomicWriteJson } = require('../scripts/shared/atomic-write');

/** 一時ディレクトリを作り、テスト後に掃除する。 */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-atomic-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('atomicWriteJson: オブジェクトを JSON として書き出す', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'out.json');
    const result = atomicWriteJson(target, { status: 'running', count: 2 });
    assert.equal(result, target);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { status: 'running', count: 2 });
    // 書き出し後は staging 残骸がない
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteJson: 親ディレクトリを再帰的に作成する', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'a', 'b', 'c', 'out.json');
    atomicWriteJson(target, { ok: true });
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).ok, true);
  });
});

test('atomicWriteJson: 既存ファイルを上書きする（rename は原子的）', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'out.json');
    atomicWriteJson(target, { version: 1 });
    atomicWriteJson(target, { version: 2 });
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 2);
    // 上書き後も staging 残骸がない
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteJson: JSON 直列化不能（循環参照）は throw し、staging 残骸を残さない', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'out.json');
    const circular = { self: null };
    circular.self = circular;
    assert.throws(() => atomicWriteJson(target, circular));
    assert.equal(fs.existsSync(target), false);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteJson: rename 失敗（既存ディレクトリが出力先）は throw し、staging 残骸を残さない', () => {
  withTempDir((dir) => {
    // 出力先を既存ディレクトリにすると rename が失敗する（EISDIR/EPERM）
    const target = path.join(dir, 'out.json');
    fs.mkdirSync(target);
    assert.throws(() => atomicWriteJson(target, { ok: true }));
    // staging は掃除されている
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});
