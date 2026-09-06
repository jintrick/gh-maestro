'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const headlessLaunch = require('../../scripts/shared/headless-launch');
const { reviewArtifactPath } = require('../../scripts/shared/review-manager-paths');
const { buildReviewManagerLaunchSpec } = require('../../scripts/shared/worker-factory');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'start-review-manager.js');
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// start-review-manager.js は shared/headless-launch.js の launchAgentHeadless で
// run-review-manager.js を起動する（通常ワーカーと同じ起動基盤・同じ終了フック機構。
// PR #172レビュー指摘: 独自の時間ベースヒューリスティックによる生存確認は、
// worktree構築時間がリポジトリごとに変わるため本質的に脆いと判明し撤去した）。
// テストは実プロセスを0個spawnする。
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
  headlessLaunch._setSpawn(require('../../scripts/shared/child-process').spawn);
  headlessLaunch._setGetProcessStartTime(require('../../scripts/process-lifecycle').getProcessStartTime);
});

function loadModule() {
  delete require.cache[require.resolve('../../scripts/start-review-manager')];
  const mod = require('../../scripts/start-review-manager');
  mod._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
  return mod;
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






// ── startReviewManager ───────────────────────────────────────────────────
