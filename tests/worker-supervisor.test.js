'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supervisor = require('../scripts/worker-supervisor');
const { spawnSync } = require('../scripts/shared/child-process');
const headlessLaunch = require('../scripts/shared/headless-launch');
const workerLease = require('../scripts/shared/worker-lease');
const closedPrGuard = require('../scripts/shared/closed-pr-guard');
const residentAudit = require('../scripts/shared/resident-audit');
const { getProcessStartTime } = require('../scripts/process-lifecycle');

// 起動時刻はテストプロセスについて一度だけ実測し、各main()呼び出しでは再度WMIを起動しない。
// PIDを誤って渡す回帰は即座に検出する。
const TEST_SESSION_START_TIME = getProcessStartTime(process.pid);
supervisor._setGetProcessStartTime((pid) => {
  assert.equal(pid, process.pid, 'main() は実行中テストプロセスのPIDを検証対象にする');
  return TEST_SESSION_START_TIME;
});

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
 * 実プロセスは1つも起動しない（.claude/rules/test-process-spawn-safety.md）。
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
  test('--help が usage を返して code 0', () => {
    const r = runMain(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.lines.join('\n').includes('worker-supervisor.js'));
    assert.equal(r.errLines.length, 0);
    assert.equal(r.runOnce, null);
  });

  test('-h が usage を返して code 0', () => {
    const r = runMain(['-h']);
    assert.equal(r.code, 0);
    assert.ok(r.lines.join('\n').includes('worker-supervisor.js'));
    assert.equal(r.runOnce, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 引数エラー
// ═══════════════════════════════════════════════════════════════════════════

describe('CLI argument validation', () => {
  test('未知の引数で code 1', () => {
    const r = withTempDir((dir) => {
      setupWorkspace(dir);
      return runMain(['--workspace', dir, '--bogus']);
    });
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('未知のフラグ')));
    assert.equal(r.runOnce, null);
  });

  test('--workspace 値欠落で code 1', () => {
    const r = runMain(['--workspace']);
    assert.equal(r.code, 1);
    assert.equal(r.runOnce, null);
  });

  test('存在しないワークスペースパスで code 1', () => {
    // 実在しないパスを指定した場合、CWD フォールバックも効かない（/nonexistent/... 配下に CWD は無い）
    const r = runMain(['--workspace', '/nonexistent/path/12345']);
    assert.equal(r.code, 1);
    assert.equal(r.runOnce, null);
  });

  test('--force: 名乗りなしのときは code 1（Issue #384）', () => {
    const r = withTempDir((dir) => {
      setupWorkspace(dir);
      return runMain(['--workspace', dir, '--force'], { env: {} });
    });
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('GH_MAESTRO_WORKER')));
  });

  test('--force: ワーカー名乗りのときは code 1（Issue #384）', () => {
    const r = withTempDir((dir) => {
      setupWorkspace(dir);
      return runMain(['--workspace', dir, '--force'], { env: { GH_MAESTRO_WORKER: 'issue-384-coder-force-guard' } });
    });
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('issue-384-coder-force-guard')));
  });

  test('リポジトリ解決失敗で code 1', () => {
    supervisor._setGhRepoView(() => ({
      status: 1,
      stdout: '',
      stderr: 'not a git repository',
    }));

    const r = withTempDir((dir) => {
      setupWorkspace(dir);
      return runMain(['--workspace', dir]);
    });

    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('リポジトリ')));

    resetGhRepoView();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 状態管理: readCursor / writeCursor
// ═══════════════════════════════════════════════════════════════════════════

