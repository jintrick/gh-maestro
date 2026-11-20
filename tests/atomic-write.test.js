'use strict';
// tests/atomic-write.test.js
//
// 共有 atomic write ヘルパー（scripts/shared/atomic-write.js）の単体テスト。
// 実プロセスを spawn しない。
// ただし項目11の並行書き込みテストは「一度きりで自然終了する node サブプロセス」だけを
// spawn する（remove-worker.test.js / worker-exit-hook.test.js と同じ許容範囲）。
// 常駐ポーラー・エージェントCLI・トークン消費は伴わない。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { cleanSpawnEnv } = require('./_spawn-env');

const { atomicWriteJson, atomicWriteTextPair } = require('../scripts/shared/atomic-write');
const ATOMIC_WRITE_PATH = path.join(__dirname, '..', 'scripts', 'shared', 'atomic-write.js');

/** 一時ディレクトリを作り、テスト後に掃除する。コールバックの返すPromiseをawaitする。 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-atomic-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('atomicWriteJson: オブジェクトを JSON として書き出す', async () => {
  await withTempDir((dir) => {
    const target = path.join(dir, 'out.json');
    const result = atomicWriteJson(target, { status: 'running', count: 2 });
    assert.equal(result, target);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { status: 'running', count: 2 });
    // 書き出し後は staging 残骸がない
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteJson: 親ディレクトリを再帰的に作成する', async () => {
  await withTempDir((dir) => {
    const target = path.join(dir, 'a', 'b', 'c', 'out.json');
    atomicWriteJson(target, { ok: true });
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).ok, true);
  });
});

test('atomicWriteJson: 既存ファイルを上書きする（rename は原子的）', async () => {
  await withTempDir((dir) => {
    const target = path.join(dir, 'out.json');
    atomicWriteJson(target, { version: 1 });
    atomicWriteJson(target, { version: 2 });
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 2);
    // 上書き後も staging 残骸がない
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteJson: JSON 直列化不能（循環参照）は throw し、staging 残骸を残さない', async () => {
  await withTempDir((dir) => {
    const target = path.join(dir, 'out.json');
    const circular = { self: null };
    circular.self = circular;
    assert.throws(() => atomicWriteJson(target, circular));
    assert.equal(fs.existsSync(target), false);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteJson: rename 失敗（既存ディレクトリが出力先）は throw し、staging 残骸を残さない', async () => {
  await withTempDir((dir) => {
    // 出力先を既存ディレクトリにすると rename が失敗する（EISDIR/EPERM）
    const target = path.join(dir, 'out.json');
    fs.mkdirSync(target);
    assert.throws(() => atomicWriteJson(target, { ok: true }));
    // staging は掃除されている
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  });
});

test('atomicWriteTextPair: 2ファイルを更新し、退避ファイルとstagingを残さない', async () => {
  await withTempDir((dir) => {
    const first = path.join(dir, 'normative.md');
    const second = path.join(dir, 'adr.md');
    fs.writeFileSync(first, 'old normative', 'utf8');
    const result = atomicWriteTextPair([
      { filePath: first, content: 'new normative', expectedContent: 'old normative' },
      { filePath: second, content: 'new adr', overwrite: false },
    ]);
    assert.deepEqual(result, [first, second]);
    assert.equal(fs.readFileSync(first, 'utf8'), 'new normative');
    assert.equal(fs.readFileSync(second, 'utf8'), 'new adr');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.staging-') || name.includes('.backup-')),
      [],
    );
  });
});

test('atomicWriteTextPair: 2つ目の配置失敗時に1つ目を元へ戻す', async () => {
  await withTempDir((dir) => {
    const first = path.join(dir, 'normative.md');
    const second = path.join(dir, 'adr.md');
    fs.writeFileSync(first, 'old normative', 'utf8');
    const originalRename = fs.renameSync;
    let renameCount = 0;
    fs.renameSync = (source, target) => {
      renameCount += 1;
      if (renameCount === 3) {
        const error = new Error('injected pair install failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(() => atomicWriteTextPair([
        { filePath: first, content: 'new normative', expectedContent: 'old normative' },
        { filePath: second, content: 'new adr', overwrite: false },
      ]), /injected pair install failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.readFileSync(first, 'utf8'), 'old normative');
    assert.equal(fs.existsSync(second), false);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.staging-') || name.includes('.backup-')),
      [],
    );
  });
});

test('atomicWriteTextPair: 既存ファイルの退避失敗時も元ファイルを保持する', async () => {
  await withTempDir((dir) => {
    const first = path.join(dir, 'normative.md');
    const second = path.join(dir, 'adr.md');
    fs.writeFileSync(first, 'old normative', 'utf8');
    const originalRename = fs.renameSync;
    fs.renameSync = () => {
      const error = new Error('injected backup failure');
      error.code = 'EIO';
      throw error;
    };
    try {
      assert.throws(() => atomicWriteTextPair([
        { filePath: first, content: 'new normative', expectedContent: 'old normative' },
        { filePath: second, content: 'new adr', overwrite: false },
      ]), /injected backup failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.readFileSync(first, 'utf8'), 'old normative');
    assert.equal(fs.existsSync(second), false);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.staging-') || name.includes('.backup-')),
      [],
    );
  });
});

// ── Issue #248 項目11: 並行書き込み競合でも破損JSONを作らない ────────────────
// 複数の node サブプロセスが同時に同一ファイルへ atomicWriteJson する。
// staging→rename のアトミック書き込みでは、最後の rename が勝ち、終了後のファイルは
// 必ずいずれか1つの完全なスナップショットに一致する（インターリーブ破損がない）。
// 従来の直接 writeFileSync では部分書き込みが別プロセスの読み取りに観測されうる
// （項目12の readWorkersRaw リトライが防ぐ側面）。ここでは書き込み側の破損が起きない
// ことを検証する。
