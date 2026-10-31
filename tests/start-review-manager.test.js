'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const headlessLaunch = require('../scripts/shared/headless-launch');
const { reviewArtifactPath } = require('../scripts/shared/review-manager-paths');
const { buildReviewManagerLaunchSpec } = require('../scripts/shared/worker-factory');

const { createLiveness, RESOURCE_KEY_ENV, INSTANCE_ID_ENV } = require('../scripts/shared/process-liveness');
// 起動側と偽の shim が同じ OS 資源の表を共有するよう、1つの liveness を使い回す。
let sharedLiveness = null;
const makeLiveness = (probePid = () => 'alive') => {
  sharedLiveness = createLiveness({ probePid, readStartTime: () => '2026-07-25T00:00:00.000Z' });
  return sharedLiveness;
};
let killedPids = [];

const SCRIPT = path.join(__dirname, '..', 'scripts', 'start-review-manager.js');
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

function fakeSpawn({ pid = 55501, claimEndpoint = true } = {}) {
  return (cmd, args, options) => {
    spawnCalls.push({ cmd, args, options });
    // 実際の shim は起動後に自分の endpoint を claim する。偽の shim ではそれを模擬する。
    if (claimEndpoint && sharedLiveness && options && options.env) {
      sharedLiveness.captureProcess(pid, {
        resourceKey: options.env[RESOURCE_KEY_ENV],
        instanceId: options.env[INSTANCE_ID_ENV],
      });
    }
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
  killedPids = [];
  headlessLaunch._setSpawn(fakeSpawn());
  headlessLaunch._setLiveness(makeLiveness());
});

afterEach(() => {
  headlessLaunch._setSpawn(require('../scripts/shared/child-process').spawn);
  headlessLaunch._setLiveness(null);
});

function loadModule() {
  delete require.cache[require.resolve('../scripts/start-review-manager')];
  const mod = require('../scripts/start-review-manager');
  mod._setLiveness(sharedLiveness || makeLiveness());
  mod._setKillProcessTree((pid) => { killedPids.push(pid); });
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





// ── isLockValid ──────────────────────────────────────────────────────────

test('isLockValid returns false when no lock file exists', () => {
  const mod = loadModule();
  assert.equal(mod.isLockValid(path.join(tmpBase, 'no-such.running')), false);
});

test('isLockValid returns true and keeps the file for a live pid', () => {
  const mod = loadModule();
  const lockFile = path.join(freshWorkspace('lock-live'), 'lock.running');
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid,
    resourceKey: 'live-review-manager',
    instanceId: 'live-review-manager-instance',
    startTime: '2026-07-25T00:00:00.000Z',
  }));

  assert.equal(mod.isLockValid(lockFile), true);
  assert.equal(fs.existsSync(lockFile), true);
});

test('isLockValid returns false and removes the file for a stale pid', () => {
  const mod = loadModule();
  const lockFile = path.join(freshWorkspace('lock-stale'), 'lock.running');
  // PID 999999999 は確実に stale として扱われる。
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, resourceKey: 'dead-review-manager', instanceId: 'dead-review-manager-instance' }));
  mod._setLiveness(makeLiveness(() => 'dead'));
  assert.equal(mod.isLockValid(lockFile), false);
  assert.equal(fs.existsSync(lockFile), false);
});

test('isLockValid は旧PID-onlyを持ち主のいない stale として回収し、起動を止めない', () => {
  const mod = loadModule();
  const lockFile = path.join(freshWorkspace('lock-legacy-live'), 'lock.running');
  fs.writeFileSync(lockFile, `${process.pid}\n`, 'utf8');
  assert.equal(mod.isLockValid(lockFile), false);
  assert.equal(fs.existsSync(lockFile), false);
});

// ── startReviewManager ───────────────────────────────────────────────────

test('startReviewManager returns ALREADY_RUNNING and does not launch when locked', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('already-running');
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const lockFile = path.join(ghDir, 'records', 'pr', '42', 'review', 'manager.running');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid,
    resourceKey: 'already-running-manager',
    instanceId: 'already-running-manager-instance',
    startTime: '2026-07-25T00:00:00.000Z',
  }));


  const result = mod.startReviewManager('42', 'o/r', workspace, '5');
  assert.equal(result, 'REVIEW_MANAGER_ALREADY_RUNNING');
  assert.equal(spawnCalls.length, 0);
});

