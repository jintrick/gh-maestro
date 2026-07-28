'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const headlessLaunch = require('../scripts/shared/headless-launch');
const { readRegistry } = require('../scripts/shared/execution-registry');
const { reviewArtifactPath } = require('../scripts/shared/review-manager-paths');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'start-review-manager.js');
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// start-review-manager.js は shared/headless-launch.js の launchAgentHeadless で
// run-review-manager.js を起動する（通常ワーカーと同じ起動基盤・同じ終了フック機構。
// PR #172レビュー指摘: 独自の時間ベースヒューリスティックによる生存確認は、
// worktree構築時間がリポジトリごとに変わるため本質的に脆いと判明し撤去した）。
// テストは実プロセスを0個spawnする（.claude/rules/test-process-spawn-safety.md 準拠）。
// headless-launch.js 自身の spawn 注入機構（_setSpawn）をそのまま使う
// （headless-launch.test.js と同じパターン）。

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-start-rm-' + Date.now());

before(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

let spawnCalls;

function fakeSpawn({ pid = 55501 } = {}) {
  return (cmd, args, options) => {
    spawnCalls.push({ cmd, args, options });
    return {
      pid,
      handlers: {},
      on(event, fn) { this.handlers[event] = fn; return this; },
      unref() {},
    };
  };
}

beforeEach(() => {
  spawnCalls = [];
  headlessLaunch._setSpawn(fakeSpawn());
  headlessLaunch._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
});

afterEach(() => {
  headlessLaunch._setSpawn(require('../scripts/child-process').spawn);
  headlessLaunch._setGetProcessStartTime(require('../scripts/process-lifecycle').getProcessStartTime);
});

function loadModule() {
  delete require.cache[require.resolve('../scripts/start-review-manager')];
  return require('../scripts/start-review-manager');
}

function freshWorkspace(name) {
  const workspace = path.join(tmpBase, name);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** シムに渡されたJSON argv（ログインシェルでラップ済み）をデコードする。 */
function decodedShellCommand(call) {
  const shellArgs = JSON.parse(call.args[1]);
  if (process.platform === 'win32') {
    return Buffer.from(shellArgs[3], 'base64').toString('utf16le');
  }
  return shellArgs[2];
}

// ── CLIエントリポイント ─────────────────────────────────────────────────────

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

test('位置引数が不足している（ISSUE無し）とUsageを表示して終了コード1', () => {
  const r = runCli(['42', 'o/r', '/tmp/ws']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node start-review-manager\.js/);
});

test('位置引数が多すぎるとUsageを表示して終了コード1', () => {
  const r = runCli(['42', 'o/r', '/tmp/ws', '7', 'extra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: node start-review-manager\.js/);
});

// ── isLockValid ──────────────────────────────────────────────────────────

test('isLockValid returns false when no lock file exists', () => {
  const mod = loadModule();
  assert.equal(mod.isLockValid(path.join(tmpBase, 'no-such.running')), false);
});

test('isLockValid returns true and keeps the file for a live pid', () => {
  const mod = loadModule();
  const lockFile = path.join(freshWorkspace('lock-live'), 'lock.running');
  fs.writeFileSync(lockFile, String(process.pid));
  assert.equal(mod.isLockValid(lockFile), true);
  assert.equal(fs.existsSync(lockFile), true);
});

test('isLockValid returns false and removes the file for a stale pid', () => {
  const mod = loadModule();
  const lockFile = path.join(freshWorkspace('lock-stale'), 'lock.running');
  // PID 999999999 は確実に stale として扱われる。
  fs.writeFileSync(lockFile, '999999999');
  assert.equal(mod.isLockValid(lockFile), false);
  assert.equal(fs.existsSync(lockFile), false);
});

// ── startReviewManager ───────────────────────────────────────────────────

test('startReviewManager returns ALREADY_RUNNING and does not launch when locked', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('already-running');
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, 'review-manager-42.running'), String(process.pid));

  const result = mod.startReviewManager('42', 'o/r', workspace, '5');
  assert.equal(result, 'REVIEW_MANAGER_ALREADY_RUNNING');
  assert.equal(spawnCalls.length, 0);
});

test('startReviewManager rejects a non-numeric pr before touching the filesystem', () => {
  const mod = loadModule();
  const workspace = path.join(tmpBase, 'invalid-pr-unused');
  assert.throws(() => mod.startReviewManager('abc', 'o/r', workspace, '5'), /invalid PR number/);
  assert.equal(spawnCalls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('startReviewManager rejects a path-traversal pr value before touching the filesystem', () => {
  const mod = loadModule();
  const workspace = path.join(tmpBase, 'traversal-pr-unused');
  assert.throws(
    () => mod.startReviewManager('1/../../evil', 'o/r', workspace, '5'),
    /invalid PR number/
  );
  assert.equal(spawnCalls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('startReviewManager rejects a missing/invalid issue number before touching the filesystem', () => {
  const mod = loadModule();
  const workspace = path.join(tmpBase, 'invalid-issue-unused');
  assert.throws(() => mod.startReviewManager('7', 'o/r', workspace, 'abc'), /invalid issue number/);
  assert.throws(() => mod.startReviewManager('7', 'o/r', workspace, undefined), /invalid issue number/);
  assert.equal(spawnCalls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('startReviewManager launches run-review-manager.js via launchAgentHeadless（ログインシェル経由・通常ワーカーと同じ起動基盤）', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('launches-headless');

  const result = mod.startReviewManager('7', 'o/r', workspace, '55');
  assert.equal(result, 'REVIEW_MANAGER_STARTED');
  assert.equal(spawnCalls.length, 1);

  const decoded = decodedShellCommand(spawnCalls[0]);
  assert.match(decoded, /run-review-manager\.js/);
  assert.match(decoded, /'7'/);
  assert.match(decoded, /'o\/r'/);

  // GH_MAESTRO_WORKER は issue-<N>- パターンに合わせる（worker-exit-hook.jsのIssue番号
  // 導出・msg-send.jsのワーカーコンテキスト判定をそのまま再利用するため）。
  assert.match(decoded, /GH_MAESTRO_WORKER='issue-55-review-manager-pr-7'/);
  assert.match(decoded, /GH_MAESTRO_WORKSPACE=/);

  // onExitフックは通常ワーカーと同じ worker-exit-hook.js
  assert.match(decoded, /worker-exit-hook\.js/);
});

test('startReviewManager: ロックファイルにlaunchAgentHeadlessが返した実pidを書く', () => {
  headlessLaunch._setSpawn(fakeSpawn({ pid: 77701 }));
  const mod = loadModule();
  const workspace = freshWorkspace('lock-pid');

  mod.startReviewManager('8', 'o/r', workspace, '55');

  const lockFile = path.join(workspace, '.gh-maestro', 'review-manager-8.running');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '77701');
});

test('startReviewManager: execution registryにrunning状態で記録する', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('execution-registry');

  mod.startReviewManager('9', 'o/r', workspace, '55');

  const registry = readRegistry(workspace);
  const entries = Object.values(registry).filter(e => e.workerName === 'issue-55-review-manager-pr-9');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'running');
  assert.equal(entries[0].issue, 55);
  assert.equal(entries[0].skill, 'gh-maestro-reviewer');
});

test('startReviewManager: ログパスはreviewArtifactPath(.log)（worker-logs配下、通常ワーカーと共通）', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('log-path');

  mod.startReviewManager('10', 'o/r', workspace, '55');

  const expectedLogPath = reviewArtifactPath(path.join(workspace, '.gh-maestro'), '10', '.log');
  assert.equal(spawnCalls[0].args[2], expectedLogPath);
});
