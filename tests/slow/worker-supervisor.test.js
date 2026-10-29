'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../../scripts/process-lifecycle');
const { spawnSync } = require('../../scripts/shared/child-process');
const headlessLaunch = require('../../scripts/shared/headless-launch');
const workerLease = require('../../scripts/shared/worker-lease');
const closedPrGuard = require('../../scripts/shared/closed-pr-guard');
const residentAudit = require('../../scripts/shared/resident-audit');

// 起動時刻はテストプロセスについて一度だけ実測し、各main()呼び出しでは再度WMIを起動しない。
// PIDを誤って渡す回帰は即座に検出する。
const TEST_SESSION_START_TIME = '2026-07-25T00:00:00.000Z';
lifecycle.getProcessStartTime = () => TEST_SESSION_START_TIME;
const supervisor = require('../../scripts/worker-supervisor');
supervisor._setGetProcessStartTime((pid) => {
  assert.equal(pid, process.pid, 'main() は実行中テストプロセスのPIDを検証対象にする');
  return TEST_SESSION_START_TIME;
});

// 直接 main()/runOnce() の反復でOSのプロセス起動時刻取得を行うと、Windowsでは
// 各スキャンがPowerShell/WMI待ちになる。PID再利用を含む実照合ロジックは
// tests/process-lifecycle.test.js で検証し、ここでは既存の注入境界から親生存だけを差し替える。
// 下部のCLI integrationは実argv・実プロセス境界を通す。
const TEST_PARENT_CHECKER = () => true;

// テスト高速化: main() は --session-pid 未指定だと resolveSessionPid が親プロセスツリーを
// 辿る（Windowsでは1回あたり ~2.3秒のPowerShell起動を伴う）。実運用では起動元が必ず
// --session-pid を渡すため、テストでも常に自プロセスPIDを渡してこの探索を省く。
const _realMain = supervisor.main;
const TEST_SESSION_PID = String(process.pid);
// 明示した --workspace は環境変数より優先されるが、workspace引数を省略する
// 経路も実workspaceへ向かわないよう、テスト中は環境変数を一時的に除去する。
const _savedWorkspaceEnv = process.env.GH_MAESTRO_WORKSPACE;
delete process.env.GH_MAESTRO_WORKSPACE;
const _savedWorkerEnv = process.env.GH_MAESTRO_WORKER;
delete process.env.GH_MAESTRO_WORKER;
// GH_MAESTRO_BASE_BRANCH は resume 配送時に buildWorkerEnv が launchAgentHeadless env へ
// マージする（Issue #269）。外側の環境に偶然設定されている値が注入有無の検証を狂わせないよう、
// テスト中は一時的に除去する。
const _savedBaseBranchEnv = process.env.GH_MAESTRO_BASE_BRANCH;
delete process.env.GH_MAESTRO_BASE_BRANCH;
const runMain = (args, opts) => _realMain([...args, '--session-pid', TEST_SESSION_PID], opts);

// ── テストヘルパー ────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  // Windows: 直前にspawnSyncした子プロセスのCWDだったディレクトリは、プロセス終了直後でも
  // OSがハンドル解放をわずかに遅延させ、即rmdirするとEBUSYになることがある（PID registry
  // サブプロセスCLI統合テストで実際に断続的発生）。maxRetries/retryDelayで吸収する。
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (e) {
    cleanup();
    throw e;
  }
}

function parseElapsedSeconds(line) {
  const match = / elapsed=(?:(\d+)時間)?(?:(\d+)分)?(\d+)秒$/.exec(line);
  assert.ok(match, `経過時間フィールドを解釈できること: ${line}`);
  return (Number(match[1] || 0) * 3600)
    + (Number(match[2] || 0) * 60)
    + Number(match[3]);
}

/**
 * 親プロセスから継承されうる値として process.env.GH_MAESTRO_BASE_BRANCH を一時的に設定する。
 * `{ ...process.env, ...env }` のマージで親の値が残らないこと（Issue #269 レビュー指摘）を
 * 最終的なspawn envで検証するために使う。
 */
function withInheritedBaseBranch(branch, fn) {
  const saved = process.env.GH_MAESTRO_BASE_BRANCH;
  process.env.GH_MAESTRO_BASE_BRANCH = branch;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GH_MAESTRO_BASE_BRANCH;
    else process.env.GH_MAESTRO_BASE_BRANCH = saved;
  }
}