test('startReviewManager rejects a non-numeric or path-traversal pr before touching the filesystem', () => {
  const mod = loadModule();
  // 非数値（abc・空文字、統合元: 183）とパストラバーサル（統合元の検査）を同じ経路で拒否する
  for (const pr of ['abc', '', '1/../../evil']) {
    const workspace = path.join(tmpBase, `invalid-pr-unused-${pr.length}-${Math.random().toString(36).slice(2)}`);
    assert.throws(() => mod.startReviewManager(pr, 'o/r', workspace, '5'), /invalid PR number/, `pr=${JSON.stringify(pr)}`);
    assert.equal(fs.existsSync(workspace), false);
  }
  assert.equal(spawnCalls.length, 0);
});

test('startReviewManager rejects a missing/invalid issue number before touching the filesystem', () => {
  const mod = loadModule();
  const workspace = path.join(tmpBase, 'invalid-issue-unused');
  assert.throws(() => mod.startReviewManager('7', 'o/r', workspace, 'abc'), /invalid issue number/);
  assert.throws(() => mod.startReviewManager('7', 'o/r', workspace, undefined), /invalid issue number/);
  assert.equal(spawnCalls.length, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('startReviewManager launches run-review-manager.js via launchAgentHeadless（ログインシェル経由・通常ワーカーと同じ起動基盤。Phase 5: issueも構造化引数として渡す）', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('launches-headless');

  const result = mod.startReviewManager('7', 'o/r', workspace, '55');
  assert.equal(result, 'REVIEW_MANAGER_STARTED');
  assert.equal(spawnCalls.length, 1);

  const decoded = decodedShellCommand(spawnCalls[0]);
  assert.match(decoded, /run-review-manager\.js/);
  assert.match(decoded, /'7'/);
  assert.match(decoded, /'o\/r'/);
  // Phase 5: issue が第4位置引数として渡される
  assert.match(decoded, /'55'/);

  // GH_MAESTRO_WORKER は issue-<N>- パターンに合わせる（worker-exit-hook.jsのIssue番号
  // 導出・msg-send.jsのワーカーコンテキスト判定をそのまま再利用するため）。
  assert.match(decoded, /GH_MAESTRO_WORKER='issue-55-review-manager-pr-7'/);
  assert.match(decoded, /GH_MAESTRO_WORKSPACE=/);

  // onExitフックは通常ワーカーと同じ worker-exit-hook.js（shimへ渡す）
  const exitHook = JSON.parse(spawnCalls[0].args[3]);
  assert.match(exitHook.args[0], /worker-exit-hook\.js/);
});

test('startReviewManager: 起動側はmanager.runningを書かず、起動予約へshimを引き渡す', () => {
  headlessLaunch._setSpawn(fakeSpawn({ pid: 77701 }));
  const mod = loadModule();
  const workspace = freshWorkspace('lock-pid');

  mod.startReviewManager('8', 'o/r', workspace, '55');

  const lockFile = path.join(workspace, '.gh-maestro', 'records', 'pr', '8', 'review', 'manager.running');
  const startingFile = path.join(workspace, '.gh-maestro', 'records', 'pr', '8', 'review', 'manager.starting');
  assert.equal(fs.existsSync(lockFile), false, '起動側は本体所有のmanager.runningを書かない');
  const marker = JSON.parse(fs.readFileSync(startingFile, 'utf8'));
  assert.equal(marker.pid, 77701);
  assert.equal(typeof marker.resourceKey, 'string');
  assert.equal(marker.startTime, undefined);
  assert.match(marker.token, /^[0-9a-f]{32}$/);
});

test('startReviewManager: manager.runningが本体書き込み前でも起動予約で二重起動を拒否する', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('startup-window');


  assert.equal(mod.startReviewManager('11', 'o/r', workspace, '55'), 'REVIEW_MANAGER_STARTED');
  const runningFile = path.join(workspace, '.gh-maestro', 'records', 'pr', '11', 'review', 'manager.running');
  assert.equal(fs.existsSync(runningFile), false, '本体がまだmanager.runningを書いていない状態');

  assert.equal(mod.startReviewManager('11', 'o/r', workspace, '55'), 'REVIEW_MANAGER_ALREADY_RUNNING');
  assert.equal(spawnCalls.length, 1, '起動予約がある間は2本目を起動しない');
});

test('startReviewManager: 起動処理を終えたら起動予約 endpoint を手放し、本体の終了後は同じプロセスからでも再開できる', () => {
  let shimDead = false;
  headlessLaunch._setLiveness(makeLiveness((pid) => (pid === 55501 && shimDead ? 'dead' : 'alive')));
  const mod = loadModule();
  const workspace = freshWorkspace('startup-endpoint-released');
  const startupEndpoint = { workspace, kind: 'review-manager-startup', name: '12' };

  assert.equal(mod.startReviewManager('12', 'o/r', workspace, '55'), 'REVIEW_MANAGER_STARTED');
  assert.equal(sharedLiveness.observeResource(startupEndpoint).state, 'dead',
    '常駐する呼び出し元（poll-pr）が起動予約 endpoint を保持し続けない');

  // 起動した本体がいる間は、起動予約（manager.starting）の所有者で二重起動を拒否する。
  assert.equal(mod.startReviewManager('12', 'o/r', workspace, '55', true), 'REVIEW_MANAGER_ALREADY_RUNNING');
  assert.equal(sharedLiveness.observeResource(startupEndpoint).state, 'dead');

  // 本体が終了したら、再開（--resume 相当）は拒否されない。
  shimDead = true;
  headlessLaunch._setSpawn(fakeSpawn({ pid: 55502 }));
  assert.equal(mod.startReviewManager('12', 'o/r', workspace, '55', true), 'REVIEW_MANAGER_STARTED');
  assert.equal(spawnCalls.length, 2);
  assert.equal(sharedLiveness.observeResource(startupEndpoint).state, 'dead');
});

test('startReviewManager: 別の起動処理が起動予約 endpoint を保持中なら起動しない', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('startup-endpoint-busy');
  const busy = new Error('busy');
  busy.code = 'LIVENESS_ENDPOINT_BUSY';
  const original = sharedLiveness.captureSelf;
  sharedLiveness.captureSelf = () => { throw busy; };
  try {
    assert.equal(mod.startReviewManager('13', 'o/r', workspace, '55'), 'REVIEW_MANAGER_ALREADY_RUNNING');
  } finally {
    sharedLiveness.captureSelf = original;
  }
  assert.equal(spawnCalls.length, 0);
});

