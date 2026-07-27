#!/usr/bin/env node
// inbox-supervisor.js — 全ワーカーのGitHub Issueインボックスを監視し、
// 新着メッセージを検出して各エージェントに配送する常駐プロセス
//
// Usage:
//   node inbox-supervisor.js --workspace <path> [--interval <sec>] [--session-pid <pid>]
//
// アーキテクチャ:
//   - 各ワーカーのIssueをポーリングし、自分宛ての新着コメントを検出する
//   - スキャンロジックは msg-poll.js の parseMarker / parseCommentsResponse を再利用
//   - カーソル・配送状態は .gh-maestro/inbox-supervisor/cursors/<workerName>.json に永続化
//   - 配送は Adapter 層（scripts/shared/inbox-adapters/）経由でエージェント種別に応じた方法で行う
//   - 稼働中のエージェントには一切書き込まず、休止するのを待って resume する
//   - 休止中のエージェントは pending キューに保持し、再開時に配送
//
// 信頼性:
//   - カーソル永続化（since + seenIds）による再起動後の継続
//   - 配送済みID管理による重複配送防止
//   - 配送失敗時の指数バックオフリトライ（最大5回）
//   - PID registry + dead-man's switch によるライフサイクル管理
//   - resume直後の生存確認（spawnの成功=プロセス生存し続けることではないため、短い猶予後に
//     PIDで再確認する。消えていればDELIVEREDにせずresume-failedとして扱う）
//   - リトライ断念時のorchestrator通知（stderrへのログだけでは誰も気づけないため、
//     msg-send.js経由でorchestratorのinboxに直接投稿する）
//
// 既存ポーリングとの関係:
//   - ワーカーの自己ポーリング（msg-poll.js Monitor経由）を置き換える
//   - orchestrator inbox監視（msg-poll.js orchestratorモード）とは独立（別の監視対象）
//   - poll-pr.js / poll-reviews.js とは監視対象が異なり競合しない

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags, hasHelpFlag } = require('./shared/workspace');
const { normalizeWorkerEntry } = require('./worker-entry');
const { resolveAgentConfig } = require('./shared/resolve-config');
const { resolveAdapter } = require('./shared/inbox-adapters');
const { buildAgentResumeCommandArgs } = require('./agent-launch');
const { launchAgentHeadless, workerLogPath } = require('./shared/headless-launch');
const { updateWorkerProcess } = require('./shared/workers-registry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const {
  resolveSessionPid,
  createDeadManSwitch,
  registerProcess,
  findRunningInstance,
  acquireStartupLock,
  releaseStartupLock,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');

// msg-poll.js のスキャンロジックを再利用
const { parseMarker, parseCommentsResponse } = require('./msg-poll');

// ── 定数 ──────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_SEC = 20;
const GH_TIMEOUT_MS = 30000;
const MAX_SEEN_IDS = 200;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 10000;

const USAGE = `inbox-supervisor.js — 全ワーカーのGitHub Issueインボックスを監視し新着メッセージを配送する

Usage: node inbox-supervisor.js --workspace <path> [--interval <sec>] [--session-pid <pid>] [--force] [--once]

Options:
  --workspace <path>     ワークスペースパス（必須）
  --interval <sec>       ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）
  --session-pid <pid>    監視対象のセッションPID（dead-man's switch用。省略時は自動検出）
  --force                既に同じworkspaceで稼働中のSupervisorがいても起動を強制する
  --once                 1回だけスキャンして終了する（継続ポーリングしない。テスト・手動実行用）

Output (stdout):
  検出・配送イベントを1行ずつ出力:
    SCAN_START
    DETECTED:<workerName>:<commentId>
    DELIVERED:<workerName>:<commentId>
    DELIVERY_FAILED:<workerName>:<commentId>:<reason>
    RETRYING:<workerName>:<commentId>:<attempt>
    SCAN_END:<workers>:<detected>

Description:
  workers.json に登録された全ワーカーのIssueを定期ポーリングし、
  各ワーカー宛ての新着メッセージを検出・配送する。
  カーソル・配送状態は .gh-maestro/inbox-supervisor/ に永続化され、
  プロセス再起動後も未配送メッセージを失わずに再開できる。
  ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
  消滅時はPID registryを解除して自動exitする。`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghApiComments = (repo, issue, since, opts = {}) => {
  const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'];
  if (since) {
    args.push('-f', `since=${since}`);
  }
  args.push('-f', 'per_page=100');
  return spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

// ── ワーカー生存確認（テストで注入可能） ──────────────────────────────────

let _isWorkerAlive = isWorkerAlive;

// resume直後の生存確認までの待機（テストで注入可能）。
let _sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// resume 直後にプロセスが即死していないかを確認するまでの猶予。
const RESUME_LIVENESS_GRACE_MS = 2000;

// 配送を断念した際に orchestrator へ通知する（テストで注入可能）。inbox-supervisor.js は
// ワーカーではないため GH_MAESTRO_WORKER は設定せず、--from/--issue を明示して投稿する。
let _notifyOrchestrator = ({ workspace, issue, body }) => {
  return spawnSync(process.execPath, [
    path.join(__dirname, 'msg-send.js'),
    'orchestrator', body,
    '--from', 'inbox-supervisor',
    '--issue', issue,
    '--workspace', workspace,
  ], { encoding: 'utf8' });
};

// ── 状態管理 ──────────────────────────────────────────────────────────────

/**
 * Supervisor の状態ディレクトリを返す。
 * @param {string} workspace
 * @returns {string}
 */
function stateDir(workspace) {
  return path.join(workspace, '.gh-maestro', 'inbox-supervisor');
}

/**
 * 特定ワーカーのカーソルファイルパスを返す。
 * @param {string} workspace
 * @param {string} workerName
 * @returns {string}
 */
function cursorPath(workspace, workerName) {
  return path.join(stateDir(workspace), 'cursors', `${workerName}.json`);
}

/**
 * ワーカーのカーソル状態を読み込む。
 * ファイルが無い・壊れている場合は初期状態を返す。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @returns {{ since: string|null, seenIds: number[], deliveredIds: number[], pendingDeliveries: object }}
 */
function readCursor(workspace, workerName) {
  const cp = cursorPath(workspace, workerName);
  try {
    if (!fs.existsSync(cp)) {
      return { since: null, seenIds: [], deliveredIds: [], pendingDeliveries: {} };
    }
    const raw = fs.readFileSync(cp, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      since: typeof parsed.since === 'string' ? parsed.since : null,
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
      deliveredIds: Array.isArray(parsed.deliveredIds) ? parsed.deliveredIds : [],
      pendingDeliveries:
        parsed.pendingDeliveries && typeof parsed.pendingDeliveries === 'object' && !Array.isArray(parsed.pendingDeliveries)
          ? parsed.pendingDeliveries : {},
    };
  } catch {
    return { since: null, seenIds: [], deliveredIds: [], pendingDeliveries: {} };
  }
}

/**
 * ワーカーのカーソル状態を永続化する。
 * アトミック書き込み（tmp → rename）で破損を防ぐ。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @param {object} state
 */
function writeCursor(workspace, workerName, state) {
  const cp = cursorPath(workspace, workerName);
  const dir = path.dirname(cp);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = cp + '.' + Math.random().toString(36).slice(2, 8);
  const seenIds = state.seenIds.slice(-MAX_SEEN_IDS);
  const deliveredIds = (state.deliveredIds || []).slice(-MAX_SEEN_IDS);
  fs.writeFileSync(tmp, JSON.stringify({
    since: state.since,
    seenIds,
    deliveredIds,
    pendingDeliveries: state.pendingDeliveries || {},
  }, null, 2), 'utf8');
  fs.renameSync(tmp, cp);
}

// ── workers.json 読み込み ─────────────────────────────────────────────────

/**
 * workers.json を読み込み、正規化されたワーカーエントリの Map を返す。
 * orchestrator エントリは除外する。
 *
 * @param {string} workspace
 * @returns {Map<string, { pid: number|null, startTime: string|null, agentId: string|null, issue: number|null }>}
 */
function loadWorkers(workspace) {
  const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
  const map = new Map();

  let raw;
  try {
    if (!fs.existsSync(workersPath)) return map;
    raw = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
  } catch {
    return map;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;

  for (const [name, entry] of Object.entries(raw)) {
    if (name === 'orchestrator') continue;
    const normalized = normalizeWorkerEntry(entry);
    map.set(name, normalized);
  }

  return map;
}

// ── 配送 ──────────────────────────────────────────────────────────────────
//
// 稼働中のプロセスへ外から入力を注入する経路は持たない。届いたかどうかを確認できない
// 不確実な手段であり、「起動基盤としてのみ使う」という設計原則にも反する。
// 配送は常にプロセスの起動/再開（resume。launchAgentHeadlessによるプロセス生成）
// のみを経路とする。稼働中（isWorkerAlive）のワーカーには一切書き込まず、
// 休止するのを待って次のスキャンサイクルでresumeする。

/**
 * 休止中（プロセス非生存）のセッション再開系ワーカーを resume() で復帰させ、メッセージを配送する。
 *
 * 全エージェントがセッション再開方式のため、configが解決できれば必ず resume を試みる。
 * config を解決できないエージェントだけ、呼び出し元が pending 扱いにフォールバックする
 * （method: 'pending' を返す）。
 *
 * @param {object} params
 * @param {string} params.workerName
 * @param {string|null} params.agentId
 * @param {object} params.message    - { from, body }
 * @param {string} params.workspace
 * @param {string} params.homedir
 * @returns {{ success: boolean, method: string, error?: string, newPaneId?: string }}
 */
function tryResumeAndDeliver({ workerName, agentId, message, workspace, homedir }) {
  let agentConfig;
  try {
    agentConfig = agentId ? resolveAgentConfig(agentId, { workspace, homedir }) : null;
  } catch {
    agentConfig = null;
  }
  if (!agentConfig) {
    return { success: false, method: 'pending', error: `agentId "${agentId}" のconfigを解決できません` };
  }
  const worktreeDir = path.join(workspace, '.gh-maestro', 'worktrees', workerName);
  if (!fs.existsSync(worktreeDir)) {
    return { success: false, method: 'resume-failed', error: `worktree ${worktreeDir} が存在しません（resume不可能）` };
  }

  let adapter;
  try {
    adapter = resolveAdapter(agentConfig);
  } catch (e) {
    return { success: false, method: 'resume-failed', error: `Adapter解決失敗: ${e.message}` };
  }

  let resumeResult;
  try {
    resumeResult = adapter.resume();
  } catch (e) {
    return { success: false, method: 'resume-failed', error: `resume()失敗: ${e.message}` };
  }

  let argv, afterLaunchText;
  try {
    ({ argv, afterLaunchText } = buildAgentResumeCommandArgs(agentConfig, resumeResult.args, {
      shortPrompt: message.body || '(本文なし)',
    }));
  } catch (e) {
    return { success: false, method: 'resume-failed', error: `resume起動argv構築失敗: ${e.message}` };
  }

  // send-text-after-launch は画面への入力注入が前提であり headless では実現できない。
  // 黙って本文抜きで起動するとワーカーが指示を受け取れないままGitHubに無関係な応答を
  // 投げうるため、フェイルクローズで配送を止める。
  if (afterLaunchText) {
    return {
      success: false,
      method: 'resume-failed',
      error: `エージェント "${agentConfig.id}" は send-text-after-launch 方式ですが、headless実行では本文を渡せません`,
    };
  }

  // resumeへの応答（msg-send.js経由でのGitHub投稿）が実際に届いたかを、worker-exit-hook.js が
  // 終了後に確認できるようにする。ワーカーの標準出力はログファイルへ直接リダイレクトされて
  // いるので、そのパスと「今回のresume分がどこから始まるか」のオフセットを渡す。
  // オフセットを渡さないと、今回の実行が何も出力せずに終わったとき、前回の実行の出力を
  // 今回の応答として代理送信してしまう。
  const logPath = workerLogPath(workspace, workerName);
  let logOffset = 0;
  try {
    logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  } catch {
    logOffset = 0;
  }
  const sinceTimestamp = new Date().toISOString();

  let launched;
  try {
    launched = launchAgentHeadless({
      argv,
      cwd: worktreeDir,
      logPath,
      // resume 時もワーカー識別を環境の事実として再注入する（初回起動と同じ。
      // これが無いと resume 後のワーカーが自分を識別できず msg-send.js を誤用しうる）。
      env: { GH_MAESTRO_WORKER: workerName, GH_MAESTRO_WORKSPACE: workspace },
      // resume 後の異常終了は orchestrator へ通知する（初回起動と同じ終了フック）。
      // 第3〜第5引数（log-path・since-timestamp・log-offset）は resume 応答の
      // 代理送信判定に使う（worker-exit-hook.js参照）。新規起動（spawn-worker.js）は
      // これらを渡さず、異常終了通知だけが働く。
      onExit: {
        command: process.execPath,
        args: [
          path.join(__dirname, 'worker-exit-hook.js'),
          workspace, '', logPath, sinceTimestamp, String(logOffset),
        ],
      },
    });
  } catch (e) {
    return { success: false, method: 'resume-failed', error: `プロセス起動失敗: ${e.message}` };
  }

  // spawn が pid を返したことは、起動先プロセスが生存し続けていることを保証しない
  // （実障害: resumeが成功と誤認識され、起動直後に消滅したワーカーが誰にも気づかれず
  // 放置された）。短い猶予を置いてから生存確認する。
  _sleep(RESUME_LIVENESS_GRACE_MS);
  if (!_isWorkerAlive({ pid: launched.pid, startTime: launched.startTime })) {
    return {
      success: false,
      method: 'resume-failed',
      error: `resume直後に pid ${launched.pid} が消失しました（起動直後のクラッシュの可能性）。ログ: ${logPath}`,
    };
  }

  if (!updateWorkerProcess(workspace, workerName, launched)) {
    return { success: false, method: 'resume-failed', error: `workers.json書き込み失敗（worker "${workerName}" が見つかりません）` };
  }

  return { success: true, method: 'resume', pid: launched.pid };
}

/**
 * メッセージをエージェントに配送する。
 *
 * 全エージェントがセッション再開方式である。
 * 稼働中（プロセス生存 = タスク処理中）のワーカーには一切書き込まず、休止するのを
 * 待って次のスキャンサイクルで resume() 経由で配送する。稼働中のプロセスへの
 * 入力注入は行わない（配送経路はプロセスの起動/再開のみ）。
 *
 * @param {object} params
 * @param {string} params.workerName
 * @param {object} params.entry      - workers.json のエントリ（生存確認に pid/startTime を使う）
 * @param {object} params.message    - { from, body }
 * @param {string} params.workspace
 * @param {string} params.homedir
 * @param {string} params.issue      - Issue 番号（文字列）
 * @returns {{ success: boolean, method: string, error?: string }}
 */
function deliverMessage({ workerName, entry, message, workspace, homedir, issue }) {
  if (_isWorkerAlive(entry)) {
    return {
      success: false,
      method: 'pending',
      error: `worker pid ${entry.pid} is alive (worker busy) — waiting for it to become idle for resume delivery`,
    };
  }

  const resumeResult = tryResumeAndDeliver({ workerName, agentId: entry.agentId, message, workspace, homedir });
  if (resumeResult.method !== 'pending') {
    // resumeを試みた結果（成功 or 明確な失敗）。既存のpendingDeliveries/バックオフ機構にそのまま乗る。
    return resumeResult;
  }

  return {
    success: false,
    method: 'pending',
    error: `worker process (pid ${entry.pid || 'none'}) is not alive — queued for resume`,
  };
}

// ── 再試行判定 ────────────────────────────────────────────────────────────

/**
 * pending エントリが再試行可能か判定する。
 * 指数バックオフ: RETRY_BASE_DELAY_MS * 2^(retries-1)（MAX_RETRIES到達分で頭打ち）
 *
 * lastMethod === 'pending'（相手のプロセスが稼働中＝作業中で、resumeを試みる前に見送った状態。
 * deliverMessage() 参照）はMAX_RETRIESの対象外とする。これは配送の失敗ではなく、
 * 相手が休止するのを待っているだけの正常な状態であり、回数で恒久的に諦めてはならない
 * （実障害: busyのまま5回を消費し、その後ワーカーが休止してもメッセージが永久に
 * 再試行されなくなっていた）。真の失敗（lastMethod === 'resume-failed'等）のみ、
 * 従来通りMAX_RETRIES到達で諦める。
 *
 * @param {object} pendingEntry  - { retries: number, lastAttempt: string, lastError: string, lastMethod?: string }
 * @param {number} nowMs         - 現在時刻（Unix ms）
 * @returns {boolean}
 */
function shouldRetry(pendingEntry, nowMs) {
  if (!pendingEntry || typeof pendingEntry.retries !== 'number') return true;

  // lastMethod未設定の既存cursorエントリ（この修正より前に書かれたもの）は、
  // lastError文言からdeliverMessage()の'pending'系エラーだったかを推定する
  // （後方互換: 修正前にMAX_RETRIESを使い切って恒久停止していたエントリも救済する）。
  const isAwaitingIdle = pendingEntry.lastMethod === 'pending'
    || (typeof pendingEntry.lastError === 'string'
        && (pendingEntry.lastError.includes('idle for resume delivery') || pendingEntry.lastError.includes('queued for resume')));
  if (!isAwaitingIdle && pendingEntry.retries >= MAX_RETRIES) return false;

  const lastAttempt = pendingEntry.lastAttempt
    ? new Date(pendingEntry.lastAttempt).getTime()
    : 0;

  if (Number.isNaN(lastAttempt) || lastAttempt <= 0) return true;

  // backoffの指数はMAX_RETRIES相当で頭打ちにする。isAwaitingIdleはretriesが際限なく
  // 増え続けうるため、キャップしないと待機間隔が指数的に膨れ上がってしまう。
  const backoffExponent = Math.min(pendingEntry.retries, MAX_RETRIES) - 1;
  const delay = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, backoffExponent));
  return (nowMs - lastAttempt) >= delay;
}

// ── メインロジック ────────────────────────────────────────────────────────

/**
 * 引数バリデーションと初期化を行い、poll 実行に必要なオブジェクトを返す。
 *
 * @param {string[]} [argsOverride]  省略時は process.argv.slice(2)
 * @param {{ streamOutput?: boolean }} [opts]
 * @returns {{
 *   code: number, lines: string[], errLines: string[],
 *   runOnce: (() => void) | null,
 *   onceMode: boolean,
 *   intervalMs: number,
 *   workspace: string,
 * }}
 */
function main(argsOverride, opts = {}) {
  const { streamOutput = false } = opts;
  const out = [];
  const err = [];

  const writeOut = (s) => {
    out.push(s);
    if (streamOutput) process.stdout.write(s + '\n');
  };
  const writeErr = (s) => {
    err.push(s);
    if (streamOutput) process.stderr.write(s + '\n');
  };

  const args = argsOverride || process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--interval', '--session-pid']);

  if (exitFlagMiss) {
    writeErr('inbox-supervisor: フラグには値が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, runOnce: null, intervalMs: 0, workspace: '' };
  }

  const onceMode = rest.includes('--once');
  const filteredRest = rest.filter(a => a !== '--once');

  if (filteredRest.length > 0) {
    writeErr(`inbox-supervisor: 未知の引数です: ${filteredRest.join(' ')}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('inbox-supervisor: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  const intervalMs = (parseInt(values['--interval'] || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;
  const sessionPid = resolveSessionPid(values['--session-pid']);
  const checkParent = createDeadManSwitch(sessionPid);

  // リポジトリ解決
  const ghOpts = { cwd: workspace };
  const repoResult = _ghRepoView(ghOpts);
  if (repoResult.status !== 0) {
    writeErr(`inbox-supervisor: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }
  const repo = repoResult.stdout.trim();
  if (!repo) {
    writeErr('inbox-supervisor: リポジトリを解決できません（空のレスポンス）。');
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  // ホームディレクトリ（エージェント設定解決用）
  const homedir = process.env.HOME || process.env.USERPROFILE || '';

  /**
   * 1回のポーリングサイクル。
   * 全ワーカーをスキャンし、新着メッセージの検出・配送を行う。
   */
  function runOnce() {
    if (!checkParent()) {
      lifecycleCleanup(workspace);
      process.stderr.write(`inbox-supervisor: parent session (pid ${sessionPid}) is dead — exiting\n`);
      process.exit(0);
    }

    writeOut('SCAN_START');

    const workers = loadWorkers(workspace);
    let totalDetected = 0;

    for (const [workerName, entry] of workers) {
      if (!entry.issue) continue;

      const issue = String(entry.issue);
      const cursor = readCursor(workspace, workerName);

      // ── pending 再試行 ───────────────────────────────────────────────
      const nowMs = Date.now();
      const pendingEntries = Object.entries(cursor.pendingDeliveries || {});
      for (const [commentIdStr, pending] of pendingEntries) {
        const commentId = parseInt(commentIdStr, 10);
        if (!Number.isFinite(commentId)) {
          delete cursor.pendingDeliveries[commentIdStr];
          continue;
        }

        if (!shouldRetry(pending, nowMs)) continue;

        writeOut(`RETRYING:${workerName}:${commentId}:${pending.retries + 1}`);

        // メッセージ本文を再取得（pending 時に lastBody が保存されなかった古いエントリ対策）
        let messageBody = pending.lastBody || '';
        if (!messageBody) {
          const bodyResult = _ghApiComments(repo, issue, null, { cwd: workspace });
          if (bodyResult.status === 0) {
            try {
              const bodyComments = parseCommentsResponse(bodyResult.stdout);
              if (bodyComments) {
                const target = bodyComments.find(c => c.id === commentId);
                if (target && target.body) {
                  messageBody = target.body;
                  cursor.pendingDeliveries[commentIdStr].lastBody = target.body;
                }
              }
            } catch {
              // body 再取得の parse 失敗 → 空で続行
            }
          }
        }

        const deliveryResult = deliverMessage({
          workerName,
          entry,
          message: { from: pending.lastFrom || '(unknown)', body: messageBody },
          workspace,
          homedir,
          issue,
        });

        if (deliveryResult.success) {
          cursor.deliveredIds.push(commentId);
          delete cursor.pendingDeliveries[commentIdStr];
          writeOut(`DELIVERED:${workerName}:${commentId}`);
        } else {
          cursor.pendingDeliveries[commentIdStr] = {
            retries: pending.retries + 1,
            lastAttempt: new Date().toISOString(),
            lastError: deliveryResult.error || 'unknown',
            lastMethod: deliveryResult.method,
            lastFrom: pending.lastFrom,
            lastBody: pending.lastBody,
          };
          writeOut(`DELIVERY_FAILED:${workerName}:${commentId}:${deliveryResult.error || 'unknown'}`);

          if (deliveryResult.method !== 'pending' && pending.retries + 1 >= MAX_RETRIES) {
            writeErr(`inbox-supervisor: ${workerName} comment ${commentId} — max retries (${MAX_RETRIES}) exceeded, giving up`);
            // 断念を stderr に書くだけでは誰も読まない（detachedプロセスのstderrは通常誰も
            // 監視していない）。orchestrator自身のinboxに投稿し、確実に気づけるようにする。
            const giveUpBody = `⚠️ ワーカー "${workerName}" へのメッセージ配送に${MAX_RETRIES}回失敗し断念しました（comment ${commentId}）。最後のエラー: ${deliveryResult.error || 'unknown'}。ワーカーが応答不能になっている可能性があります。状態を確認し、必要なら再起動を検討してください。`;
            try {
              const notifyResult = _notifyOrchestrator({ workspace, issue, body: giveUpBody });
              if (notifyResult.status !== 0) {
                writeErr(`inbox-supervisor: 配送断念のorchestrator通知に失敗: ${(notifyResult.stderr || '').trim()}`);
              }
            } catch (e) {
              writeErr(`inbox-supervisor: 配送断念のorchestrator通知に失敗: ${e.message}`);
            }
          }
        }
      }

      // ── 新着コメントのスキャン ─────────────────────────────────────
      // カーソルが無い初回は since を指定せず全件取得（seenIds で重複防止）
      const workerSince = cursor.since || null;
      const apiResult = _ghApiComments(repo, issue, workerSince, { cwd: workspace });

      if (apiResult.status !== 0) {
        writeErr(`inbox-supervisor: gh api エラー (worker ${workerName}, issue ${issue}): ${apiResult.stderr || apiResult.error?.message || '(empty)'}`);
        continue;
      }

      let comments;
      try {
        comments = parseCommentsResponse(apiResult.stdout);
      } catch {
        writeErr(`inbox-supervisor: JSON parse エラー (worker ${workerName}, issue ${issue})`);
        continue;
      }
      if (comments === null) {
        writeErr(`inbox-supervisor: gh api の応答が配列ではありません (worker ${workerName}, issue ${issue})`);
        continue;
      }

      // ── 新着候補の抽出 ─────────────────────────────────────────────
      const candidates = [];
      let maxCreated = workerSince;

      for (const c of comments) {
        const cid = c.id;
        if (cid == null) continue;
        if (!c.created_at) continue;

        // 未処理のコメントか
        if (cursor.seenIds.includes(cid)) continue;

        // このワーカー宛てか
        const meta = parseMarker(c.body);
        if (!meta) continue;
        if (meta.to !== workerName) continue;

        candidates.push({
          cid,
          created_at: c.created_at,
          from: meta.from || '(unknown)',
          body: c.body || '',
        });

        // カーソル追跡用
        if (!maxCreated || c.created_at > maxCreated) {
          maxCreated = c.created_at;
        }
      }

      // カーソルを進める（全コメントの最大 created_at まで）
      for (const c of comments) {
        if (!c.created_at) continue;
        if (!maxCreated || c.created_at > maxCreated) {
          maxCreated = c.created_at;
        }
      }

      // ── 配送 ───────────────────────────────────────────────────────
      for (const candidate of candidates) {
        totalDetected++;
        writeOut(`DETECTED:${workerName}:${candidate.cid}`);

        // 配送前に deliveredIds をチェック（重複防止）
        if (cursor.deliveredIds.includes(candidate.cid)) {
          cursor.seenIds.push(candidate.cid);
          continue;
        }

        const deliveryResult = deliverMessage({
          workerName,
          entry,
          message: { from: candidate.from, body: candidate.body },
          workspace,
          homedir,
          issue,
        });

        cursor.seenIds.push(candidate.cid);

        if (deliveryResult.success) {
          cursor.deliveredIds.push(candidate.cid);
          writeOut(`DELIVERED:${workerName}:${candidate.cid}`);
        } else {
          // 配送失敗 → pending に記録
          cursor.pendingDeliveries[String(candidate.cid)] = {
            retries: 1,
            lastAttempt: new Date().toISOString(),
            lastError: deliveryResult.error || 'unknown',
            lastMethod: deliveryResult.method,
            lastFrom: candidate.from,
            lastBody: candidate.body,
          };
          writeOut(`DELIVERY_FAILED:${workerName}:${candidate.cid}:${deliveryResult.error || 'unknown'}`);
        }
      }

      // ── カーソルを進める ──────────────────────────────────────────
      // candidates がいても既に配送済み（または配送失敗）の場合はカーソルを進める。
      // msg-poll.js と同様、since の境界に関する仮定を置かず seenIds で重複防止する。
      if (maxCreated && maxCreated !== workerSince) {
        cursor.since = maxCreated;
      }

      // trimmed
      cursor.seenIds = cursor.seenIds.slice(-MAX_SEEN_IDS);
      cursor.deliveredIds = cursor.deliveredIds.slice(-MAX_SEEN_IDS);

      writeCursor(workspace, workerName, cursor);
    }

    writeOut(`SCAN_END:${workers.size}:${totalDetected}`);
  }

  return {
    code: 0,
    lines: out,
    errLines: err,
    runOnce,
    onceMode,
    intervalMs,
    workspace,
    sessionPid,
  };
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const { values: preValues, exitFlagMiss: preExitFlagMiss } = parseFlags(rawArgs, ['--workspace', '--interval', '--session-pid']);

  if (preExitFlagMiss) {
    process.stderr.write('inbox-supervisor: フラグには値が必要です。\n');
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const force = rawArgs.includes('--force');
  const onceMode = rawArgs.includes('--once');

  // ── 単一起動ロック + 多重起動検知 ──────────────────────────────────
  if (!force) {
    const preWorkspace = resolveWorkspace(preValues['--workspace']);
    if (preWorkspace) {
      if (!acquireStartupLock(preWorkspace, 'inbox-supervisor.js', null)) {
        process.stderr.write(
          'inbox-supervisor: 別のプロセスが同じworkspaceのSupervisor起動処理中です。' +
          '少し待ってから再試行してください。\n'
        );
        process.exit(1);
      }

      const dup = findRunningInstance(preWorkspace, { script: 'inbox-supervisor.js', workerName: null });
      if (dup) {
        releaseStartupLock(preWorkspace, 'inbox-supervisor.js', null);
        process.stderr.write(
          `inbox-supervisor: 重複起動を検出しました。既に pid=${dup.pid} が同じworkspaceを監視中です。` +
          '強制的に起動する場合は --force を指定してください。\n'
        );
        process.exit(1);
      }
    }
  }

  const result = main(undefined, { streamOutput: true });

  for (const l of result.errLines) process.stderr.write(l + '\n');

  if (result.code !== 0) {
    if (!force) {
      const preWorkspace = resolveWorkspace(preValues['--workspace']);
      if (preWorkspace) releaseStartupLock(preWorkspace, 'inbox-supervisor.js', null);
    }
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(result.code);
  }

  if (result.runOnce === null) {
    // --help
    if (!force) {
      const preWorkspace = resolveWorkspace(preValues['--workspace']);
      if (preWorkspace) releaseStartupLock(preWorkspace, 'inbox-supervisor.js', null);
    }
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  // PID registry に自己登録
  registerProcess(result.workspace, { script: 'inbox-supervisor.js' });

  // registry への登録が完了したので単一起動ロックを解放
  if (!force) {
    const preWorkspace = resolveWorkspace(preValues['--workspace']);
    if (preWorkspace) releaseStartupLock(preWorkspace, 'inbox-supervisor.js', null);
  }

  const ru = result.runOnce;

  function cleanup() {
    lifecycleCleanup(result.workspace);
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  if (result.onceMode) {
    // --once: 1回だけスキャンして終了
    ru();
    cleanup();
  } else {
    // 継続モード: 初回スキャンを即実行し、以降 intervalMs 間隔で継続
    ru();
    setInterval(ru, result.intervalMs);
  }
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhApiComments: (fn) => { _ghApiComments = fn; },
  _setIsWorkerAlive: (fn) => { _isWorkerAlive = fn; },
  _setSleep: (fn) => { _sleep = fn; },
  _setNotifyOrchestrator: (fn) => { _notifyOrchestrator = fn; },
  main,
  readCursor,
  writeCursor,
  cursorPath,
  stateDir,
  loadWorkers,
  tryResumeAndDeliver,
  deliverMessage,
  shouldRetry,
  USAGE,
};
