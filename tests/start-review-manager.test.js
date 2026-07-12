'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// start-review-manager.js は child-process.js の spawn で
// run-review-manager.js をdetach起動する。
// テストは実プロセスを0個spawnする（.claude/rules/test-process-spawn-safety.md 準拠）。
// spawn はモックに置き換える。

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

// ── resolveMode ──────────────────────────────────────────────────────────

test('resolveMode defaults to heavy when unspecified', () => {
  const { mod } = loadModule();
  assert.equal(mod.resolveMode({}), 'heavy');
});

test('resolveMode accepts directed', () => {
  const { mod } = loadModule();
  assert.equal(mod.resolveMode({ mode: 'directed' }), 'directed');
});

test('resolveMode rejects unknown mode', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.resolveMode({ mode: 'light' }), /invalid mode/);
});

// ── resolveDirectedBrief ─────────────────────────────────────────────────

test('resolveDirectedBrief returns promptText when given', () => {
  const { mod } = loadModule();
  assert.equal(mod.resolveDirectedBrief({ promptText: '正しさだけを見る' }), '正しさだけを見る');
});

test('resolveDirectedBrief reads briefFile when given', () => {
  const { mod } = loadModule();
  const workspace = freshWorkspace('brief-file');
  const briefPath = path.join(workspace, 'brief.md');
  fs.writeFileSync(briefPath, '命名と可読性だけを見る', 'utf8');
  assert.equal(mod.resolveDirectedBrief({ briefFile: briefPath }), '命名と可読性だけを見る');
});

test('resolveDirectedBrief rejects both promptText and briefFile', () => {
  const { mod } = loadModule();
  assert.throws(
    () => mod.resolveDirectedBrief({ promptText: 'a', briefFile: 'b.md' }),
    /同時に指定できません/
  );
});

test('resolveDirectedBrief rejects neither promptText nor briefFile', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.resolveDirectedBrief({}), /必要です/);
});

test('resolveDirectedBrief rejects a missing briefFile', () => {
  const { mod } = loadModule();
  assert.throws(
    () => mod.resolveDirectedBrief({ briefFile: path.join(tmpBase, 'does-not-exist.md') }),
    /brief file not found/
  );
});

// ── buildAspectsBrief ────────────────────────────────────────────────────

test('buildAspectsBrief includes every given aspect name', () => {
  const { mod } = loadModule();
  const brief = mod.buildAspectsBrief(['api-contract', 'concurrency']);
  assert.match(brief, /api-contract/);
  assert.match(brief, /concurrency/);
});

test('buildAspectsBrief rejects an empty aspect list', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.buildAspectsBrief([]), /1件以上の観点が必要です/);
});

test('buildAspectsBrief rejects a non-array input', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.buildAspectsBrief(undefined), /1件以上の観点が必要です/);
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

test('startReviewManager defaults to heavy mode and spawns run-review-manager.js', () => {
  const { mod, calls } = loadModule();
  const workspace = freshWorkspace('heavy-default');

  const result = mod.startReviewManager('7', 'o/r', workspace);
  assert.equal(result, 'REVIEW_MANAGER_STARTED');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call.args.includes('--mode'));
  assert.equal(call.args[call.args.indexOf('--mode') + 1], 'heavy');
  assert.equal(call.args.includes('--brief-file'), false);

  const lockFile = path.join(workspace, '.gh-maestro', 'review-manager-7.running');
  assert.equal(fs.existsSync(lockFile), true);
});

test('startReviewManager passes directed mode and a brief-file copy of the prompt text', () => {
  const { mod, calls } = loadModule();
  const workspace = freshWorkspace('directed-prompt');

  const result = mod.startReviewManager('9', 'o/r', workspace, {
    mode: 'directed',
    promptText: 'CLI surface changeだけを見る',
  });
  assert.equal(result, 'REVIEW_MANAGER_STARTED');
  const [call] = calls;
  assert.equal(call.args[call.args.indexOf('--mode') + 1], 'directed');
  const briefFileArg = call.args[call.args.indexOf('--brief-file') + 1];
  assert.equal(fs.readFileSync(briefFileArg, 'utf8'), 'CLI surface changeだけを見る');
});

test('startReviewManager rejects directed mode without a prompt and does not create a lock', () => {
  const { mod, calls } = loadModule();
  const workspace = freshWorkspace('directed-missing-prompt');

  assert.throws(() => mod.startReviewManager('11', 'o/r', workspace, { mode: 'directed' }));
  assert.equal(calls.length, 0);
  const lockFile = path.join(workspace, '.gh-maestro', 'review-manager-11.running');
  assert.equal(fs.existsSync(lockFile), false);
});

test('startReviewManager rejects an invalid mode before touching the filesystem', () => {
  const { mod, calls } = loadModule();
  const workspace = path.join(tmpBase, 'invalid-mode-unused');

  assert.throws(() => mod.startReviewManager('13', 'o/r', workspace, { mode: 'light' }));
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
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

test('startReviewManager releases both lock and brief files when the child spawn errors', async () => {
  const workspace = freshWorkspace('spawn-error-cleanup');
  const { mod } = loadModule((fake) => {
    // 実装は spawn() の戻り値に対して同期的に .on('error', ...) を登録するため、
    // そのハンドラ登録が完了した後にemitされるよう1ティック遅らせる。
    process.nextTick(() => fake.emit('error', new Error('ENOENT')));
  });

  const result = mod.startReviewManager('21', 'o/r', workspace, {
    mode: 'directed',
    promptText: '正しさだけを見る',
  });
  assert.equal(result, 'REVIEW_MANAGER_STARTED');

  await new Promise((resolve) => setImmediate(resolve));

  const ghDir = path.join(workspace, '.gh-maestro');
  assert.equal(fs.existsSync(path.join(ghDir, 'review-manager-21.running')), false);
  assert.equal(fs.existsSync(path.join(ghDir, 'review-manager-21-brief.md')), false);
});

test('startReviewManager releases both lock and brief files when the child exits', async () => {
  const workspace = freshWorkspace('spawn-exit-cleanup');
  const { mod } = loadModule((fake) => {
    process.nextTick(() => fake.emit('exit', 1));
  });

  const result = mod.startReviewManager('23', 'o/r', workspace, {
    mode: 'directed',
    promptText: '命名と可読性だけを見る',
  });
  assert.equal(result, 'REVIEW_MANAGER_STARTED');

  await new Promise((resolve) => setImmediate(resolve));

  const ghDir = path.join(workspace, '.gh-maestro');
  assert.equal(fs.existsSync(path.join(ghDir, 'review-manager-23.running')), false);
  assert.equal(fs.existsSync(path.join(ghDir, 'review-manager-23-brief.md')), false);
});
