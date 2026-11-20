'use strict';

const { installLivenessTestAdapter } = require('../helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnSync } = require('../../scripts/shared/child-process');
const { cleanSpawnEnv } = require('../_spawn-env');
const workerLease = require('../../scripts/shared/worker-lease');
const { spawnSync: nativeSpawnSync } = require('node:child_process');
const processLiveness = require('../../scripts/shared/process-liveness');
const {
  startLivenessOwner,
  stopLivenessOwner,
  waitForLivenessOwnerExit,
} = require('../helpers/liveness-owner');

const TEST_SESSION_START_TIME = '2026-07-25T00:00:00.000Z';
const msgPoll = require('../../scripts/msg-poll');
const readStateLib = require('../../scripts/shared/read-state');

// 直接 main()/scanOnce() を呼ぶケースでは、親セッションの死活確認自体は
// process-lifecycle.test.js の実照合テストで検証する。ここでは各スキャンで
// WindowsのPowerShell/WMIを起動しないよう、既存の注入境界から生存checkerだけを差し替える。
// 実CLI統合テスト（重複lease/--force/--watch-pid）は実際のプロセス境界を通す。
const useFastParentChecker = () => {
  const checker = processLiveness.createLiveness({
    probePid: () => 'alive',
    readStartTime: (pid, expectedStartTime) => {
      assert.equal(pid, process.pid, 'resident と session の参照は実行中テストプロセスを使う');
      return expectedStartTime || TEST_SESSION_START_TIME;
    },
  });
  msgPoll._setParentLiveness(checker);
  workerLease._setLiveness(checker);
};
useFastParentChecker();

// PR2の親子常駐はPID探索ではなくstdin EOFで終了する。
const _realMain = msgPoll.main;
const TEST_CLI_START_TIME = '2026-07-25T00:00:00.000Z';

// 明示した --workspace は環境変数より優先されるが、workspace引数を省略する
// 経路も実workspaceへ向かわないよう、main() の間だけ env を外す。
const runMain = (args, opts) => {
  const saved = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return _realMain(args, opts);
  } finally {
    if (saved !== undefined) process.env.GH_MAESTRO_WORKSPACE = saved;
  }
};

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

