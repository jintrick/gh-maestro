'use strict';
// tests/atomic-write.test.js
//
// 共有 atomic write ヘルパー（scripts/shared/atomic-write.js）の単体テスト。
// 実プロセスを spawn しない（.claude/rules/test-process-spawn-safety.md 準拠）。
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

const { atomicWriteJson } = require('../scripts/shared/atomic-write');
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

// ── Issue #248 項目11: 並行書き込み競合でも破損JSONを作らない ────────────────
// 複数の node サブプロセスが同時に同一ファイルへ atomicWriteJson する。
// staging→rename のアトミック書き込みでは、最後の rename が勝ち、終了後のファイルは
// 必ずいずれか1つの完全なスナップショットに一致する（インターリーブ破損がない）。
// 従来の直接 writeFileSync では部分書き込みが別プロセスの読み取りに観測されうる
// （項目12の readWorkersRaw リトライが防ぐ側面）。ここでは書き込み側の破損が起きない
// ことを検証する。

test('atomicWriteJson: 並行プロセスが同一ファイルへ書き込んでも完全なスナップショットになる', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'workers.json');

    // 各ワーカーは自分の「完全なスナップショット」を1回書き込む。keyは識別用。
    const workers = Array.from({ length: 8 }, (_, i) => `worker-${i}`);

    return new Promise((resolve, reject) => {
      const pending = workers.map((key) => {
        return new Promise((res, rej) => {
          const child = spawn(process.execPath, ['-e', `
            const { atomicWriteJson } = require(${JSON.stringify(ATOMIC_WRITE_PATH)});
            const target = process.env.ATOMIC_TARGET;
            const key = process.env.ATOMIC_KEY;
            // 各プロセスが自分の完全なスナップショットを書く
            atomicWriteJson(target, { [key]: { seq: Number(key.split('-')[1]) } });
          `], {
            env: { ...cleanSpawnEnv(), ATOMIC_TARGET: target, ATOMIC_KEY: key },
            stdio: 'ignore',
          });
          child.on('error', rej);
          child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`spawn exit ${code}`))));
        });
      });

      Promise.all(pending).then(() => {
        try {
          const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
          const keys = Object.keys(raw);
          // 完全なスナップショットのいずれか1つに一致する（部分書き込みが混ざらない）
          assert.equal(keys.length, 1);
          assert.ok(workers.includes(keys[0]), `unknown worker key: ${keys[0]}`);
          assert.equal(raw[keys[0]].seq, Number(keys[0].split('-')[1]));
          // 並行書き込み後も staging 残骸が残らない（各 staging は掃除または rename 済み）
          const staging = fs.readdirSync(dir).filter((f) => f.includes('.staging-'));
          assert.deepEqual(staging, []);
          resolve();
        } catch (e) {
          reject(e);
        }
      }, reject);
    });
  });
});