/**
 * 最小限の .gh-maestro 環境をセットアップする。
 *
 * opts.workers を指定した場合、resume経由の配送テストがそのまま使えるよう
 * orchestratorエントリを補い、各worker（orchestrator除く）のworktreeディレクトリを
 * 自動作成する。配送は常にresume（プロセス起動）のみを経路とするため、
 * resumeが辿る前提条件をテストのセットアップ側で満たしておく。
 */
function setupWorkspace(dir, opts = {}) {
  const maestroDir = path.join(dir, '.gh-maestro');
  fs.mkdirSync(maestroDir, { recursive: true });

  if (opts.workers) {
    const workers = { orchestrator: { agentId: null }, ...opts.workers };
    fs.writeFileSync(path.join(maestroDir, 'workers.json'), JSON.stringify(workers, null, 2));
    for (const name of Object.keys(opts.workers)) {
      if (name === 'orchestrator') continue;
      fs.mkdirSync(path.join(maestroDir, 'worktrees', name), { recursive: true });
    }
  }

  if (opts.cursors) {
    for (const [name, state] of Object.entries(opts.cursors)) {
      const issue = /^issue-(\d+)-/.exec(name)?.[1] || '1';
      const cursorDir = path.join(maestroDir, 'records', 'issue', issue, 'workers', name);
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(path.join(cursorDir, 'cursor.json'), JSON.stringify(state, null, 2));
    }
  }

  return maestroDir;
}

/** 成功 gh repo view のモック */
function mockGhRepoView(repo) {
  return () => ({
    status: 0,
    stdout: repo + '\n',
    stderr: '',
  });
}

/** 成功 gh api comments のモック */
function mockGhApiComments(comments) {
  return () => ({
    status: 0,
    stdout: JSON.stringify(comments),
    stderr: '',
  });
}

/** gh api comments の実実装にリセット */
function resetGhApiComments() {
  supervisor._setGhApiComments((repo, issue, since, opts = {}) => {
    const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'];
    if (since) args.push('-f', `since=${since}`);
    args.push('-f', 'per_page=100');
    return spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, ...opts });
  });
}

/** gh repo view の実実装にリセット */
function resetGhRepoView() {
  supervisor._setGhRepoView((opts = {}) => {
    return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { encoding: 'utf8', timeout: 30000, ...opts });
  });
}

function resetGhPrList() {
  closedPrGuard._setListFn(() => ({ status: 0, stdout: '[]', stderr: '' }));
}

/** resumeモックが返すPID。既存ワーカーのPIDと区別するために使う */
const RESUMED_PID = 999;

/**
 * ワーカー生存判定の既定。
 * 既存ワーカー（休止中＝resume対象）は false、resumeで新たに起動したプロセスだけ true を返す。
 * この2つを区別しないと、resume直後の生存確認が必ず失敗してしまう。
 */
function setWorkersIdle() {
  supervisor._setIsWorkerAlive((e) => !!e && e.pid === RESUMED_PID);
}

/** ワーカー生存判定を「稼働中」に固定する（配送を見送る状態） */
function setWorkersBusy() {
  supervisor._setIsWorkerAlive(() => true);
}

/**
 * resumeによるheadless起動が既定で成功するようにspawnをモックする。
 * 実プロセスは1つも起動しない。
 */
let lastSpawnCalls = [];
function resetHeadlessLaunchMocks({ pid = RESUMED_PID } = {}) {
  lastSpawnCalls = [];
  headlessLaunch._setSpawn((cmd, args, options) => {
    lastSpawnCalls.push({ cmd, args, options });
    return { pid, on() { return this; }, unref() {} };
  });
  headlessLaunch._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
}