// 実CLI統合テストは子プロセス・argv・leaseのI/O境界を維持する。一方、Windowsの
// process-lifecycle は起動時刻取得のたびにPowerShell/WMIを起動するため、同じ境界の
// 中で使うテスト用preloadだけがその観測を固定値へ差し替える。PIDの生存確認は
// process.kill(pid, 0) を通し、実際のPID再利用判定そのものは process-lifecycle.test.js
// で実照合する（そちらではこのpreloadを使わない）。
function createFastCliPreload({ parentAlive = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-cli-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../../scripts/process-lifecycle');
  const leasePath = require.resolve('../../scripts/shared/worker-lease');
  const processLivenessPath = require.resolve('../../scripts/shared/process-liveness');
  const source = [
    "'use strict';",
    `const childProcess = require(${JSON.stringify(childProcessPath)});`,
    `const fixedStartTime = ${JSON.stringify(TEST_CLI_START_TIME)};`,
    'const isAlive = (pid) => {',
    '  try { process.kill(Number(pid), 0); return true; }',
    "  catch (e) { return e && e.code !== 'ESRCH'; }",
    '};',
    'const realExecSync = childProcess.execSync;',
    'childProcess.execSync = (command, opts) => {',
    "  if (String(command).includes('Get-CimInstance Win32_Process')) {",
    '    const match = /ProcessId=(\\d+)/.exec(String(command));',
    '    return match && isAlive(Number(match[1])) ? `${fixedStartTime}\\n` : \"\";',
    '  }',
    '  return realExecSync(command, opts);',
    '};',
    `const lifecycle = require(${JSON.stringify(lifecyclePath)});`,
    // The role lease tests create no registry owner.  Keep the force path in
    // the real CLI while avoiding an unrelated registry/WMI scan.
    'lifecycle.findRunningInstance = () => null;',
    `const lease = require(${JSON.stringify(leasePath)});`,
    `const processLiveness = require(${JSON.stringify(processLivenessPath)});`,
    `const checker = processLiveness.createLiveness({ probePid: (pid) => pid === process.pid || ${parentAlive ? 'true' : 'false'} ? 'alive' : 'dead', readStartTime: (_pid, expected) => expected || fixedStartTime });`,
    'lease._setLiveness(checker);',
    'Object.assign(processLiveness, checker);',
    'lifecycle._setLiveness(checker);',
  ].join('\n');
  fs.writeFileSync(file, source, 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return file;
}

const FAST_CLI_PRELOAD = createFastCliPreload();
const FAST_DEAD_WATCH_PRELOAD = createFastCliPreload({ parentAlive: false });

function runMsgPollCli(args, { parentAlive = true, ...opts } = {}) {
  const preload = parentAlive ? FAST_CLI_PRELOAD : FAST_DEAD_WATCH_PRELOAD;
  const childArgs = ['-r', preload, path.join(__dirname, '..', '..', 'scripts', 'msg-poll.js'), ...args];
  const workspaceIndex = args.indexOf('--workspace');
  const runtimeRoot = workspaceIndex >= 0
    ? path.join(args[workspaceIndex + 1], '.test-runtime')
    : undefined;
  const env = {
    ...cleanSpawnEnv(),
    ...(runtimeRoot ? { GH_MAESTRO_RUNTIME_DIR: runtimeRoot } : {}),
    ...(opts.env || {}),
  };
  delete opts.env;
  return nativeSpawnSync(process.execPath, childArgs, {
    encoding: 'utf8',
    timeout: 10000,
    env,
    ...opts,
  });
}

// orchestrator の msg-state を v2 initialized 状態に初期化する。
function initOrchestratorState(workspace, { byIssue = {}, generation = 'test-gen' } = {}) {
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const result = readStateLib.initializeState(workspace, 'orchestrator', { byIssue, generation });
  assert.equal(result.ok, true, `orchestrator state 初期化に失敗: ${result.error}`);
}

// workers.json を temp workspace に作る。
function writeWorkers(workspace, workers) {
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify(workers, null, 2), 'utf8');
}

// ── parseArgs（main() と CLI プリフライトが共有する解析ヘルパー） ───────────











// ── --help / -h ────────────────────────────────────────────────────────────



// ── 引数エラー ──────────────────────────────────────────────────────────────





// ── path-safety 検証 ───────────────────────────────────────────────────────



// ── マーカー解析 ────────────────────────────────────────────────────────────








// ── parseCommentsResponse（gh api --paginate --slurp 応答のフラット化） ────








// ── 既読状態（v2スキーマ。詳細は tests/read-state.test.js） ──────────────






// ── worker モード --once ────────────────────────────────────────────────────






// ── 既読の永続化（--once の2回実行で二重通知しない） ─────────────────────



// ── gh エラー耐性 ──────────────────────────────────────────────────────────



// ── 書き込み失敗耐性（Issue #250） ─────────────────────────────────────────
// markReadMany（既読の永続化）が他プロセスに msg-state を掴まれている等で EPERM を
// throw しても、常駐プロセスをクラッシュさせず次サイクルで再試行する。NEW_MESSAGE は
// 出力済みなので「重複通知」側に倒れる（握り潰しはしない）。


// ── 監査イベント処理のI/O失敗耐性（Issue #289） ─────────────────────────────
// 常駐モードの orchestrator 監査イベント読み出し（resident-audit）が I/O 失敗で throw しても、
// scanOnce はクラッシュせず stderr に出して継続する。従来は未捕捉例外が setInterval まで
// 漏れて常駐プロセスが exit 1 で崩壊し、inbox 監視が静かに止まった。



// ── orchestrator モード ────────────────────────────────────────────────────


// ── 死のスイッチ配線（Issue #301） ────────────────────────────────────────
// scanOnce が親セッションの死を検出したとき、role lease を解放して exit 3 で終了する
// （受け入れ条件1: 死のスイッチ経路で lease が解放される）。scriptName と sessionPid が
// stderr に出力される（沈黙しない）。
















// ── orchestrator: 未初期化・旧形式 state では走査停止（Issue #207） ────




// ── worker モードの旧形式（v1）state は seenIds を引き継ぐ ─────────────


// ── 空レスポンス ───────────────────────────────────────────────────────────


// ── workers.json 安全性 ────────────────────────────────────────────────────




// ── gh api 応答安全 ────────────────────────────────────────────────────────



// ── 継続モードの多重起動検知（サブプロセス経由） ────────────────────────────
// scanOnce() を呼ばないため gh 呼び出しは発生しない。重複検知で即 exit(1) するため
// interval ループには入らず、実ポーリングプロセスは生成されない
//
// GH_MAESTRO_WORKSPACE を外した env で起動し、必ず --workspace の一時dirを使う。

test('継続モード: 同じ self を監視中の生存プロセスがいれば exit 1 して起動しない', () => {
  withTempDir(workspace => {
    const runtimeRoot = path.join(workspace, '.test-runtime');
    const owner = startLivenessOwner({
      workspace, runtimeRoot, kind: 'resident', name: 'msgpoll-orchestrator',
    });
    try {
      const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
        ...owner.record, workerName: 'msgpoll-orchestrator', phase: 'active',
      }));

      const r = runMsgPollCli(['orchestrator', '--workspace', workspace]);

      assert.equal(r.status, 1);
      assert.match(r.stderr, /重複起動/);
    } finally {
      stopLivenessOwner(owner);
    }
  });
});


