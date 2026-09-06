'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../../scripts/process-lifecycle');
const { spawnSync } = require('../../scripts/shared/child-process');
const { cleanSpawnEnv } = require('../_spawn-env');
const workerLease = require('../../scripts/shared/worker-lease');
const { spawnSync: nativeSpawnSync } = require('node:child_process');

workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
// 起動時刻はテストプロセスについて一度だけ実測し、各main()呼び出しでは再度WMIを起動しない。
// PIDを誤って渡す回帰は即座に検出する。
const TEST_SESSION_START_TIME = '2026-07-25T00:00:00.000Z';
lifecycle.getProcessStartTime = () => TEST_SESSION_START_TIME;
const msgPoll = require('../../scripts/msg-poll');
const readStateLib = require('../../scripts/shared/read-state');
msgPoll._setGetProcessStartTime((pid) => {
  assert.equal(pid, process.pid, 'main() は実行中テストプロセスのPIDを検証対象にする');
  return TEST_SESSION_START_TIME;
});

// 直接 main()/scanOnce() を呼ぶケースでは、親セッションの死活確認自体は
// process-lifecycle.test.js の実照合テストで検証する。ここでは各スキャンで
// WindowsのPowerShell/WMIを起動しないよう、既存の注入境界から生存checkerだけを差し替える。
// 実CLI統合テスト（重複lease/--force/--watch-pid）は実際のプロセス境界を通す。
const TEST_PARENT_CHECKER = () => true;
const useFastParentChecker = () => {
  msgPoll._setCreateDeadManSwitch(() => TEST_PARENT_CHECKER);
};
useFastParentChecker();

// テスト高速化: main() は --session-pid 未指定だと resolveSessionPid が親プロセスツリーを
// 辿る（Windowsでは1回あたり ~2.3秒のPowerShell起動を伴う）。実運用では起動元が必ず
// --session-pid を渡すため、テストでも常に自プロセスPIDを渡してこの探索を省く。
const _realMain = msgPoll.main;
const TEST_SESSION_PID = String(process.pid);
const TEST_CLI_START_TIME = '2026-07-25T00:00:00.000Z';

// 明示した --workspace は環境変数より優先されるが、workspace引数を省略する
// 経路も実workspaceへ向かわないよう、main() の間だけ env を外す。
const runMain = (args, opts) => {
  const saved = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return _realMain([...args, '--session-pid', TEST_SESSION_PID], opts);
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
    'lifecycle.getProcessStartTime = () => fixedStartTime;',
    `lifecycle.createDeadManSwitch = () => () => ${parentAlive ? 'true' : 'false'};`,
    `const lease = require(${JSON.stringify(leasePath)});`,
    'lease._setGetProcessStartTime(() => fixedStartTime);',
    'lease._setIsProcessAlive(isAlive);',
    'lease._setVerifyProcessIdentity(() => ({ match: true }));',
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
  if (!args.includes('--watch-pid') && !args.includes('--session-pid')) {
    childArgs.push('--session-pid', TEST_SESSION_PID);
  }
  return nativeSpawnSync(process.execPath, childArgs, {
    encoding: 'utf8',
    timeout: 10000,
    env: cleanSpawnEnv(),
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


test('継続モード: --force は重複レース判定を無効化せず、既存所有者を停止させて引き継ぐ', () => {
  const { spawn } = require('child_process');
  withTempDir(workspace => {
    // 既存所有者として使い捨ての実子プロセスを立てる。--force の引き継ぎは
    // killProcessTree で所有者を終了させるため、process.ppid 等のテスト実行環境の
    // プロセスを owner に指定してはならない（テストランナーの親を kill してしまう）。
    const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
      env: cleanSpawnEnv(),
    });
    let leakedOwner = true;
    try {
      const otherPid = owner.pid;
      const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
        pid: otherPid, startTime: TEST_CLI_START_TIME, workerName: 'msgpoll-orchestrator', phase: 'active',
      }));

      const r = runMsgPollCli(['orchestrator', '--workspace', workspace, '--force'], {
        timeout: 15000,
        env: { ...cleanSpawnEnv(), GH_MAESTRO_WORKER: 'orchestrator' },
      });

      assert.doesNotMatch(r.stderr, /重複起動/);
      // 引き継ぎは lease を再取得して本稼働へ進む（本テストでは gh 解決に失敗して
      // exit 1 になるが、重複起動の拒否ではない）。owner は停止されている。
      if (owner.exitCode === null && owner.signalCode === null) {
        leakedOwner = false;
      }
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        try { owner.kill(); } catch {}
      }
      assert.equal(leakedOwner, false, '--force の引き継ぎで既存所有者プロセスが停止されること');
    }
  });
});



// ── buildWatchPidCommand ─────────────────────────────────────────────────────



// ── --watch-pid モード（実プロセス起動） ─────────────────────────────────────

test('--watch-pid: 監視対象PIDが生きている間は何も出力しない', () => {
  const r = runMsgPollCli(['--watch-pid', String(process.pid), '--interval', '1'], { timeout: 2500 });
  assert.equal(r.stdout.trim(), '');
});

test('--watch-pid: 監視対象PIDが死んでいれば即座にPID_DIEDを出力してexit 0', () => {
  const { spawnSync } = require('child_process');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  const deadPid = dead.pid;

  const r = runMsgPollCli(['--watch-pid', String(deadPid), '--interval', '1'], {
    timeout: 5000,
    parentAlive: false,
  });

  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `PID_DIED:${deadPid}`);
});

test('--watch-pid: 不正なpid指定はexit 1', () => {
  const r = runMsgPollCli(['--watch-pid', 'not-a-number'], { timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /正の整数のPID/);
});

test('--watch-pid: 余剰な位置引数・未知フラグはエラー終了する（黙って無視しない）', () => {
  const r = runMsgPollCli(['--watch-pid', String(process.pid), 'extra'], { timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /予期しない位置引数/);
});




// ── --wait モード ───────────────────────────────────────────────────────────





test('runWaitMode: 新着が無ければ waitMs 経過後に false を返す（リトライを重ねる）', async () => {
  await withTempDir(async workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    let sleepCalls = 0;
    msgPoll._setSleep(async (ms) => { sleepCalls++; await new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))); });

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '1', '--interval', '1']);
    const found = await msgPoll.runWaitMode(r);
    assert.equal(found, false);
    assert.equal(r.lines.length, 0);
    assert.ok(sleepCalls > 0, `sleepCalls should be > 0, got ${sleepCalls}`);

    msgPoll._setSleep(async (ms) => {});
  });
});




// ── --wait モード: 1回1件返却の契約（Issue #99） ────────────────────────────






// ── reset mocks ─────────────────────────────────────────────────────────────

msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));