test('startReviewManager: shim が endpoint を確立しなければ子を停止し、起動予約と endpoint を解放して失敗する', () => {
  headlessLaunch._setSpawn(fakeSpawn({ pid: 66601, claimEndpoint: false }));
  // 偽の shim の endpoint は確立しない（観測は dead のまま）。
  headlessLaunch._setLiveness(makeLiveness((pid) => (pid === 66601 ? 'dead' : 'alive')));
  const mod = loadModule();
  // 期限（既定10秒）まで待たずに、1回の観測で判定させる。
  sharedLiveness.waitUntilAlive = (ref) => sharedLiveness.observe(ref);
  const workspace = freshWorkspace('shim-never-claims');
  const startingFile = path.join(workspace, '.gh-maestro', 'records', 'pr', '14', 'review', 'manager.starting');

  assert.throws(() => mod.startReviewManager('14', 'o/r', workspace, '55'), /起動を確認できません/);
  assert.deepEqual(killedPids, [66601]);
  assert.equal(fs.existsSync(startingFile), false);
  assert.equal(sharedLiveness.observeResource({ workspace, kind: 'review-manager-startup', name: '14' }).state, 'dead');
});

test('startReviewManager: onExitフックへexecutionIdを渡さない（execution registryのcompleted遷移手段が無く、常にprocess_failedへ誤記録されるのを避けるため）', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('no-execution-registry');

  mod.startReviewManager('9', 'o/r', workspace, '55');

  const decoded = decodedShellCommand(spawnCalls[0]);
  const exitHook = JSON.parse(spawnCalls[0].args[3]);
  assert.match(exitHook.args[0], /worker-exit-hook\.js/);
  // worker-exit-hook.js <workspace> <execution-id|""> ... の第2引数（execution-id）が
  // 空文字であることを確認する。空文字なら worker-exit-hook.js 側の
  // `if (workspace && executionId)` が偽になり、markProcessExit は一切呼ばれない。
  assert.equal(exitHook.args[2], '');
});

test('startReviewManager: ログパスはfactory仕様のlogPath（worker-logs配下、正規workerNameキーで通常ワーカーと共通）', () => {
  const mod = loadModule();
  const workspace = freshWorkspace('log-path');

  mod.startReviewManager('10', 'o/r', workspace, '55');

  // 期待値は factory の出力ではなく、配置規約（records/pr/<PR>/workers/<正規 workerName>/worker.log）から
  // リテラルで書く。正規 workerName は issue-<issue>-review-manager-pr-<pr>。
  const expected = path.join(workspace, '.gh-maestro', 'records', 'pr', '10', 'workers', 'issue-55-review-manager-pr-10', 'worker.log');
  assert.equal(spawnCalls[0].args[2], expected);
});