test('継続モード: --workspace がホームディレクトリと衝突する場合、生の例外ではなくワークスペース解決エラーで exit 1 する（Issue #214）', () => {
  // resolveWorkspace() が workspace の home 衝突を検知して null を返すため、
  // registerProcess/role lease 等の assertValidWorkspace throw が
  // 子プロセスの生スタックトレースとして漏れ出ることなく、通常のエラーメッセージ
  // + exit 1 に倒れることを実プロセス起動で確認する。
  const { spawnSync } = require('child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-fakehome-'));
  try {
    const script = path.join(__dirname, '..', '..', 'scripts', 'msg-poll.js');
    const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const env = { ...cleanSpawnEnv(), [envKey]: fakeHome };

    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', fakeHome],
      { encoding: 'utf8', timeout: 10000, env });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /ワークスペースを解決できません/);
    assert.doesNotMatch(r.stderr, /assertValidWorkspace/, `生の例外スタックトレースが漏れてはならない: ${r.stderr}`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('継続モード: 重複起動検出は削除済みのwatch-pidを案内しない', () => {
  withTempDir(workspace => {
    const runtimeRoot = path.join(workspace, '.test-runtime');
    const owner = startLivenessOwner({
      workspace, runtimeRoot, kind: 'resident', name: 'msgpoll-orchestrator',
    });
    try {
      const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
        ...owner.record, workerName: 'msgpoll-orchestrator', phase: 'active',
      }));

      const r = runMsgPollCli(['orchestrator', '--workspace', workspace]);

      assert.equal(r.status, 1);
      assert.match(r.stderr, /重複起動/);
      assert.doesNotMatch(r.stderr, /--watch-pid|PID_DIED/);
    } finally {
      stopLivenessOwner(owner);
    }
  });
});

test('継続モード: --force は重複レース判定を無効化せず、既存所有者を停止させて引き継ぐ', async () => {
  await withTempDir(async (workspace) => {
    const runtimeRoot = path.join(workspace, '.test-runtime');
    const owner = startLivenessOwner({
      workspace, runtimeRoot, kind: 'resident', name: 'msgpoll-orchestrator',
    });
    let leakedOwner = true;
    let runResult;
    try {
      const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
        ...owner.record, workerName: 'msgpoll-orchestrator', phase: 'active',
      }));

      runResult = runMsgPollCli(['orchestrator', '--workspace', workspace, '--force'], {
        timeout: 15000,
        env: { GH_MAESTRO_WORKER: 'orchestrator' },
      });

      assert.doesNotMatch(runResult.stderr, /重複起動/);
      // 引き継ぎは lease を再取得して本稼働へ進む（本テストでは gh 解決に失敗して
      // exit 1 になるが、重複起動の拒否ではない）。owner は停止されている。
      await waitForLivenessOwnerExit(owner);
      leakedOwner = owner.child.exitCode === null && owner.child.signalCode === null;
    } finally {
      if (owner.child.exitCode === null && owner.child.signalCode === null) {
        stopLivenessOwner(owner);
      }
      assert.equal(leakedOwner, false,
        `--force の引き継ぎで既存所有者プロセスが停止されること (exit=${runResult?.status}, owner=${owner.child.exitCode}/${owner.child.signalCode})\n${runResult?.stderr}`);
    }
  });
});



// --watch-pid was removed when downstream residents switched to stdin EOF.
test('旧 --watch-pid は未知のフラグとして拒否する', () => {
  const r = runMsgPollCli(['--watch-pid', String(process.pid)], { timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知のフラグ.*--watch-pid/);
});




// ── --wait モード ───────────────────────────────────────────────────────────









// ── --wait モード: 1回1件返却の契約（Issue #99） ────────────────────────────






// ── reset mocks ─────────────────────────────────────────────────────────────

msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));
