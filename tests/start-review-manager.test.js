'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'start-review-manager.js');
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// start-review-manager.js は child-process.js の spawn で
// run-review-manager.js をdetach起動する。
// テストは実プロセスを0個spawnする（.claude/rules/test-process-spawn-safety.md 準拠）。
// spawn はモックに置き換える。
//
// レビュー観点の選択（旧 heavy/directed モード、ASPECTS/--prompt/--brief-file）は廃止した。
// ファイルパターンでの機械的な観点自動判定が一部の観点だけに絞り込んでしまい他の観点の
// レビューが丸ごと欠落する実障害があったため、観点を絞り込むかどうかの判断はオーケストレーター
// 側からは完全に排除し、Review Manager自身がPR diffを見た上で判断する方式に一本化した
// （skills/gh-maestro-reviewer/SKILL.md参照）。start-review-manager.jsは<PR> <REPO> <WORKSPACE>
// だけを受け取り、常に同じ振る舞いでrun-review-manager.jsを起動するだけになった。

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-start-rm-' + Date.now());

before(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

/**
 * start-review-manager.js を、child-process.js の spawn をモックした状態で再ロードする。
 * @param {Function} [spawnImpl] 呼び出しを記録しつつフェイクの子プロセスハンドルを返す
 * @returns {{ mod: object, calls: Array }}
 */
function loadModule(spawnImpl) {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const fake = new EventEmitter();
    fake.unref = () => {};
    if (spawnImpl) spawnImpl(fake, cmd, args, opts);
    return fake;
  };

  const childProcessPath = require.resolve('../scripts/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: { spawn: fakeSpawn, spawnSync: () => ({}), execSync: () => '' },
  };

  const modPath = require.resolve('../scripts/start-review-manager');
  delete require.cache[modPath];
  const mod = require(modPath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

function freshWorkspace(name) {
  const workspace = path.join(tmpBase, name);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

// ── CLIエントリポイント（parseFlags/hasHelpFlagへの統一） ─────────────────────

test('--help はUsageを表示して終了コード0', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node start-review-manager\.js/);
});

test('-h はUsageを表示して終了コード0', () => {
  const r = runCli(['-h']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node start-review-manager\.js/);
});

test('位置引数が不足しているとUsageを表示して終了コード1', () => {
  const r = runCli(['42', 'o/r']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node start-review-manager\.js/);
});

test('位置引数が多すぎるとUsageを表示して終了コード1', () => {
  const r = runCli(['42', 'o/r', '/tmp/ws', 'extra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node start-review-manager\.js/);
});

// ── isLockValid ──────────────────────────────────────────────────────────

test('isLockValid returns false when no lock file exists', () => {
  const { mod } = loadModule();
  assert.equal(mod.isLockValid(path.join(tmpBase, 'no-such.running')), false);
});

test('isLockValid returns true and keeps the file for a live pid', () => {
  const { mod } = loadModule();
  const lockFile = path.join(freshWorkspace('lock-live'), 'lock.running');
  fs.writeFileSync(lockFile, String(process.pid));
  assert.equal(mod.isLockValid(lockFile), true);
  assert.equal(fs.existsSync(lockFile), true);
});

test('isLockValid returns false and removes the file for a stale pid', () => {
  const { mod } = loadModule();
  const lockFile = path.join(freshWorkspace('lock-stale'), 'lock.running');
  // PID 1 は Windows では存在しないため確実に stale として扱われる。
  fs.writeFileSync(lockFile, '999999999');
  assert.equal(mod.isLockValid(lockFile), false);
  assert.equal(fs.existsSync(lockFile), false);
});

// ── startReviewManager ───────────────────────────────────────────────────

test('startReviewManager returns ALREADY_RUNNING and does not spawn when locked', () => {
  const { mod, calls } = loadModule();
  const workspace = freshWorkspace('already-running');
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, 'review-manager-42.running'), String(process.pid));

  const result = mod.startReviewManager('42', 'o/r', workspace);
  assert.equal(result, 'REVIEW_MANAGER_ALREADY_RUNNING');
  assert.equal(calls.length, 0);
});

test('startReviewManager spawns run-review-manager.js with pr/repo/workspace only', () => {
  const { mod, calls } = loadModule();
  const workspace = freshWorkspace('spawns-child');

  const result = mod.startReviewManager('7', 'o/r', workspace);
  assert.equal(result, 'REVIEW_MANAGER_STARTED');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call.args.some(a => a.endsWith('run-review-manager.js')));
  assert.ok(call.args.includes('7'));
  assert.ok(call.args.includes('o/r'));
  assert.ok(call.args.includes(workspace));
  // 観点選択のフラグは一切渡さない（廃止済み）
  assert.equal(call.args.includes('--mode'), false);
  assert.equal(call.args.includes('--brief-file'), false);

  const lockFile = path.join(workspace, '.gh-maestro', 'review-manager-7.running');
  assert.equal(fs.existsSync(lockFile), true);
});

test('startReviewManager rejects a non-numeric pr before touching the filesystem', () => {
  const { mod, calls } = loadModule();
  const workspace = path.join(tmpBase, 'invalid-pr-unused');

  assert.throws(() => mod.startReviewManager('abc', 'o/r', workspace), /invalid PR number/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('startReviewManager rejects a path-traversal pr value before touching the filesystem', () => {
  const { mod, calls } = loadModule();
  const workspace = path.join(tmpBase, 'traversal-pr-unused');

  assert.throws(
    () => mod.startReviewManager('1/../../evil', 'o/r', workspace),
    /invalid PR number/
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('startReviewManager releases the lock file when the child spawn errors', async () => {
  const workspace = freshWorkspace('spawn-error-cleanup');
  const { mod } = loadModule((fake) => {
    // 実装は spawn() の戻り値に対して同期的に .on('error', ...) を登録するため、
    // そのハンドラ登録が完了した後にemitされるよう1ティック遅らせる。
    process.nextTick(() => fake.emit('error', new Error('ENOENT')));
  });

  const result = mod.startReviewManager('21', 'o/r', workspace);
  assert.equal(result, 'REVIEW_MANAGER_STARTED');

  await new Promise((resolve) => setImmediate(resolve));

  const ghDir = path.join(workspace, '.gh-maestro');
  assert.equal(fs.existsSync(path.join(ghDir, 'review-manager-21.running')), false);
});

test('startReviewManager releases the lock file when the child exits', async () => {
  const workspace = freshWorkspace('spawn-exit-cleanup');
  const { mod } = loadModule((fake) => {
    process.nextTick(() => fake.emit('exit', 1));
  });

  const result = mod.startReviewManager('23', 'o/r', workspace);
  assert.equal(result, 'REVIEW_MANAGER_STARTED');

  await new Promise((resolve) => setImmediate(resolve));

  const ghDir = path.join(workspace, '.gh-maestro');
  assert.equal(fs.existsSync(path.join(ghDir, 'review-manager-23.running')), false);
});