describe('Cursor state management', () => {
  test('readCursor: ファイルが無い場合は初期状態を返す', () => {
    withTempDir((dir) => {
      setupWorkspace(dir);
      const state = supervisor.readCursor(dir, 'issue-1-test-worker');
      assert.equal(state.since, null);
      assert.deepEqual(state.seenIds, []);
      assert.deepEqual(state.deliveredIds, []);
      assert.deepEqual(state.pendingDeliveries, {});
      assert.equal(state.hangNotifiedPid, null);
      assert.equal(state.hangNotifiedStartTime, null);
      assert.equal(state.hangNotifiedAt, null);
    });
  });

  test('readCursor: 既存のカーソルを読み込む', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        cursors: {
          'issue-1-test-worker': {
            since: '2024-01-01T00:00:00Z',
            seenIds: [1, 2, 3],
            deliveredIds: [1, 2],
            pendingDeliveries: { '3': { retries: 1, lastError: 'timeout' } },
            hangNotifiedPid: 123,
            hangNotifiedStartTime: '2024-05-01T00:00:00Z',
            hangNotifiedAt: '2024-06-01T12:00:00Z',
          },
        },
      });

      const state = supervisor.readCursor(dir, 'issue-1-test-worker');
      assert.equal(state.since, '2024-01-01T00:00:00Z');
      assert.deepEqual(state.seenIds, [1, 2, 3]);
      assert.deepEqual(state.deliveredIds, [1, 2]);
      assert.deepEqual(state.pendingDeliveries, { '3': { retries: 1, lastError: 'timeout' } });
      assert.equal(state.hangNotifiedPid, 123);
      assert.equal(state.hangNotifiedStartTime, '2024-05-01T00:00:00Z');
      assert.equal(state.hangNotifiedAt, '2024-06-01T12:00:00Z');
    });
  });

  test('readCursor: 壊れたJSONは初期状態を返す', () => {
    withTempDir((dir) => {
      const cursorsDir = path.join(dir, '.gh-maestro', 'records', 'issue', '1', 'workers', 'issue-1-bad');
      fs.mkdirSync(cursorsDir, { recursive: true });
      fs.writeFileSync(path.join(cursorsDir, 'cursor.json'), '{broken json');

      const state = supervisor.readCursor(dir, 'issue-1-bad');
      assert.equal(state.since, null);
      assert.deepEqual(state.seenIds, []);
      assert.equal(state.hangNotifiedPid, null);
      assert.equal(state.hangNotifiedStartTime, null);
      assert.equal(state.hangNotifiedAt, null);
    });
  });

  test('writeCursor → readCursor がラウンドトリップする', () => {
    withTempDir((dir) => {
      setupWorkspace(dir);

      const state = {
        since: '2024-06-01T12:00:00Z',
        seenIds: [10, 20, 30],
        deliveredIds: [10, 20],
        pendingDeliveries: { '30': { retries: 2, lastError: 'send-text failed', lastFrom: 'orch', lastBody: 'hello' } },
        hangNotifiedPid: 123,
        hangNotifiedStartTime: '2024-05-01T00:00:00Z',
        hangNotifiedAt: '2024-06-01T12:00:00Z',
      };

      supervisor.writeCursor(dir, 'issue-1-roundtrip', state);
      const loaded = supervisor.readCursor(dir, 'issue-1-roundtrip');

      assert.equal(loaded.since, state.since);
      assert.deepEqual(loaded.seenIds, state.seenIds);
      assert.deepEqual(loaded.deliveredIds, state.deliveredIds);
      assert.deepEqual(loaded.pendingDeliveries, state.pendingDeliveries);
      assert.equal(loaded.hangNotifiedPid, state.hangNotifiedPid);
      assert.equal(loaded.hangNotifiedStartTime, state.hangNotifiedStartTime);
      assert.equal(loaded.hangNotifiedAt, state.hangNotifiedAt);
    });
  });

  test('writeCursor: seenIds/deliveredIds が MAX_SEEN_IDS を超えたら切り詰める', () => {
    withTempDir((dir) => {
      setupWorkspace(dir);

      const ids = Array.from({ length: 250 }, (_, i) => i + 1);
      const state = {
        since: '2024-01-01T00:00:00Z',
        seenIds: ids,
        deliveredIds: ids,
        pendingDeliveries: {},
      };

      supervisor.writeCursor(dir, 'issue-1-trim-test', state);
      const loaded = supervisor.readCursor(dir, 'issue-1-trim-test');

      assert.equal(loaded.seenIds.length, 200);
      assert.equal(loaded.seenIds[0], 51);
      assert.equal(loaded.deliveredIds.length, 200);
    });
  });

  test('cursorPath / stateDir が正しいパスを返す', () => {
    const p = supervisor.cursorPath('/ws', 'issue-1-my-worker');
    assert.ok(p.includes('.gh-maestro'));
    assert.ok(p.includes('records'));
    assert.ok(p.includes('issue'));
    assert.ok(p.endsWith(path.join('issue-1-my-worker', 'cursor.json')));

    const s = supervisor.stateDir('/ws');
    assert.ok(s.endsWith(path.join('.gh-maestro', 'records')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loadWorkers
// ═══════════════════════════════════════════════════════════════════════════

describe('loadWorkers', () => {
  test('workers.json が無い場合は空 Map を返す', () => {
    withTempDir((dir) => {
      fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
      const workers = supervisor.loadWorkers(dir);
      assert.equal(workers.size, 0);
    });
  });

  test('ワーカーを正しく読み込む（orchestrator 除外）', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          orchestrator: { agentId: null, issue: null },
          'issue-5-fix': { pid: 102, startTime: 's2', agentId: 'claude', issue: 5 },
          'issue-8-add': { pid: 103, startTime: 's3', agentId: 'agy', issue: 8 },
        },
      });

      const workers = supervisor.loadWorkers(dir);
      assert.equal(workers.size, 2);
      assert.equal(workers.get('issue-5-fix').pid, 102);
      assert.equal(workers.get('issue-5-fix').startTime, 's2');
      assert.equal(workers.get('issue-5-fix').agentId, 'claude');
      assert.equal(workers.get('issue-5-fix').issue, 5);
      assert.equal(workers.get('issue-8-add').pid, 103);
    });
  });

  test('レガシー形式（pane_id文字列）も読める（移行前セッションの掃除に必要）', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'old-worker': 'pane-123' },
      });

      const workers = supervisor.loadWorkers(dir);
      assert.equal(workers.size, 1);
      assert.equal(workers.get('old-worker').paneId, 'pane-123');
      assert.equal(workers.get('old-worker').agentId, null);
      assert.equal(workers.get('old-worker').issue, null);
    });
  });

  test('壊れた workers.json / 配列は空 Map を返す', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });
      fs.writeFileSync(path.join(maestroDir, 'workers.json'), '{broken');
      assert.equal(supervisor.loadWorkers(dir).size, 0);
    });

    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });
      fs.writeFileSync(path.join(maestroDir, 'workers.json'), '[]');
      assert.equal(supervisor.loadWorkers(dir).size, 0);
    });
  });
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

  test('deliverMessage: プロセス生存時は稼働中とみなしpending（二重起動しない）', () => {
    setWorkersBusy();

    const result = supervisor.deliverMessage({
      workerName: 'w', entry: { pid: 123, startTime: 's', agentId: null },
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
      homedir: '/home/user', issue: '5',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'pending');
    assert.ok(result.error.includes('alive'));
  });

  test('deliverMessage: プロセス非生存 + agentId未解決なら本当のconfigエラーが伝播する（汎用pendingで上書きされない）', () => {
    setWorkersIdle();

    const result = supervisor.deliverMessage({
      workerName: 'w', entry: { pid: 123, startTime: 's', agentId: 'nonexistent-agent' },
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
      homedir: '/home/user', issue: '5',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'config-unresolvable');
    assert.ok(result.error.includes('configを解決できません'),
      `本当のconfigエラーが含まれる: ${result.error}`);
    assert.ok(!result.error.includes('queued for resume'),
      `汎用メッセージで上書きされない: ${result.error}`);
  });

  test('deliverMessage: pid が null + agentId未解決でも config-unresolvable', () => {
    const result = supervisor.deliverMessage({
      workerName: 'w', entry: { pid: null, agentId: 'nonexistent-agent' },
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
      homedir: '/home/user', issue: '5',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'config-unresolvable');
    assert.ok(result.error.includes('configを解決できません'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tryResumeAndDeliver / deliverMessage の resume 配線
// ═══════════════════════════════════════════════════════════════════════════

describe('resume配線（休止中のセッション再開系ワーカー）', () => {
  const { readWorkersRaw } = require('../scripts/shared/workers-registry');

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

  test('tryResumeAndDeliver: claude（system-prompt-file）も成功する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-10-fix', agentId: 'claude' });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-10-fix', agentId: 'claude',
        message: { from: 'orch', body: 'claude宛メッセージ' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
      const cmd = decodeLoginShellCommand(lastSpawnCalls[0]);
      assert.ok(cmd.includes('--continue'));
      assert.ok(cmd.includes('claude宛メッセージ'));
    });
  });

  test('tryResumeAndDeliver: クローズ済みPRのブランチではresumeを起動しない', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      closedPrGuard._setListFn(() => ({
        status: 0,
        stdout: JSON.stringify([{ number: 376, state: 'CLOSED' }]),
        stderr: '',
      }));

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: '送信しない' }, workspace: dir, homedir: '/home',
        repo: 'test/repo',
      });
      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
      assert.match(result.error, /issue-7-fix/);
      assert.match(result.error, /#376/);
      assert.equal(lastSpawnCalls.length, 0);
    });
  });

  test('tryResumeAndDeliver: agentIdが未解決なら method:config-unresolvable', () => {
    const result = supervisor.tryResumeAndDeliver({
      workerName: 'issue-7-fix', agentId: 'nonexistent-agent',
      message: { from: 'orch', body: 'hi' }, workspace: '/ws', homedir: '/home',
    });
    assert.equal(result.success, false);
    assert.equal(result.method, 'config-unresolvable');
    assert.ok(result.error.includes('configを解決できません'));
  });

  test('tryResumeAndDeliver: worktreeが存在しなければ resume-failed', () => {
    withTempDir((dir) => {
      // workers.json のみ用意し、worktreeディレクトリは作らない
      fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
        orchestrator: { agentId: null },
        'issue-7-fix': { pid: 456, agentId: 'agy', issue: 7 },
      }, null, 2));

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
      assert.ok(result.error.includes('worktree'));
    });
  });

  test('tryResumeAndDeliver: 破損 workers.json は resume-failed（レジストリ失敗。エントリ不在と区別して報告）', () => {
    withTempDir((dir) => {
      // worktree は存在する。workers.json のみ解析不能にする。
      fs.mkdirSync(path.join(dir, '.gh-maestro', 'worktrees', 'issue-7-fix'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), '{ broken json');
      resetHeadlessLaunchMocks({ pid: 77 });
      supervisor._setIsWorkerAlive(() => true);

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
      // 「ワーカーが見つからない」ではなくレジストリ失敗として報告されること
      assert.ok(result.error.includes('読み取り・解析に失敗'), result.error);
      assert.ok(!result.error.includes('見つかりません'), result.error);
    });
  });

  test('tryResumeAndDeliver: agy成功時はresumeし新pid/startTimeでworkers.jsonを更新する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      resetHeadlessLaunchMocks({ pid: 77 });
      supervisor._setIsWorkerAlive(() => true);

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: '新着メッセージ本文' }, workspace: dir, homedir: '/home',
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
      assert.equal(result.pid, 77);

      // ログインシェルでラップされたコマンド文字列に --continue とメッセージ本文が含まれる
      const cmd = decodeLoginShellCommand(lastSpawnCalls[0]);
      assert.ok(cmd.includes('--continue'));
      assert.ok(cmd.includes('新着メッセージ本文'));

      const raw = readWorkersRaw(dir);
      assert.equal(raw['issue-7-fix'].pid, 77);
      assert.equal(raw['issue-7-fix'].startTime, '2026-07-25T00:00:00.000Z');
    });
  });

  test('tryResumeAndDeliver: ワーカーのログは1ファイルに追記され、代理送信用のオフセットが終了フックへ渡る', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      // 前回の実行分がすでに書かれている状態を作る
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '7', 'workers', 'issue-7-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, '前回の実行の出力\n', 'utf8');
      const priorSize = fs.statSync(logPath).size;

      supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });

      const cmd = decodeLoginShellCommand(lastSpawnCalls[0]);
      const exitHook = JSON.parse(lastSpawnCalls[0].args[3]);
      assert.match(exitHook.args[0], /worker-exit-hook\.js/, '終了フックがshimへ渡されている');
      // 前回分のバイト数がオフセットとして渡る（前回の出力を今回の応答として誤送信しないため）
      assert.ok(exitHook.args.includes(String(priorSize)), `offset ${priorSize} が渡る: ${JSON.stringify(exitHook.args)}`);
    });
  });

  test('tryResumeAndDeliver: codex（positional）も成功する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-8-fix', agentId: 'codex' });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-8-fix', agentId: 'codex',
        message: { from: 'orch', body: 'test' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
    });
  });

  test('tryResumeAndDeliver: reasonix（positional）も成功する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-9-fix', agentId: 'reasonix' });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-9-fix', agentId: 'reasonix',
        message: { from: 'orch', body: 'reasonix宛メッセージ' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
      const cmd = decodeLoginShellCommand(lastSpawnCalls[0]);
      assert.ok(cmd.includes('--continue'));
      assert.ok(cmd.includes('reasonix宛メッセージ'));
    });
  });

  test('tryResumeAndDeliver: プロセス起動失敗時は resume-failed', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      headlessLaunch._setSpawn(() => { throw new Error('spawn boom'); });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
    });
  });

  test('tryResumeAndDeliver: send-text-after-launch のエージェントは配送を拒否する（フェイルクローズ）', () => {
    // この方式は画面への入力注入が前提で、headless実行では本文を渡せない。
    // 黙って本文抜きでresumeすると、ワーカーが指示を受け取らないままGitHubへ
    // 無関係な応答を投げうるため配送自体を止める。
    // 将来この promptDelivery のエージェントが追加されたとき、ガードが無言で
    // 壊れていないことを保証する。
    withTempDir((dir) => {
      fs.mkdirSync(path.join(dir, '.gh-maestro', 'worktrees', 'issue-7-fix'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
        orchestrator: { agentId: null },
        'issue-7-fix': { pid: 456, startTime: 'old', agentId: 'legacy-sendtext', issue: 7 },
      }, null, 2));
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'config.json'), JSON.stringify({
        agents: {
          'legacy-sendtext': {
            id: 'legacy-sendtext',
            command: 'dummy-agent',
            extraArgs: [],
            promptDelivery: 'send-text-after-launch',
            asynchronousNotification: false,
            sessionResume: true,
            resumeCommand: ['--continue'],
          },
        },
      }, null, 2));

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'legacy-sendtext',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: dir,
      });

      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
      assert.match(result.error, /send-text-after-launch/);
      assert.equal(lastSpawnCalls.length, 0, 'プロセスを起動せずに拒否すること');
    });
  });

  test('tryResumeAndDeliver: spawnは成功したが直後にプロセスが消失していれば resume-failed（DELIVEREDと誤認識しない）', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      resetHeadlessLaunchMocks({ pid: 77 });
      // 起動直後の生存確認で「既に死んでいる」とする
      supervisor._setIsWorkerAlive(() => false);

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });

      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
      assert.ok(result.error.includes('77'), `error should mention the vanished pid: ${result.error}`);

      // workers.json は古いpid(456)のまま更新されない
      const raw = readWorkersRaw(dir);
      assert.equal(raw['issue-7-fix'].pid, 456);
    });
  });

  test('deliverMessage: プロセス非生存 + session-resume系エージェントは resume を試みる', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      // 休止中とみなす（resumeが走る）
      supervisor._setIsWorkerAlive((e) => !!e && e.pid === RESUMED_PID);

      const result = supervisor.deliverMessage({
        workerName: 'issue-7-fix', entry: { pid: 456, startTime: 'old', agentId: 'agy' },
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home', issue: '7',
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
    });
  });

  test('deliverMessage: プロセス非生存 + claude も resume を試みる', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'claude' });
      supervisor._setIsWorkerAlive((e) => !!e && e.pid === RESUMED_PID);

      const result = supervisor.deliverMessage({
        workerName: 'issue-7-fix', entry: { pid: 456, startTime: 'old', agentId: 'claude' },
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home', issue: '7',
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
    });
  });

  test('deliverMessage: プロセス非生存時、entry.baseBranch を GH_MAESTRO_BASE_BRANCH として注入する（Issue #269）', () => {
    // PR作成（gh-create-pr.js）のbase解決を upstream 非依存にするため、resume起動時の
    // launchAgentHeadless env に base が入っていなければならない（spawn-worker.js と同じ値）。
    // 親から継承した値（process.env.GH_MAESTRO_BASE_BRANCH='main'）を上書きし、最終的なspawn env
    // （`{ ...process.env, ...env }` マージ後）に dev が入ることを検証する。
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      supervisor._setIsWorkerAlive((e) => !!e && e.pid === RESUMED_PID);

      withInheritedBaseBranch('main', () => {
        const result = supervisor.deliverMessage({
          workerName: 'issue-7-fix',
          entry: { pid: 456, startTime: 'old', agentId: 'agy', baseBranch: 'dev' },
          message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home', issue: '7',
        });

        assert.equal(result.success, true);
        assert.equal(result.method, 'resume');

        const spawnEnv = lastSpawnCalls[0].options.env;
        assert.equal(spawnEnv.GH_MAESTRO_BASE_BRANCH, 'dev', '継承値(main)を上書きして dev が入る');
        assert.equal(spawnEnv.GH_MAESTRO_WORKER, 'issue-7-fix');
        assert.equal(spawnEnv.GH_MAESTRO_WORKSPACE, dir);
      });
    });
  });

  test('deliverMessage: baseBranch 未設定のレガシーレコードでは GH_MAESTRO_BASE_BRANCH を空文字で上書きする（フェイルクローズ）', () => {
    // baseBranch 導入以前に起動したレガシーワーカーレコード。キーを省略しただけでは
    // `{ ...process.env, ...env }` のマージで親から継承した値が残ってしまうため、空文字で
    // 明示的に上書きし gh-create-pr.js 側をフェイルクローズ（誤ったbaseでPRを作らない）させる。
    // 親から継承した値（process.env.GH_MAESTRO_BASE_BRANCH='main'）が除去されることを
    // 最終的なspawn env（マージ後）で検証する。
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      supervisor._setIsWorkerAlive((e) => !!e && e.pid === RESUMED_PID);

      withInheritedBaseBranch('main', () => {
        const result = supervisor.deliverMessage({
          workerName: 'issue-7-fix',
          entry: { pid: 456, startTime: 'old', agentId: 'agy' },
          message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home', issue: '7',
        });

        assert.equal(result.success, true);
        const spawnEnv = lastSpawnCalls[0].options.env;
        assert.equal(spawnEnv.GH_MAESTRO_BASE_BRANCH, '', '継承値(main)は除去され空文字になる');
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// shouldRetry
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldRetry', () => {
  test('初回（retries=0）は常に true', () => {
    assert.equal(supervisor.shouldRetry({ retries: 0 }, Date.now()), true);
  });

  test('MAX_RETRIES（5）以上なら false', () => {
    assert.equal(supervisor.shouldRetry({ retries: 5 }, Date.now()), false);
    assert.equal(supervisor.shouldRetry({ retries: 10 }, Date.now()), false);
  });

  test('バックオフ期間内は false', () => {
    const now = Date.now();
    assert.equal(supervisor.shouldRetry({ retries: 2, lastAttempt: new Date(now).toISOString() }, now), false);
  });

  test('バックオフ期間後は true', () => {
    const now = Date.now();
    // retries=1 → delay = 10s
    assert.equal(supervisor.shouldRetry(
      { retries: 1, lastAttempt: new Date(now - 15000).toISOString() }, now), true);
  });

  test('lastAttempt が無効なら true', () => {
    assert.equal(supervisor.shouldRetry({ retries: 2 }, Date.now()), true);
    assert.equal(supervisor.shouldRetry({ retries: 2, lastAttempt: 'invalid' }, Date.now()), true);
  });

  test('null/undefined は true', () => {
    assert.equal(supervisor.shouldRetry(null, Date.now()), true);
  });

  test('lastMethod=pending なら retries が MAX_RETRIES 以上でも true（相手がbusyなだけで失敗ではない）', () => {
    const now = Date.now();
    // retries=5でもbackoff期間さえ過ぎていればtrue（頭打ちしたbackoff間隔=160s経過）
    assert.equal(supervisor.shouldRetry(
      { retries: 5, lastMethod: 'pending', lastAttempt: new Date(now - 200000).toISOString() }, now), true);
    assert.equal(supervisor.shouldRetry(
      { retries: 20, lastMethod: 'pending', lastAttempt: new Date(now - 200000).toISOString() }, now), true);
  });

  test('lastMethod=pending でもbackoff期間内なら false', () => {
    const now = Date.now();
    assert.equal(supervisor.shouldRetry(
      { retries: 5, lastMethod: 'pending', lastAttempt: new Date(now).toISOString() }, now), false);
  });

  test('lastMethod=resume-failed なら従来通りMAX_RETRIESで恒久停止', () => {
    assert.equal(supervisor.shouldRetry({ retries: 5, lastMethod: 'resume-failed' }, Date.now()), false);
  });

  test('lastMethod=config-unresolvable なら MAX_RETRIES で false（無限リトライしない）', () => {
    const now = Date.now();
    // retries=4（次の試行で5回目）はまだtrue、retries=5到達でfalse
    assert.equal(supervisor.shouldRetry({
      retries: 4, lastMethod: 'config-unresolvable', lastAttempt: new Date(now - 200000).toISOString(),
    }, now), true);
    assert.equal(supervisor.shouldRetry({
      retries: 5, lastMethod: 'config-unresolvable',
    }, now), false);
    assert.equal(supervisor.shouldRetry({
      retries: 10, lastMethod: 'config-unresolvable',
    }, now), false);
  });

  test('lastMethod未設定でも lastError が config 解決失敗文言なら恒久停止対象（pending系と誤認しない）', () => {
    assert.equal(supervisor.shouldRetry({
      retries: 5,
      lastError: 'agentId "nonexistent-agent" のconfigを解決できません',
    }, Date.now()), false);
  });

  test('lastMethod未設定（旧cursorエントリ）でもlastErrorの文言からpending系と推定して救済する', () => {
    const now = Date.now();
    assert.equal(supervisor.shouldRetry({
      retries: 5,
      lastError: 'pane 35 is alive (worker busy) — waiting for it to become idle for resume delivery',
      lastAttempt: new Date(now - 200000).toISOString(),
    }, now), true);
    assert.equal(supervisor.shouldRetry({
      retries: 5,
      lastError: 'pane (none) is not alive — queued for resume',
      lastAttempt: new Date(now - 200000).toISOString(),
    }, now), true);
  });

  test('lastMethod未設定かつlastErrorが真の失敗文言なら従来通り恒久停止', () => {
    assert.equal(supervisor.shouldRetry({
      retries: 5,
      lastError: 'worktree /tmp/wt が存在しません（resume不可能）',
    }, Date.now()), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runOnce: スキャン・配送サイクル
// ═══════════════════════════════════════════════════════════════════════════

describe('runOnce scan and deliver cycle', () => {
  beforeEach(() => resetAllMocks());

  test('ワーカーが0件のときは SCAN_END:0:0', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));

    withTempDir((dir) => {
      setupWorkspace(dir);
      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      const lastLine = r.lines[r.lines.length - 1];
      assert.equal(lastLine, 'SCAN_END:0:0 source=worker-supervisor.js scope=worker-delivery-scan workers=0 detected=0 orchestrator-inbox=separate-msg-poll.js');
      assert.equal(r.lines[0], 'SCAN_START source=worker-supervisor.js scope=worker-delivery-scan orchestrator-inbox=separate-msg-poll.js');
    });
  });

  // ── 死のスイッチ配線（Issue #301） ─────────────────────────────────────
  // runOnce が親セッションの死を検出したとき、role lease を解放して exit 3 で終了する
  // （受け入れ条件1: 死のスイッチ経路で lease が解放される）。scriptName と sessionPid が
  // stderr に出力される（沈黙しない）。resetAllMocks は死のスイッチの注入を戻さないため、
  // このテスト自身の finally で必ず復元する。

  test('死のスイッチ発火時: role lease を解放し exit 3 で終了する（配線）', () => {
    const { createDeadManSwitch } = require('../scripts/process-lifecycle');
    const { PARENT_DEATH_EXIT_CODE } = require('../scripts/shared/watchdog-exit-notify');
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));

    withTempDir((dir) => {
      setupWorkspace(dir);
      const stderrLines = [];
      let capturedExpectedStartTime;
      const origStderr = process.stderr.write;
      try {
        // 死のスイッチを常時「死」と判定させる。checkParent は main() 内で生成されるため
        // runMain より前に注入する（_setParentDeathExit は sentinel 例外で抜ける）。
        supervisor._setCreateDeadManSwitch((_pid, options) => {
          capturedExpectedStartTime = options.expectedStartTime;
          return () => false;
        });
        let exitCode = null;
        supervisor._setParentDeathExit((code) => { exitCode = code; throw new Error('parent-death-exit sentinel'); });
        process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

        const r = runMain(['--workspace', dir]);
        assert.equal(r.code, 0);
        assert.equal(capturedExpectedStartTime, TEST_SESSION_START_TIME,
          'main() が捕捉した起動時刻を createDeadManSwitch に渡す');
        const leaseFile = path.join(dir, '.gh-maestro', 'leases', 'resident-role-worker-supervisor.json');
        assert.ok(fs.existsSync(leaseFile), 'role lease ファイルが作成される');

        // runOnce 1回で死のスイッチ発火 → lease 解放 + exit 3
        assert.throws(() => r.runOnce(), /parent-death-exit sentinel/);
        assert.equal(exitCode, PARENT_DEATH_EXIT_CODE, '死のスイッチは exit 3 で終了する');
        assert.equal(fs.existsSync(leaseFile), false, '死のスイッチ経路で role lease が解放される（受け入れ条件1）');
        assert.ok(
          stderrLines.some(l => l.includes('worker-supervisor.js') && l.includes(`pid ${TEST_SESSION_PID}`)),
          `stderr に worker-supervisor.js と sessionPid が出力される: ${stderrLines.join('|')}`
        );
      } finally {
        process.stderr.write = origStderr;
        supervisor._setCreateDeadManSwitch(createDeadManSwitch);
        supervisor._setParentDeathExit((code) => process.exit(code));
      }
    });
  });

  test('新着メッセージを検出して配送する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 100,
        created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
    ]));
    // 既存ワーカーは休止中とし、resume経由で配送させる（resetAllMocks の既定）。

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:100'),
        `Lines: ${r.lines.join('\n')}`);
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:100'));

      // カーソルが永続化されている
      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.seenIds.includes(100));
      assert.ok(state.deliveredIds.includes(100));
      assert.equal(state.since, '2024-06-01T12:00:00Z');
    });
  });

  // ── Issue #250: writeCursor の EPERM 失敗への耐性 ───────────────────────
  // カーソルファイルの位置をディレクトリ化すると rename（writeCursor）が必ず失敗する。
  // Windows では EPERM（リトライ対象）で約500ms粘ってから throw、Linux では即 throw と
  // 差異はあるが、いずれも「プロセスを止めず次サイクルで再試行する」ことが目的なので
  // プラットフォーム非依存のテストとして両OSで実行する。

  test('writeCursor が失敗しても runOnce はクラッシュせず配送と SCAN_END まで進む', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 100,
        created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });
      // カーソルファイルの位置をディレクトリ化 → writeCursor（rename）が失敗する
      fs.mkdirSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'cursor.json'), { recursive: true });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      // throw せず最後まで進む（常駐プロセスが落ちない）
      assert.doesNotThrow(() => r.runOnce());
      // 配送は行われ、カーソル保存だけ失敗して stderr に記録される
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:100'), `Lines: ${r.lines.join('\n')}`);
      assert.ok(r.lines.some(l => l.includes('SCAN_END:1:1')), `Lines: ${r.lines.join('\n')}`);
      assert.ok(r.errLines.some(l => l.includes('カーソル保存に失敗')), `errLines: ${r.errLines.join('\n')}`);
    });
  });

  test('writeCursor が失敗し続けてもメモリキャッシュで重複配送しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 100,
        created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });
      // 全サイクルで writeCursor が失敗するため、ディスクのカーソルは常に初期状態のまま
      fs.mkdirSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'cursor.json'), { recursive: true });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce(); // 1サイクル目: 配送するが writeCursor 失敗（ディスクは初期のまま）
      r.runOnce(); // 2サイクル目: ディスクが巻き戻っていてもメモリキャッシュで重複配送しない

      const delivered = r.lines.filter(l => l === 'DELIVERED:issue-5-fix:100');
      assert.equal(delivered.length, 1, `Expected exactly 1 DELIVERED, got ${delivered.length}: ${r.lines.join('\n')}`);
    });
  });

  test('既読メッセージは再検出しない（seenIds 重複防止）', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 100, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
      {
        id: 101, created_at: '2024-06-01T13:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test 2',
      },
    ]));
    // 既存ワーカーは休止中とし、resume経由で配送させる（resetAllMocks の既定）。

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [100],
            deliveredIds: [100],
            pendingDeliveries: {},
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l === 'DETECTED:issue-5-fix:100'), '100 should be skipped (already seen)');
      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:101'), '101 should be detected');
    });
  });

  test('配送失敗時は pendingDeliveries に記録される', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 200, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
    ]));
    // プロセス非生存 → resumeを試みるが、プロセス起動自体が失敗する
    setWorkersIdle();
    headlessLaunch._setSpawn(() => { throw new Error('spawn boom'); });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:200'));
      assert.ok(r.lines.some(l => l.startsWith('DELIVERY_FAILED:issue-5-fix:200')));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.seenIds.includes(200));
      assert.ok(!state.deliveredIds.includes(200));
      assert.ok(state.pendingDeliveries['200']);
      assert.equal(state.pendingDeliveries['200'].retries, 1);
    });
  });

  test('config解決失敗が5回（MAX_RETRIES）で断念し orchestrator に本当のエラーで通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // ワーカーは非生存（resetAllMocks の既定）＋ agentId が解決できない。
    // _notifyOrchestrator を実spawnせず記録だけするモックに差し替える。
    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          // agentId が解決できないワーカー（config-unresolvable が発生する状態）
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'nonexistent-agent', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [200],
            deliveredIds: [],
            pendingDeliveries: {
              '200': {
                // 既に4回失敗済み。今回の試行で5回目＝MAX_RETRIES到達。
                // lastMethod が config-unresolvable なので pending 系（無限リトライ）と誤認しない。
                retries: 4,
                lastAttempt: new Date(Date.now() - 200000).toISOString(),
                lastError: 'agentId "nonexistent-agent" のconfigを解決できません',
                lastMethod: 'config-unresolvable',
                lastFrom: 'orchestrator',
                lastBody: 'pending message body',
              },
            },
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'RETRYING:issue-5-fix:200:5'),
        `5回目の再試行が出力されること: ${r.lines.join('\n')}`);
      assert.ok(r.lines.some(l => l.startsWith('DELIVERY_FAILED:issue-5-fix:200') && l.includes('configを解決できません')),
        `DELIVERY_FAILED に本当のエラーが含まれること: ${r.lines.join('\n')}`);

      assert.equal(notifyCalls.length, 1, '配送断念の通知が1回呼ばれる');
      assert.ok(notifyCalls[0].body.includes('issue-5-fix'),
        `giveUpBody にワーカー名が含まれる: ${notifyCalls[0].body}`);
      assert.ok(notifyCalls[0].body.includes('configを解決できません'),
        `giveUpBody に本当のエラーが含まれる: ${notifyCalls[0].body}`);

      // カーソルにも本当のエラーが残る
      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state.pendingDeliveries['200'].retries, 5);
      assert.ok(state.pendingDeliveries['200'].lastError.includes('configを解決できません'));
    });
  });

  test('pending の再試行で配送成功したら deliveredIds に移動', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // ペインは非生存（休止中）とし、resume経由での再試行を成功させる。resume後の生存確認では

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [300],
            deliveredIds: [],
            pendingDeliveries: {
              '300': {
                retries: 1,
                lastAttempt: new Date(Date.now() - 20000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: 'pending message body',
              },
            },
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:300')));
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:300'));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.deliveredIds.includes(300));
      assert.equal(state.pendingDeliveries['300'], undefined);
    });
  });

  test('pending 再試行: lastBody が空の場合に _ghApiComments から本文を再取得して配送する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    // 新着コメントスキャンは空
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 350,
        created_at: '2024-06-01T15:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> re-fetched body content',
      },
    ]));
    // ペインは非生存（休止中）とし、resume経由での再試行を成功させる。resume後の生存確認では

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [350],
            deliveredIds: [],
            pendingDeliveries: {
              '350': {
                retries: 1,
                lastAttempt: new Date(Date.now() - 20000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: '',  // ★ 空 — 再取得パスをテスト
              },
            },
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      // 再試行が行われ、本文を再取得して配送成功する
      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:350')),
        `RETRYING not found in: ${r.lines.join('\n')}`);
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:350'),
        `DELIVERED not found in: ${r.lines.join('\n')}`);

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.deliveredIds.includes(350));
      assert.equal(state.pendingDeliveries['350'], undefined);
      // 再取得された本文が pending エントリに保存されている
      // （pending は削除済みのため、lastBody の検証は不要）
    });
  });

  test('pending が MAX_RETRIES 超過で再試行されない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [400],
            deliveredIds: [],
            pendingDeliveries: {
              '400': {
                retries: 5,
                lastAttempt: new Date(Date.now() - 20000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: 'msg',
              },
            },
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:400')),
        'Should not retry when MAX_RETRIES exceeded');
    });
  });

  test('配送を断念（MAX_RETRIES到達）したら orchestrator へ通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // ペイン非生存 → resumeを試みるが、ペイン起動自体が失敗し続ける（真の失敗を再現）
    headlessLaunch._setSpawn(() => { throw new Error('spawn boom'); });

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [999],
            deliveredIds: [],
            pendingDeliveries: {
              '999': {
                retries: 4,
                lastAttempt: new Date(Date.now() - 200000).toISOString(),
                lastError: 'resume-failed previously',
                lastMethod: 'resume-failed',
                lastFrom: 'orchestrator',
                lastBody: 'msg',
              },
            },
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:999')));
      assert.ok(r.lines.some(l => l.startsWith('DELIVERY_FAILED:issue-5-fix:999')));
      assert.ok(r.errLines.some(l => l.includes('max retries (5) exceeded')),
        `errLines: ${r.errLines.join('\n')}`);

      assert.equal(notifyCalls.length, 1, 'orchestratorへの断念通知が1回呼ばれる');
      assert.equal(notifyCalls[0].workspace, dir);
      assert.equal(notifyCalls[0].issue, '5');
      assert.ok(notifyCalls[0].body.includes('issue-5-fix'));
      assert.ok(notifyCalls[0].body.includes('999'));
    });
  });

  test('gh api エラーはスキップして続行', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(() => ({
      status: 1, stdout: '', stderr: 'rate limit exceeded',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      assert.doesNotThrow(() => r.runOnce());
      assert.ok(r.errLines.some(l => l.includes('rate limit exceeded')));
    });
  });

  test('自分宛てでないメッセージは無視する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 500, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"other-worker","from":"orchestrator"} -->\n> test',
      },
      {
        id: 501, created_at: '2024-06-01T13:00:00Z',
        body: 'no marker here',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.includes('DETECTED')), 'No messages for this worker');

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      // カーソルは全コメントの最大 created_at まで進む（非マッチも含む）
      assert.equal(state.since, '2024-06-01T13:00:00Z');
      // 自分宛てでないコメントは seenIds に入らない（カーソルが再フェッチを防ぐ）
    });
  });

  test('issue が null のワーカーはスキップ', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'no-issue-worker': { pid: 123, startTime: 'old', agentId: 'agy', issue: null },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      const lastLine = r.lines[r.lines.length - 1];
      assert.ok(lastLine.includes('SCAN_END:1:0'), `Got: ${lastLine}`);
    });
  });

  test('複数ワーカーを独立に監視する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));

    let callCount = 0;
    supervisor._setGhApiComments(() => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 0,
          stdout: JSON.stringify([{
            id: 601, created_at: '2024-06-01T12:00:00Z',
            body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg1',
          }]),
          stderr: '',
        };
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    });
    // どちらのペインも非生存（休止中）とし、resume経由で配送させる。resume後の生存確認では

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 111, startTime: 'old', agentId: 'agy', issue: 5 },
          'issue-8-add': { pid: 222, startTime: 'old', agentId: 'agy', issue: 8 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:601'));
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:601'));

      const state5 = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state5.since, '2024-06-01T12:00:00Z');
      assert.ok(state5.seenIds.includes(601));

      const state8 = supervisor.readCursor(dir, 'issue-8-add');
      assert.equal(state8.since, null);
      assert.deepEqual(state8.seenIds, []);
    });
  });

  test('claude系も他のエージェントと同様にスキャン対象に含まれる（稼働中ペインならresumeしない）', () => {
    // claude系はresume方式に統一されたため、スキャン除外対象ではなくなった。
    // ただしペインが稼働中（作業中）の場合はどのエージェント種別でも書き込まない、という
    // 汎用ルールにより、この場合はresumeが試みられないことに変わりはない。
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 900, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));
    // ワーカーは稼働中（作業中）とする。稼働中には一切書き込まない＝resumeしないことを確認する。
    setWorkersBusy();
    let resumeSpawned = false;
    headlessLaunch._setSpawn(() => { resumeSpawned = true; return { pid: 999, on() { return this; }, unref() {} }; });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'claude', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('DETECTED:issue-5-fix:')), 'claude系workerもスキャン・検出対象に含まれる');
      assert.equal(resumeSpawned, false, 'ワーカーが稼働中の間はresumeで書き込まない');

      const lastLine = r.lines[r.lines.length - 1];
      assert.ok(lastLine.includes('SCAN_END:1:1'), `claude系も検出されるはず: ${lastLine}`);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ハング検知