function resetAllMocks() {
  resetGhRepoView();
  resetGhPrList();
  resetGhApiComments();
  resetHeadlessLaunchMocks();
  setWorkersIdle();
  workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
  supervisor._setCreateDeadManSwitch(() => TEST_PARENT_CHECKER);
  // resume直後の生存確認スリープは実待機させない
  supervisor._setSleep(() => {});
  // 通知は実 _notifyOrchestrator を通しつつ、内部 spawn だけを安全なモック（実spawnを起こさない）
  // に差し替える。これにより「構築されるコマンドライン引数」の検証を実関数で行える
  // （PR #251。高レベルの _setNotifyOrchestrator で丸ごと差し替えると、宛先欠落の回帰を検出できない）。
  // _notifyOrchestrator は実装を復元する（先行テストの _setNotifyOrchestrator 注入が残留すると、
  // 実関数経由の引数検証テストが素通ししてしまう）。
  supervisor._setNotifyOrchestrator(supervisor._notifyOrchestrator);
}

resetAllMocks();

// ═══════════════════════════════════════════════════════════════════════════
// --help / usage
// ═══════════════════════════════════════════════════════════════════════════

describe('CLI usage', () => {

});

// ═══════════════════════════════════════════════════════════════════════════
// 引数エラー
// ═══════════════════════════════════════════════════════════════════════════

describe('CLI argument validation', () => {





});

// ═══════════════════════════════════════════════════════════════════════════
// 状態管理: readCursor / writeCursor
// ═══════════════════════════════════════════════════════════════════════════

describe('Cursor state management', () => {





});

// ═══════════════════════════════════════════════════════════════════════════
// loadWorkers
// ═══════════════════════════════════════════════════════════════════════════

describe('loadWorkers', () => {



});

// ═══════════════════════════════════════════════════════════════════════════
// formatMessageForAgent
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// deliverMessage
// ═══════════════════════════════════════════════════════════════════════════
//
// 稼働中プロセスへの入力注入による配送は行わない（実障害: 2026-07-15、
// WezTermは起動基盤としてのみ使うという設計原則に反していた）。
// 配送は常にresume（プロセスの起動/再開）のみを経路とする。

describe('Delivery', () => {
  beforeEach(() => resetAllMocks());



});

// ═══════════════════════════════════════════════════════════════════════════
// tryResumeAndDeliver / deliverMessage の resume 配線
// ═══════════════════════════════════════════════════════════════════════════

describe('resume配線（休止中のセッション再開系ワーカー）', () => {
    const { readWorkersRaw } = require('../../scripts/shared/workers-registry');

  /** headless-shim へ渡された shellArgs（ログインシェルラップ済み）から元のコマンド文字列を復元する */
  function decodeLoginShellCommand(spawnCall) {
    const shellArgs = JSON.parse(spawnCall.args[1]);
    const idx = shellArgs.indexOf('-EncodedCommand');
    if (idx !== -1 && shellArgs[idx + 1]) {
      return Buffer.from(shellArgs[idx + 1], 'base64').toString('utf16le');
    }
    // bash -lc 経由（Unix）: ラップ後の生argvがそのまま並ぶ
    return shellArgs.join(' ');
  }

  beforeEach(() => {
    resetAllMocks();
    // resume直後の生存確認は既定で「生きている」とする（個別テストで上書きする）
    supervisor._setIsWorkerAlive(() => true);
  });

  function setupResumeWorkspace(dir, { workerName = 'issue-7-fix', agentId = 'agy' } = {}) {
    fs.mkdirSync(path.join(dir, '.gh-maestro', 'worktrees', workerName), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
      orchestrator: { agentId: null },
      [workerName]: { pid: 456, startTime: 'old', agentId, issue: 7 },
    }, null, 2));
  }
















});

// ═══════════════════════════════════════════════════════════════════════════
// shouldRetry
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldRetry', () => {












});

// ═══════════════════════════════════════════════════════════════════════════
// runOnce: スキャン・配送サイクル
// ═══════════════════════════════════════════════════════════════════════════

describe('runOnce scan and deliver cycle', () => {
  beforeEach(() => resetAllMocks());


  // ── 死のスイッチ配線（Issue #301） ─────────────────────────────────────
  // runOnce が親セッションの死を検出したとき、role lease を解放して exit 3 で終了する
  // （受け入れ条件1: 死のスイッチ経路で lease が解放される）。scriptName と sessionPid が
  // stderr に出力される（沈黙しない）。このテスト自身の finally で通常の高速checkerへ戻す。



  // ── Issue #250: writeCursor の EPERM 失敗への耐性 ───────────────────────
  // カーソルファイルの位置をディレクトリ化すると rename（writeCursor）が必ず失敗する。
  // Windows では EPERM（リトライ対象）で約500ms粘ってから throw、Linux では即 throw と
  // 差異はあるが、いずれも「プロセスを止めず次サイクルで再試行する」ことが目的なので
  // プラットフォーム非依存のテストとして両OSで実行する。














});