// ═══════════════════════════════════════════════════════════════════════════

describe('Hang detection', () => {
  beforeEach(() => resetAllMocks());

  test('ハング検知→通知: ワーカー生存＋ログmtime閾値超過で orchestartor に通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // ワーカーは稼働中（生存）とする
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      // ログファイルを古いmtimeで作成
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log content\n', 'utf8');
      // 閾値（既定1200秒=20分）を超える過去のmtimeに設定
      const hangAgeMs = (25 * 60 + 7) * 1000;
      const oldTime = new Date(Date.now() - hangAgeMs); // 25分7秒前
      fs.utimesSync(logPath, oldTime, oldTime);
      const logMtimeMs = fs.statSync(logPath).mtimeMs;

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      const beforeScanMs = Date.now();
      r.runOnce();
      const afterScanMs = Date.now();

      const hangLine = r.lines.find(l => l.startsWith('HANG_DETECTED:issue-5-fix:456'));
      assert.ok(hangLine,
        `HANG_DETECTED が出力されること: ${r.lines.join('\n')}`);
      const elapsedSeconds = parseElapsedSeconds(hangLine);
      const expectedMinSeconds = Math.floor((beforeScanMs - logMtimeMs) / 1000);
      const expectedMaxSeconds = Math.floor((afterScanMs - logMtimeMs) / 1000);
      assert.ok(elapsedSeconds >= expectedMinSeconds && elapsedSeconds <= expectedMaxSeconds,
        `HANG_DETECTED の経過時間が実際のログmtime起点の値であること: ${elapsedSeconds}秒, expected=${expectedMinSeconds}..${expectedMaxSeconds}`);
      assert.ok(elapsedSeconds >= Math.floor(hangAgeMs / 1000),
        `HANG_DETECTED が固定値ではなく25分7秒前のmtimeを反映すること: ${elapsedSeconds}秒`);

      assert.equal(notifyCalls.length, 1, 'orchestratorへ1回通知');
      assert.ok(notifyCalls[0].body.includes('ハング'));
      assert.ok(notifyCalls[0].body.includes('issue-5-fix'));
      assert.ok(notifyCalls[0].body.includes('456'));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state.hangNotifiedPid, 456);
      assert.ok(typeof state.hangNotifiedAt === 'string');
    });
  });

  test('重複通知防止: 同一PIDでログ未更新のまま2回目のrunOnceでは通知しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: null,
            seenIds: [],
            deliveredIds: [],
            pendingDeliveries: {},
            hangNotifiedPid: 456, // 既に通知済み（同一プロセス: startTimeも一致）
            hangNotifiedStartTime: 'old',
            hangNotifiedAt: '2024-07-30T12:00:00.000Z',
          },
        },
      });

      // 古いログ（まだ更新されていない）
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      const oldTime = new Date(Date.now() - 25 * 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      // HANG_DETECTED は出力されない（同一PIDに既に通知済みのため）
      assert.ok(!r.lines.some(l => l.startsWith('HANG_DETECTED:issue-5-fix:456')),
        `再通知されないこと: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 0, '通知呼び出しが発生しない');
    });
  });

  test('復帰検知: ハング通知後にログが更新されると HANG_RESUMED が出力されて状態がリセットされる', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: null,
            seenIds: [],
            deliveredIds: [],
            pendingDeliveries: {},
            hangNotifiedPid: 456, // 前回通知済み（同一プロセス: startTimeも一致）
            hangNotifiedStartTime: 'old',
            hangNotifiedAt: '2024-07-30T12:00:00.000Z',
          },
        },
      });

      // ログを直近に更新（ハングから復帰した状態をシミュレート）
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'updated log content\n', 'utf8');
      // 現在時刻のmtime（fs.writeFileSync の既定 = 現在時刻）

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'HANG_RESUMED:issue-5-fix:456'),
        `HANG_RESUMED が出力されること: ${r.lines.join('\n')}`);

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state.hangNotifiedPid, null, 'PIDがリセットされている');
      assert.equal(state.hangNotifiedAt, null, 'タイムスタンプがリセットされている');
    });
  });

  test('ワーカー非生存時はハング判定をスキップする', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // 非生存（_isWorkerAliveがfalseを返す）＝ resetAllMocks の既定
    // setWorkersIdle() が設定する既定で休止中扱い

    const r = withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      // 古いログがあってもハング検知されない
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      const oldTime = new Date(Date.now() - 25 * 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      return r;
    });

    assert.ok(!r.lines.some(l => l.startsWith('HANG_DETECTED')),
      `ハング検知の出力がないこと: ${r.lines.join('\n')}`);
  });

  test('ログファイルが存在しなければ例外を投げずにスキップする', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    // ログファイルを作成しない（存在しない状態）

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      assert.doesNotThrow(() => {
        const r = runMain(['--workspace', dir]);
        assert.equal(r.code, 0);
        r.runOnce();
      });
    });
  });

  test('--hang-threshold-sec より短い経過時間なら通知しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      // 10秒前のログ（--hang-threshold-sec=30 より短い＝通知されない）
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'recent log\n', 'utf8');
      const recentTime = new Date(Date.now() - 10 * 1000);
      fs.utimesSync(logPath, recentTime, recentTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '30']);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('HANG_DETECTED')),
        `HANG_DETECTED が出力されないこと: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 0, '通知呼び出しが発生しない');
    });
  });

  test('--hang-threshold-sec より長い経過時間なら通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      // 60秒前のログ（--hang-threshold-sec=10 より長い＝通知される）
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      const oldTime = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('HANG_DETECTED:issue-5-fix:456')),
        `HANG_DETECTED が出力されること: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 1, '通知が1回呼ばれる');
    });
  });

  // ── Issue #250 / PR #251: HANG_DETECTED 時のカーソル保存の保護漏れ ──────
  // 通知成功後に実行される writeCursor（HANG_DETECTED 経路）は、EPERM でも常駐プロセスを
  // 止めず、連続失敗カウンタに計上して次サイクルの保存成功時にリセットされる（HANG_RESUMED
  // 経路と同じ扱い）。

  test('HANG_DETECTED後のカーソル保存が失敗しても runOnce はクラッシュしない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);
    supervisor._setNotifyOrchestrator(() => ({ status: 0, stdout: '', stderr: '' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      // 60秒前のログ（--hang-threshold-sec=10 より長い＝ハング検知され、通知成功→カーソル保存へ）
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      const oldTime = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      // カーソルファイルの位置をディレクトリ化 → 通知成功後の writeCursor が必ず失敗する
      fs.mkdirSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'cursor.json'), { recursive: true });

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      // throw せず最後まで進む（EPERM で supervisor が落ちない）
      assert.doesNotThrow(() => r.runOnce());
      assert.ok(r.lines.some(l => l.startsWith('HANG_DETECTED:issue-5-fix:456')),
        `HANG_DETECTED が出力されること: ${r.lines.join('\n')}`);
      // カーソル保存の失敗は stderr に記録される
      assert.ok(r.errLines.some(l => l.includes('カーソル保存に失敗')), `errLines: ${r.errLines.join('\n')}`);
    });
  });

  test('_notifyOrchestrator はIssueコメントではなく監査イベントへ通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 },
        },
      });

      // 60秒前のログ → ハング検知され、実 _notifyOrchestrator が監査へ記録する
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      const oldTime = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      r.runOnce();

      const events = residentAudit.listUnprocessedResidentAuditEvents(dir);
      assert.equal(events.length, 1);
      assert.equal(events[0].event.type, 'notification');
      assert.equal(events[0].event.role, 'worker-supervisor');
      assert.ok(events[0].event.detail.body.includes('ハング'));
    });
  });

  // ── Issue #265: resume直後の誤検知防止 ──────────────────────────────────
  // ログのmtimeは前セッション終了時点のまま引き継がれるため、resume直後に
  // まだログを書いていない新プロセスをそのまま「無反応」と誤判定してはならない。
  // 判定基準は「ログmtime」と「現在のプロセスのstartTime」のうち新しい方とする。

  test('resume直後（startTimeが新しくログmtimeが古い）は通知しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      // 前セッションの終了から109分経過した古いログが引き継がれているが、
      // プロセス自体はたった今resumeで起動したばかり（startTimeは現在時刻）。
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: new Date().toISOString(), agentId: 'agy', issue: 5 },
        },
      });

      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'stale log from previous session\n', 'utf8');
      const oldTime = new Date(Date.now() - 109 * 60 * 1000); // 109分前
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('HANG_DETECTED')),
        `resume直後はHANG_DETECTEDが出力されないこと: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 0, '通知呼び出しが発生しない');
    });
  });

  test('resumeで新PIDになった場合、旧プロセスの通知済み状態が残っていてもHANG_RESUMEDは誤報されない（レビュー指摘）', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      const oldStartTime = '2026-08-12T00:00:00.000Z';
      const newStartTime = new Date().toISOString(); // 新プロセスがたった今起動

      setupWorkspace(dir, {
        workers: {
          // resumeでPIDが変わった新プロセス（旧PID 111 とは別物）
          'issue-5-fix': { pid: 456, startTime: newStartTime, agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: null,
            seenIds: [],
            deliveredIds: [],
            pendingDeliveries: {},
            // 旧プロセス（PID 111）に対する通知済み状態が残留している
            hangNotifiedPid: 111,
            hangNotifiedStartTime: oldStartTime,
            hangNotifiedAt: '2026-08-11T22:00:00.000Z',
          },
        },
      });

      // ログは前セッション終了時点のまま（新プロセスはまだ書いていない）
      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'stale log from previous session\n', 'utf8');
      const oldTime = new Date(Date.now() - 109 * 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      r.runOnce();

      // 実際にはログは動いていないので「復帰した」という報告は誤り
      assert.ok(!r.lines.some(l => l.startsWith('HANG_RESUMED:issue-5-fix')),
        `新プロセスへの切り替わりをHANG_RESUMEDとして誤報しないこと: ${r.lines.join('\n')}`);
      assert.ok(!r.lines.some(l => l.startsWith('HANG_DETECTED')),
        `新プロセスはstartTimeが新しいため通知もされないこと: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 0, '通知呼び出しが発生しない');

      // 旧プロセスの残留状態はクリアされる（そのプロセスはもう存在しないため）
      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state.hangNotifiedPid, null, '旧PIDの通知済み状態はクリアされる');
      assert.equal(state.hangNotifiedStartTime, null);
      assert.equal(state.hangNotifiedAt, null);
    });
  });

  test('startTimeも十分前（実際にハングしている）なら従来どおり通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      const oldTime = new Date(Date.now() - 60 * 1000); // 60秒前に起動・ログ更新
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: oldTime.toISOString(), agentId: 'agy', issue: 5 },
        },
      });

      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('HANG_DETECTED:issue-5-fix:456')),
        `プロセス起動から十分経過していれば通知されること: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 1, '通知が1回呼ばれる');
    });
  });

  test('startTimeが無いエントリでは従来どおりログmtimeのみで判定する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        // startTime を持たない（移行前・取得失敗時を想定）
        workers: {
          'issue-5-fix': { pid: 456, agentId: 'agy', issue: 5 },
        },
      });

      const logPath = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-fix', 'worker.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'old log\n', 'utf8');
      const oldTime = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(logPath, oldTime, oldTime);

      const r = runMain(['--workspace', dir, '--hang-threshold-sec', '10']);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('HANG_DETECTED:issue-5-fix:456')),
        `startTime欠落時もログmtimeで通知されること: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 1, '通知が1回呼ばれる');
    });
  });
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
      id: 700, created_at: createdAt,
      body: `<!-- gh-maestro {"v":1,"to":"orchestrator","from":"${from}"} -->\n> 完了しました`,
    };
  }

  test('居座り検知→通知: 起動以降に報告済みなのに生存中なら通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    const reportCreatedAt = new Date(Date.now() - (7 * 60 + 5) * 1000).toISOString();
    supervisor._setGhApiComments(mockGhApiComments([reportComment({ createdAt: reportCreatedAt })]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      const beforeScanMs = Date.now();
      r.runOnce();
      const afterScanMs = Date.now();

      const staleLine = r.lines.find(l => l.startsWith('STALE_REPORT_DETECTED:issue-5-fix:456'));
      assert.ok(staleLine,
        `STALE_REPORT_DETECTED が出力されること: ${r.lines.join('\n')}`);
      const elapsedSeconds = parseElapsedSeconds(staleLine);
      const reportMs = Date.parse(reportCreatedAt);
      const expectedMinSeconds = Math.floor((beforeScanMs - reportMs) / 1000);
      const expectedMaxSeconds = Math.floor((afterScanMs - reportMs) / 1000);
      assert.ok(elapsedSeconds >= expectedMinSeconds && elapsedSeconds <= expectedMaxSeconds,
        `STALE_REPORT_DETECTED の経過時間が実際の報告時刻起点の値であること: ${elapsedSeconds}秒, expected=${expectedMinSeconds}..${expectedMaxSeconds}`);
      assert.ok(elapsedSeconds >= 7 * 60 + 5,
        `STALE_REPORT_DETECTED が固定値ではなく報告7分5秒前の時刻を反映すること: ${elapsedSeconds}秒`);
      assert.equal(notifyCalls.length, 1, 'orchestratorへ1回通知');
      assert.ok(notifyCalls[0].body.includes('issue-5-fix'));
      assert.ok(notifyCalls[0].body.includes('456'));
      assert.ok(notifyCalls[0].body.includes('未コミット変更'), '未コミット変更の確認を促す文言が含まれること');
      assert.ok(!notifyCalls[0].body.includes('必要ならプロセスを終了してください'), '断定的な終了指示が含まれないこと');
      assert.ok(/投稿から .+ 経過/.test(notifyCalls[0].body), '経過時間の表示が含まれること');

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state.staleReportNotifiedPid, 456);
      assert.equal(state.staleReportNotifiedStartTime, START_TIME, '重複排除キーに起動時刻も記録されること');
      assert.ok(typeof state.staleReportNotifiedAt === 'string');
    });
  });

  test('居座り通知本文に報告投稿からの経過時間が人間可読形式で含まれる', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    // 起動時刻の5分後に投稿された報告コメント
    supervisor._setGhApiComments(mockGhApiComments([reportComment({ createdAt: '2026-07-25T00:05:00Z' })]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.equal(notifyCalls.length, 1);
      assert.ok(notifyCalls[0].body.includes('⚠️ ワーカー "issue-5-fix" は既に報告を投稿済み'));
      assert.ok(notifyCalls[0].body.includes('経過）ですが、プロセス（PID 456）が生存しています'));
      assert.match(notifyCalls[0].body, /投稿から \d+(秒|分\d+秒|時間\d+分\d+秒) 経過/);
    });
  });

  test('居座り通知の経過時間はプロセス起動時刻ではなく報告コメントの投稿時刻（最新報告）を起点に計算される', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));

    // プロセス起動: 1時間前
    const now = Date.now();
    const workerStartTime = new Date(now - 3600000).toISOString();
    // 報告コメント1（古い報告）: 30分前
    const oldReportTime = new Date(now - 1800000).toISOString();
    // 報告コメント2（最新報告）: 11秒前（10秒猶予を超過）
    const latestReportTime = new Date(now - 11000).toISOString();

    const comments = [
      {
        id: 701,
        created_at: oldReportTime,
        body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"issue-5-fix"} -->\n> 中間報告',
      },
      {
        id: 702,
        created_at: latestReportTime,
        body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"issue-5-fix"} -->\n> 最終報告',
      },
    ];

    supervisor._setGhApiComments(mockGhApiComments(comments));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: workerStartTime, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.equal(notifyCalls.length, 1);
      const body = notifyCalls[0].body;

      // 起点が最新報告コメント（約11秒前）であるため、10秒猶予後の通知になること
      assert.match(body, /投稿から (11|12|13)秒 経過/, `通知本文の経過時間が最新報告（11秒前）起点であること: ${body}`);
      // プロセス起動時刻起点（1時間...）や古い報告起点（30分...）になっていないこと
      assert.ok(!body.includes('時間'), `プロセス起動時刻起点（1時間...）になっていないこと: ${body}`);
      assert.ok(!body.includes('30分'), `古い報告コメント起点（30分...）になっていないこと: ${body}`);
    });
  });

  test('報告投稿から10秒未満は居座り通知を発火しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    const reportCreatedAt = new Date(Date.now() - 1000).toISOString();
    supervisor._setGhApiComments(mockGhApiComments([reportComment({ createdAt: reportCreatedAt })]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED')));
      assert.equal(notifyCalls.length, 0);
      assert.equal(supervisor.readCursor(dir, 'issue-5-fix').staleReportNotifiedPid, null);
    });
  });

  test('猶予中にカーソルが報告を追い越しても、次巡回で10秒経過後に発火する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    const reportCreatedAt = new Date(Date.now() - 1000).toISOString();
    supervisor._setGhApiComments(mockGhApiComments([reportComment({ createdAt: reportCreatedAt })]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();
      assert.equal(notifyCalls.length, 0, '猶予中は通知しない');
      const pending = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(pending.staleReportPendingPid, 456);

      // 実運用では時間経過を待つ。このテストでは永続化された保留時刻を進めて、
      // 次巡回がコメントを再取得できなくても猶予後判定へ到達することを検証する。
      pending.staleReportPendingCreatedAt = new Date(Date.now() - 11000).toISOString();
      supervisor.writeCursor(dir, 'issue-5-fix', pending);
      supervisor._setGhApiComments(mockGhApiComments([]));

      r.runOnce();
      assert.equal(notifyCalls.length, 1, '次巡回で猶予後の通知が発火する');
      assert.ok(r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED:issue-5-fix:456')));
    });
  });

  // 居座り判定専用の追加のgh api呼び出しを行わない（レビュー指摘: 2重取得はAPIレート制限を
  // 通じて配送そのものを止めうる。本Issueの目的と矛盾するため必ず1回に抑える）。
  test('居座り判定は新着コメントスキャンと同じ取得結果を再利用し、追加のgh api呼び出しを行わない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setIsWorkerAlive(() => true);
    supervisor._setNotifyOrchestrator(() => ({ status: 0, stdout: '', stderr: '' }));

    let apiCallCount = 0;
    supervisor._setGhApiComments((repo, issue, since, opts) => {
      apiCallCount++;
      return { status: 0, stdout: JSON.stringify([reportComment()]), stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.equal(apiCallCount, 1, `1ワーカーにつきgh apiコメント取得は1回だけであること（居座り判定用の別取得を追加しない）: 実際 ${apiCallCount} 回`);
      assert.ok(r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED:issue-5-fix:456')));
    });
  });

  test('未報告のまま生存中は通知しない（休止待ちの正常状態）', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([])); // まだ何も報告していない
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED')),
        `未報告なら検知されないこと: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 0);
    });
  });

  test('重複通知防止: 同一プロセス（同一PID+同一起動時刻）で2回目のrunOnceでは通知しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([reportComment()]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: null,
            seenIds: [],
            deliveredIds: [],
            pendingDeliveries: {},
            staleReportNotifiedPid: 456, // 既に通知済み（同一プロセス）
            staleReportNotifiedStartTime: START_TIME,
            staleReportNotifiedAt: '2026-07-25T00:10:00.000Z',
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED')),
        `再通知されないこと: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 0);
    });
  });

  // PID単独をキーにすると、通知後にワーカーが終了し、OSが同じPIDを無関係な別プロセスへ
  // 再利用した場合、そのPIDで起動された別の（未報告の）ワーカーまで「通知済み」と誤認して
  // 再通知を抑止してしまう（同一ファイル内の _isWorkerAlive → verifyProcessIdentity と同じ
  // 落とし穴）。startTimeも一致することを要求して区別する。
  test('PID再利用: 同一PIDでも起動時刻が異なれば別プロセスとして再通知する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([reportComment({ createdAt: '2026-07-26T00:05:00Z' })]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    const NEW_START_TIME = '2026-07-26T00:00:00.000Z';

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          // PIDは前回と同じ456だが、OSに再利用され別プロセスとして起動している
          // （startTimeが異なる）。
          'issue-5-fix': { pid: 456, startTime: NEW_START_TIME, agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: null,
            seenIds: [],
            deliveredIds: [],
            pendingDeliveries: {},
            staleReportNotifiedPid: 456, // 前回プロセス（別のstartTime）で通知済み
            staleReportNotifiedStartTime: START_TIME,
            staleReportNotifiedAt: '2026-07-25T00:10:00.000Z',
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED:issue-5-fix:456')),
        `startTimeが変われば別プロセスとして再通知されること: ${r.lines.join('\n')}`);
      assert.equal(notifyCalls.length, 1);

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state.staleReportNotifiedStartTime, NEW_START_TIME, '通知済みキーが新プロセスの起動時刻に更新されること');
    });
  });

  test('起動時刻を特定できない（startTimeが無い）場合は判定せず通知しない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([reportComment()]));
    supervisor._setIsWorkerAlive(() => true);

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: null, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED')));
      assert.equal(notifyCalls.length, 0);
    });
  });

  test('ワーカー非生存時は居座り判定をスキップする', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([reportComment()]));
    // 非生存（resetAllMocks の既定 = setWorkersIdle）

    const notifyCalls = [];
    supervisor._setNotifyOrchestrator((opts) => {
      notifyCalls.push(opts);
      return { status: 0, stdout: '', stderr: '' };
    });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { pid: 456, startTime: START_TIME, agentId: 'agy', issue: 5 },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('STALE_REPORT_DETECTED')));
      assert.equal(notifyCalls.length, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 信頼性: 再起動後継続
// ═══════════════════════════════════════════════════════════════════════════

describe('Reliability: restart continuity', () => {
  beforeEach(() => resetAllMocks());

  test('再起動後もカーソルから継続できる', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    // 既存ワーカーは休止中とし、resume経由で配送させる（resetAllMocks の既定）。

    // 1回目の run: コメント 700 を配送
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 700, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 } },
      });

      const r1 = runMain(['--workspace', dir]);
      r1.runOnce();
      assert.ok(r1.lines.some(l => l === 'DELIVERED:issue-5-fix:700'));

      // カーソルが永続化されているか確認
      const state1 = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state1.since, '2024-06-01T12:00:00Z');
      assert.ok(state1.deliveredIds.includes(700));
    });

    // 2回目の run（再起動シミュレーション）
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 701, created_at: '2024-06-01T13:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg2',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 } },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [700],
            deliveredIds: [700],
            pendingDeliveries: {},
          },
        },
      });

      const r2 = runMain(['--workspace', dir]);
      r2.runOnce();

      // 700 は再検出されない
      const linesWith700 = r2.lines.filter(l => l.includes('700'));
      assert.equal(linesWith700.length, 0, `Should not re-detect 700: ${r2.lines.join('\n')}`);
      // 701 は新規検出
      assert.ok(r2.lines.some(l => l === 'DETECTED:issue-5-fix:701'));
    });
  });

  test('未配送メッセージが再起動後も pending に残りリトライされる', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // 再試行時もペインは非生存（休止中）のままとし、resume経由で配送させる。resume後の生存確認では

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'agy', issue: 5 } },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [800],
            deliveredIds: [],
            pendingDeliveries: {
              '800': {
                retries: 2,
                lastAttempt: new Date(Date.now() - 50000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: 'undelivered message',
              },
            },
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:800')));
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:800'));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.deliveredIds.includes(800));
      assert.equal(state.pendingDeliveries['800'], undefined);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 重複配送防止
// ═══════════════════════════════════════════════════════════════════════════

describe('Duplicate delivery prevention', () => {
  beforeEach(() => resetAllMocks());

  test('配送済みメッセージは再配送しない（deliveredIds 重複防止）', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    // since が古いため既配信のコメントも再取得される
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 900, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { pid: 456, startTime: 'old', agentId: 'claude', issue: 5 } },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T11:00:00Z', // コメントより前
            seenIds: [900],
            deliveredIds: [900], // 既に配送済み
            pendingDeliveries: {},
          },
        },
      });

      const r = runMain(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      // seenIds にあるので検出自体されない
      assert.ok(!r.lines.some(l => l.includes('DETECTED')));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// エッジケース: カーソル型不一致
// ═══════════════════════════════════════════════════════════════════════════

describe('Cursor type safety', () => {
  test('since が文字列でない場合は null 扱い', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        cursors: {
          'issue-1-bad-since': { since: {}, seenIds: [], deliveredIds: [], pendingDeliveries: {} },
        },
      });
      const state = supervisor.readCursor(dir, 'issue-1-bad-since');
      assert.equal(state.since, null);
    });
  });

  test('seenIds/deliveredIds が配列でない場合は空配列', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        cursors: {
          'issue-1-bad-ids': { since: null, seenIds: 'not-an-array', deliveredIds: null, pendingDeliveries: {} },
        },
      });
      const state = supervisor.readCursor(dir, 'issue-1-bad-ids');
      assert.deepEqual(state.seenIds, []);
      assert.deepEqual(state.deliveredIds, []);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI integration: 実プロセス起動での動作確認
// ═══════════════════════════════════════════════════════════════════════════

const { spawnSync: realSpawnSync, spawn } = require('child_process');

const SUPERVISOR_SCRIPT = path.join(__dirname, '..', 'scripts', 'worker-supervisor.js');

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
  return realSpawnSync(process.execPath, [SUPERVISOR_SCRIPT, ...args, '--session-pid', String(process.pid)], {
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

  test('重複起動を検出して拒否する（既存の live role lease がある場合）', (t) => {
    const startTimeProbe = getProcessStartTime(process.pid);
    if (!startTimeProbe) {
      t.skip('この環境では getProcessStartTime が機能しないため、実プロセスでの同一性確認を検証できません');
      return;
    }
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      // 既存所有者の live lease を書く。pid は process.ppid を指定する（--force 無しなので
      // kill は走らないが、念のためテスト実行環境のプロセスを対象にしない）。
      writeLiveSupervisorLease(dir, process.ppid, getProcessStartTime(process.ppid));

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
        // 起動直後の子の startTime は WMI にまだ見えないことがあるため、取れるまで待つ
        let startTime = getProcessStartTime(owner.pid);
        for (let i = 0; !startTime && i < 20; i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          startTime = getProcessStartTime(owner.pid);
        }
        writeLiveSupervisorLease(dir, owner.pid, startTime);

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
        let startTime = getProcessStartTime(owner.pid);
        for (let i = 0; !startTime && i < 20; i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          startTime = getProcessStartTime(owner.pid);
        }
        writeLiveSupervisorLease(dir, owner.pid, startTime);

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
        let startTime = getProcessStartTime(owner.pid);
        for (let i = 0; !startTime && i < 20; i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          startTime = getProcessStartTime(owner.pid);
        }
        writeLiveSupervisorLease(dir, owner.pid, startTime);

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