// ═══════════════════════════════════════════════════════════════════════════
// ハング検知
// ═══════════════════════════════════════════════════════════════════════════

describe('Hang detection', () => {
  beforeEach(() => resetAllMocks());








  // ── Issue #250 / PR #251: HANG_DETECTED 時のカーソル保存の保護漏れ ──────
  // 通知成功後に実行される writeCursor（HANG_DETECTED 経路）は、EPERM でも常駐プロセスを
  // 止めず、連続失敗カウンタに計上して次サイクルの保存成功時にリセットされる（HANG_RESUMED
  // 経路と同じ扱い）。



  // ── Issue #265: resume直後の誤検知防止 ──────────────────────────────────
  // ログのmtimeは前セッション終了時点のまま引き継がれるため、resume直後に
  // まだログを書いていない新プロセスをそのまま「無反応」と誤判定してはならない。
  // 判定基準は「ログmtime」と「現在のプロセスのstartTime」のうち新しい方とする。




});

// ═══════════════════════════════════════════════════════════════════════════
// 居座り検知（Issue #263）: 既に報告済みなのにプロセスが生存し続けている異常を検知する。
// ハング検知（ログ更新時刻ベース）とは独立の判定軸で、報告投稿から10秒の猶予を持つ。
// ═══════════════════════════════════════════════════════════════════════════

describe('Stale report detection（居座り検知）', () => {
  beforeEach(() => resetAllMocks());

  const START_TIME = '2026-07-25T00:00:00.000Z';

  function reportComment({ from = 'issue-5-fix', createdAt = '2026-07-25T00:05:00Z' } = {}) {
    return {
      id: 700, author_association: 'MEMBER', created_at: createdAt,
      body: `<!-- gh-maestro {"v":1,"to":"orchestrator","from":"${from}"} -->\n> 完了しました`,
    };
  }






  // 居座り判定専用の追加のgh api呼び出しを行わない（レビュー指摘: 2重取得はAPIレート制限を
  // 通じて配送そのものを止めうる。本Issueの目的と矛盾するため必ず1回に抑える）。



  // PID単独をキーにすると、通知後にワーカーが終了し、OSが同じPIDを無関係な別プロセスへ
  // 再利用した場合、そのPIDで起動された別の（未報告の）ワーカーまで「通知済み」と誤認して
  // 再通知を抑止してしまう（同一ファイル内の _isWorkerAlive → verifyProcessIdentity と同じ
  // 落とし穴）。startTimeも一致することを要求して区別する。


});

// ═══════════════════════════════════════════════════════════════════════════
// 停止したワーカーの検知（Issue #411）
// ═══════════════════════════════════════════════════════════════════════════

describe('Stopped worker detection（停止ワーカー検知）', () => {
  const START_TIME = '2026-07-25T00:00:00.000Z';

  function reportComment({ createdAt = '2026-07-25T00:00:15.000Z' } = {}) {
    return {
      id: 801,
      author_association: 'MEMBER',
      created_at: createdAt,
      body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"issue-5-fix"} -->\n作業が完了しました。',
    };
  }

  beforeEach(() => resetAllMocks());










});

// ═══════════════════════════════════════════════════════════════════════════
// 信頼性: 再起動後継続
// ═══════════════════════════════════════════════════════════════════════════

describe('Reliability: restart continuity', () => {
  beforeEach(() => resetAllMocks());


});

// ═══════════════════════════════════════════════════════════════════════════
// 重複配送防止
// ═══════════════════════════════════════════════════════════════════════════

describe('Duplicate delivery prevention', () => {
  beforeEach(() => resetAllMocks());

});

// ═══════════════════════════════════════════════════════════════════════════
// エッジケース: カーソル型不一致
// ═══════════════════════════════════════════════════════════════════════════

describe('Cursor type safety', () => {



});

// ═══════════════════════════════════════════════════════════════════════════
// CLI integration: 実プロセス起動での動作確認
// ═══════════════════════════════════════════════════════════════════════════

const { spawnSync: realSpawnSync, spawn } = require('child_process');

const SUPERVISOR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'worker-supervisor.js');
const CLI_TEST_START_TIME = '2026-07-25T00:00:00.000Z';

// Keep the CLI integration tests on a real child-process/argv path, but avoid
// paying for a PowerShell/WMI startup-time query on every short-lived child.
// The preload only replaces that observation and the unrelated registry scan;
// process liveness still uses process.kill, and PID-reuse identity behavior is
// covered by the dedicated process-lifecycle integration case.
function createFastCliPreload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-supervisor-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../../scripts/process-lifecycle');
  const leasePath = require.resolve('../../scripts/shared/worker-lease');
  const source = [
    "'use strict';",
    `const childProcess = require(${JSON.stringify(childProcessPath)});`,
    `const fixedStartTime = ${JSON.stringify(CLI_TEST_START_TIME)};`,
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
    'lifecycle.findRunningInstance = () => null;',
    'lifecycle.getProcessStartTime = () => fixedStartTime;',
    'lifecycle.createDeadManSwitch = () => () => true;',
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

// 排他の正本は role lease（Issue #240）。既存所有者を再現する live lease を
// <workspace>/.gh-maestro/leases/resident-role-worker-supervisor.json に書く。
function writeLiveSupervisorLease(dir, pid, startTime) {
  const leasesDir = path.join(dir, '.gh-maestro', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(path.join(leasesDir, 'resident-role-worker-supervisor.json'), JSON.stringify({
    pid, startTime, workerName: 'worker-supervisor', phase: 'active',
  }), 'utf8');
}

/** ヘルパー: worker-supervisor.js を子プロセスとして起動 */
function runSupervisor(args, cwd, envOverride = {}) {
  // --session-pid を渡し、子プロセス側の親プロセスツリー探索（Windowsでは高コスト）を省く。
  // timeout はこのプロセス自体の処理時間ではなく、フルスイート実行時のシステム負荷下での
  // OSスケジューリング遅延に対する余裕を持たせる（実障害: 5000msだと、他のテストファイルが
  // 実プロセス（pwsh等）を並行して起動している状況で、ワークスペース未解決による即時
  // exit(1)しかしないこのプロセスすら5秒以内にスケジュールされずtimeout killされ、
  // status: null になることがあった）。
  const spawnEnv = {
    ...process.env,
    ...envOverride,
  };
  return realSpawnSync(process.execPath, [
    '-r', FAST_CLI_PRELOAD,
    SUPERVISOR_SCRIPT,
    ...args,
    '--session-pid', String(process.pid),
  ], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: spawnEnv,
  });
}

describe('CLI integration (subprocess)', () => {
  test('--help は Usage を表示して exit 0', () => {
    withTempDir((dir) => {
      const r = runSupervisor(['--help'], dir);
      assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes('Usage'), `stdout should include Usage: ${r.stdout}`);
      assert.ok(r.stdout.includes('worker-supervisor.js'));
    });
  });

  test('-h も同様に exit 0', () => {
    withTempDir((dir) => {
      const r = runSupervisor(['-h'], dir);
      assert.equal(r.status, 0, `exit 0, got ${r.status}`);
      assert.ok(r.stdout.includes('Usage'));
    });
  });

  test('--workspace 値欠落で exit 1', () => {
    withTempDir((dir) => {
      const r = runSupervisor(['--workspace'], dir);
      assert.equal(r.status, 1, `exit 1, got ${r.status}`);
      assert.ok(r.stderr.includes('フラグ --workspace には値が必要'), `stderr: ${r.stderr}`);
    });
  });

  test('--workspace 未指定で workspace 外から実行すると exit 1', () => {
    withTempDir((dir) => {
      // dir には .gh-maestro がなく、GH_MAESTRO_WORKSPACE env も無い
      // → resolveWorkspace が CWD 上空探索でも見つけられず null を返す
      const r = runSupervisor(['--once'], dir);
      assert.equal(r.status, 1, `exit 1, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(
        r.stderr.includes('ワークスペースを解決') || r.stderr.includes('リポジトリを解決'),
        `stderr should mention failure: ${r.stderr}`
      );
    });
  });

  test('重複起動を検出して拒否する（既存の live role lease がある場合）', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      // 既存所有者の live lease を書く。pid は process.ppid を指定する（--force 無しなので
      // kill は走らないが、念のためテスト実行環境のプロセスを対象にしない）。
      writeLiveSupervisorLease(dir, process.ppid, CLI_TEST_START_TIME);

      const r = runSupervisor(['--once', '--workspace', dir], dir);
      assert.equal(r.status, 1, `exit 1, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('重複起動'), `stderr should mention 重複起動: ${r.stderr}`);
    });
  });

  test('--force は GH_MAESTRO_WORKER=orchestrator なら既存所有者を停止させて引き継ぐ（Issue #384）', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      // 既存所有者として使い捨ての実子プロセスを立てる。--force の引き継ぎは
      // killProcessTree で所有者を終了させるため、process.ppid 等のテスト実行環境の
      // プロセスを owner に指定してはならない（テストランナーの親を kill してしまう）。
      const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      let leakedOwner = true;
      try {
        writeLiveSupervisorLease(dir, owner.pid, CLI_TEST_START_TIME);

        const r = runSupervisor(
          ['--once', '--force', '--workspace', dir],
          dir,
          { GH_MAESTRO_WORKER: 'orchestrator' }
        );
        assert.notEqual(r.status, 0, `should exit non-zero (gh failure), got ${r.status}`);
        assert.ok(!r.stderr.includes('重複起動'),
          `stderr should NOT mention 重複起動: ${r.stderr}`);
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

  test('--force は GH_MAESTRO_WORKER がワーカー名なら拒否され、既存所有者を停止させない（Issue #384）', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      let ownerRemainedAlive = false;
      try {
        writeLiveSupervisorLease(dir, owner.pid, CLI_TEST_START_TIME);

        const r = runSupervisor(
          ['--once', '--force', '--workspace', dir],
          dir,
          { GH_MAESTRO_WORKER: 'issue-384-coder-force-guard' }
        );
        assert.equal(r.status, 1, `exit 1, got ${r.status}, stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('ワーカー "issue-384-coder-force-guard" からの常駐プロセスの強制置き換え（--force）は禁止されています'),
          `stderr should contain rejection: ${r.stderr}`);
        assert.ok(r.stderr.includes('【理由】'), `stderr should contain reason: ${r.stderr}`);
        assert.ok(r.stderr.includes('【代替手順】'), `stderr should contain alternative: ${r.stderr}`);
        assert.ok(r.stderr.includes('【禁止事項】'), `stderr should contain prohibition: ${r.stderr}`);

        // 所有者は生存し続けていること
        if (owner.exitCode === null && owner.signalCode === null) {
          ownerRemainedAlive = true;
        }
      } finally {
        try { owner.kill(); } catch {}
        assert.equal(ownerRemainedAlive, true, 'ワーカーからの --force で既存プロセスが停止されてはならない');
      }
    });
  });

  test('--force は GH_MAESTRO_WORKER が未設定なら拒否され、既存所有者を停止させない（Issue #384）', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      let ownerRemainedAlive = false;
      try {
        writeLiveSupervisorLease(dir, owner.pid, CLI_TEST_START_TIME);

        const r = runSupervisor(
          ['--once', '--force', '--workspace', dir],
          dir,
          { GH_MAESTRO_WORKER: '' }
        );
        assert.equal(r.status, 1, `exit 1, got ${r.status}, stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('実行主体の名乗り（GH_MAESTRO_WORKER）が設定されていません'),
          `stderr should contain missing identity message: ${r.stderr}`);

        if (owner.exitCode === null && owner.signalCode === null) {
          ownerRemainedAlive = true;
        }
      } finally {
        try { owner.kill(); } catch {}
        assert.equal(ownerRemainedAlive, true, '名乗り無しでの --force で既存プロセスが停止されてはならない');
      }
    });
  });

  test('live role lease が無ければ正常起動を試みる', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      const r = runSupervisor(['--once', '--workspace', dir], dir);
      assert.notEqual(r.status, 0, `should exit non-zero (no git repo), got ${r.status}`);
      assert.ok(!r.stderr.includes('重複起動'),
        `stderr should NOT mention 重複起動: ${r.stderr}`);
      assert.ok(r.stderr.includes('リポジトリを解決'),
        `stderr should mention repo resolution failure: ${r.stderr}`);
    });
  });
});
