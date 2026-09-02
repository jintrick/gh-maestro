#!/usr/bin/env node
// worker-supervisor.js — 全ワーカーのGitHub Issueインボックスを監視し、
// 新着メッセージを検出して各エージェントに配送する常駐プロセス
//
// Usage:
//   node worker-supervisor.js --workspace <path> [--interval <sec>] [--session-pid <pid>]
//
// アーキテクチャ:
//   - 各ワーカーのIssueをポーリングし、自分宛ての新着コメントを検出する
//   - スキャンロジックは msg-poll.js の parseMarker / parseCommentsResponse を再利用
//   - カーソルは .gh-maestro/records/<owner>/<id>/workers/<worker>/cursor.json に永続化
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
//     resident-audit経由でorchestratorの監視へ届ける）
//   - 未報告のまま居座るワーカーの通知（Issue #263。ワーカーが直近の起動以降に既に報告を
//     投稿しているのにプロセスが生存し続けている異常を、経過時間ではなく報告コメントの
//     有無で検知しorchestratorへ通知する。msg-send.js側の追伸拒否ガードと対になる）
//
// 既存ポーリングとの関係:
//   - ワーカーの自己ポーリング（msg-poll.js Monitor経由）を置き換える
//   - orchestrator inbox監視（msg-poll.js orchestratorモード）とは独立（別の監視対象）
//   - poll-pr.js / poll-reviews.js とは監視対象が異なり競合しない

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./shared/child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { normalizeWorkerEntry } = require('./shared/worker-entry');
const { resolveAgentConfig } = require('./shared/resolve-config');
const { resolveAdapter } = require('./shared/inbox-adapters');
const { buildAgentResumeCommandArgs } = require('./shared/agent-launch');
const { launchAgentHeadless, workerLogPath } = require('./shared/headless-launch');
const { buildWorkerEnv } = require('./shared/worker-env');
const { updateWorkerProcess } = require('./shared/workers-registry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const {
  resolveSessionPid,
  createDeadManSwitch,
  getProcessStartTime,
  registerProcess,
  findRunningInstance,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');
const { acquireResidentLease, WORKER_SUPERVISOR_ROLE } = require('./shared/worker-lease');
const { notifyWatchdogExit, PARENT_DEATH_EXIT_CODE } = require('./shared/watchdog-exit-notify');
const { recordResidentNotification } = require('./shared/resident-audit');
const { handleParentSessionDeath } = require('./shared/resident-parent-death');
const { checkResidentForceGuard } = require('./shared/resident-force-guard');
const { runningLegacyWorkerSupervisorPids } = require('./shared/worker-supervisor-control');

// テスト注入。既定は実装。
let _createDeadManSwitch = createDeadManSwitch;
let _parentDeathExit = (code) => process.exit(code);
let _injectedGetProcessStartTime;

function _getProcessStartTime(pid) {
  const fn = _injectedGetProcessStartTime ?? getProcessStartTime;
  return fn(pid);
}

const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
// msg-poll.js のスキャンロジックを再利用（マーカーパースのみ）
const { parseMarker } = require('./msg-poll');
const {
  getReportStatusSinceStart,
  formatElapsedTime,
} = require('./shared/worker-report-check');
const { atomicWriteJson } = require('./shared/atomic-write');
const { readContract, clearContract } = require('./shared/response-contract');
const { createWriteFailureMonitor } = require('./shared/write-failure-warning');
const closedPrGuard = require('./shared/closed-pr-guard');
const { ARTIFACTS, legacyWorkerOwner, recordPath, recordRoot } = require('./shared/record-paths');

// ── 定数 ──────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_SEC = 20;
const GH_TIMEOUT_MS = 30000;
const MAX_SEEN_IDS = 200;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 10000;
const DEFAULT_HANG_THRESHOLD_MS = 20 * 60 * 1000; // 20分
const STALE_REPORT_GRACE_MS = 10 * 1000;

const USAGE = `worker-supervisor.js — 全ワーカーのGitHub Issueインボックスを監視し新着メッセージを配送する

Usage: node worker-supervisor.js --workspace <path> [--interval <sec>] [--session-pid <pid>] [--force] [--once]

Options:
  --workspace <path>     ワークスペースパス（必須）
  --interval <sec>       ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）
  --hang-threshold-sec <sec>
                         ハング判定の閾値（秒、ログ更新がこの時間以上止まったら通知。既定: 1200=20分）
  --session-pid <pid>    監視対象のセッションPID（dead-man's switch用。省略時は自動検出）
  --force                既に同じworkspaceで稼働中のSupervisorがいても、既存プロセスへ停止要求を
                          送ってから起動する（role lease の判定を無効化せず、引き継げなければ
                          exit 1 する。既定では多重起動を検知して exit 1 する）
  --once                 1回だけスキャンして終了する（継続ポーリングしない。テスト・手動実行用）

Output (stdout):
  検出・配送イベントを1行ずつ出力:
    SCAN_START source=worker-supervisor.js scope=worker-delivery-scan orchestrator-inbox=separate-msg-poll.js
    DETECTED:<workerName>:<commentId>
    DELIVERED:<workerName>:<commentId>
    DELIVERY_FAILED:<workerName>:<commentId>:<reason>
    RETRYING:<workerName>:<commentId>:<attempt>
    HANG_DETECTED:<workerName>:<pid> elapsed=<duration>
    HANG_RESUMED:<workerName>:<pid>
    STALE_REPORT_DETECTED:<workerName>:<pid> elapsed=<duration>
    STOP_DETECTED:<workerName>:<pid>
    SCAN_END:<workers>:<detected> source=worker-supervisor.js scope=worker-delivery-scan workers=<workers> detected=<detected> orchestrator-inbox=separate-msg-poll.js

Description:
  workers.json に登録された全ワーカーのIssueを定期ポーリングし、
  各ワーカー宛ての新着メッセージを検出・配送する。
  カーソル・配送状態は .gh-maestro/records/ 配下に永続化され、
  プロセス再起動後も未配送メッセージを失わずに再開できる。旧配置からの移行は
  migrate-records.js が単一の責務として扱う。
  ハング検知: ワーカーのログファイル更新（ただし現在のプロセスの起動時刻より前の
    更新は基準にしない）が一定時間（--hang-threshold-sec）以上止まっている場合、
    HANG_DETECTEDを出力しorchestratorへ通知する。その後、通知した本人（同一PID+
    起動時刻）が復帰した場合のみHANG_RESUMEDを出力する。同一プロセス（PID+起動時刻）
    への重複通知は防止される（PID再利用や新プロセスへの切り替わりによる誤抑止・
    誤った復帰報告を避けるため起動時刻も照合する）。
  居座り検知: ワーカーが自分の直近の起動以降に既に報告を投稿済みで、報告から10秒以上経過してもプロセスが生存し続けている場合、STALE_REPORT_DETECTEDを出力しorchestratorへ通知する（ハング検知とは独立）。同一プロセス（PID+起動時刻）への重複通知は防止される（PID再利用による誤抑止を避けるため起動時刻も照合する）。
  停止検知: workers.json に登録されたワーカーのプロセスが生存していないことを検知した場合、STOP_DETECTEDを出力しorchestratorへ通知する。通知本文には hasReportedSinceStart による報告状況（報告済み/未投稿）が明記される。同一プロセス（PID+起動時刻）への重複通知は防止される。プロセスの停止・再起動・削除等の自動介入は行わない。
  ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
  消滅時はPID registryを解除して自動exitする。`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghApiComments = (repo, issue, since, opts = {}) => {
  const callOpts = { ...opts, per_page: 100 };
  if (since) callOpts.since = since;
  return listComments(repo, issue, callOpts);
};

// ── ワーカー生存確認（テストで注入可能） ──────────────────────────────────

let _isWorkerAlive = isWorkerAlive;

// resume直後の生存確認までの待機（テストで注入可能）。
let _sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// resume 直後にプロセスが即死していないかを確認するまでの猶予。
const RESUME_LIVENESS_GRACE_MS = 2000;

// 配送を断念した際に orchestrator へ通知する（テストで注入可能）。worker-supervisor.js は
// ワーカーではないため GH_MAESTRO_WORKER は設定せず、--from/--issue を明示して投稿する。
// msg-send.js は本文を位置引数で受け付けない（--stdin / --body-file のみ）ため、
// spawnSync の input で stdin 経由に渡す。
// 非ワーカーコンテキストの msg-send.js は宛先を位置引数（recipient）で受け取る。
// 省略すると recipient が undefined になり usage エラーで必ず送信失敗する（PR #251 レビュー指摘）。
let _notifyOrchestrator = ({ workspace, issue, body }) => {
  recordResidentNotification({ workspace, source: 'worker-supervisor', issue, body });
  return { status: 0, stdout: '', stderr: '' };
};

// ── 状態管理 ──────────────────────────────────────────────────────────────

/**
 * Supervisor の状態ディレクトリを返す。
 * @param {string} workspace
 * @returns {string}
 */
function stateDir(workspace) {
  return recordRoot(workspace);
}

/**
 * 特定ワーカーのカーソルファイルパスを返す。
 * @param {string} workspace
 * @param {string} workerName
 * @returns {string}
 */
function cursorPath(workspace, workerName) {
  const owner = legacyWorkerOwner(workerName);
  return recordPath(workspace, { ...owner, artifact: ARTIFACTS.CURSOR });
}

/**
 * ワーカーのカーソル状態を読み込む。
 * ファイルが無い・壊れている場合は初期状態を返す。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @returns {{ since: string|null, seenIds: number[], deliveredIds: number[], pendingDeliveries: object, hangNotifiedPid: number|null, hangNotifiedStartTime: string|null, hangNotifiedAt: string|null, staleReportPendingPid: number|null, staleReportPendingStartTime: string|null, staleReportPendingCreatedAt: string|null, staleReportNotifiedPid: number|null, staleReportNotifiedStartTime: string|null, staleReportNotifiedAt: string|null, stoppedNotifiedPid: number|null, stoppedNotifiedStartTime: string|null, stoppedNotifiedAt: string|null, reportedPid: number|null, reportedStartTime: string|null, reportedCreatedAt: string|null }}
 */
function readCursor(workspace, workerName) {
  const cp = cursorPath(workspace, workerName);
  try {
    if (!fs.existsSync(cp)) {
      return {
        since: null, seenIds: [], deliveredIds: [], pendingDeliveries: {},
        hangNotifiedPid: null, hangNotifiedStartTime: null, hangNotifiedAt: null,
        staleReportPendingPid: null, staleReportPendingStartTime: null, staleReportPendingCreatedAt: null,
        staleReportNotifiedPid: null, staleReportNotifiedStartTime: null, staleReportNotifiedAt: null,
        stoppedNotifiedPid: null, stoppedNotifiedStartTime: null, stoppedNotifiedAt: null,
        reportedPid: null, reportedStartTime: null, reportedCreatedAt: null,
      };
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
      hangNotifiedPid: typeof parsed.hangNotifiedPid === 'number' ? parsed.hangNotifiedPid : null,
      hangNotifiedStartTime: typeof parsed.hangNotifiedStartTime === 'string' ? parsed.hangNotifiedStartTime : null,
      hangNotifiedAt: typeof parsed.hangNotifiedAt === 'string' ? parsed.hangNotifiedAt : null,
      staleReportPendingPid: typeof parsed.staleReportPendingPid === 'number' ? parsed.staleReportPendingPid : null,
      staleReportPendingStartTime: typeof parsed.staleReportPendingStartTime === 'string' ? parsed.staleReportPendingStartTime : null,
      staleReportPendingCreatedAt: typeof parsed.staleReportPendingCreatedAt === 'string' ? parsed.staleReportPendingCreatedAt : null,
      staleReportNotifiedPid: typeof parsed.staleReportNotifiedPid === 'number' ? parsed.staleReportNotifiedPid : null,
      staleReportNotifiedStartTime: typeof parsed.staleReportNotifiedStartTime === 'string' ? parsed.staleReportNotifiedStartTime : null,
      staleReportNotifiedAt: typeof parsed.staleReportNotifiedAt === 'string' ? parsed.staleReportNotifiedAt : null,
      stoppedNotifiedPid: typeof parsed.stoppedNotifiedPid === 'number' ? parsed.stoppedNotifiedPid : null,
      stoppedNotifiedStartTime: typeof parsed.stoppedNotifiedStartTime === 'string' ? parsed.stoppedNotifiedStartTime : null,
      stoppedNotifiedAt: typeof parsed.stoppedNotifiedAt === 'string' ? parsed.stoppedNotifiedAt : null,
      reportedPid: typeof parsed.reportedPid === 'number' ? parsed.reportedPid : null,
      reportedStartTime: typeof parsed.reportedStartTime === 'string' ? parsed.reportedStartTime : null,
      reportedCreatedAt: typeof parsed.reportedCreatedAt === 'string' ? parsed.reportedCreatedAt : null,
    };
  } catch {
    return {
      since: null, seenIds: [], deliveredIds: [], pendingDeliveries: {},
      hangNotifiedPid: null, hangNotifiedStartTime: null, hangNotifiedAt: null,
      staleReportPendingPid: null, staleReportPendingStartTime: null, staleReportPendingCreatedAt: null,
      staleReportNotifiedPid: null, staleReportNotifiedStartTime: null, staleReportNotifiedAt: null,
      stoppedNotifiedPid: null, stoppedNotifiedStartTime: null, stoppedNotifiedAt: null,
      reportedPid: null, reportedStartTime: null, reportedCreatedAt: null,
    };
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
  const seenIds = state.seenIds.slice(-MAX_SEEN_IDS);
  const deliveredIds = (state.deliveredIds || []).slice(-MAX_SEEN_IDS);
  atomicWriteJson(cp, {
    since: state.since,
    seenIds,
    deliveredIds,
    pendingDeliveries: state.pendingDeliveries || {},
    hangNotifiedPid: typeof state.hangNotifiedPid === 'number' ? state.hangNotifiedPid : null,
    hangNotifiedStartTime: typeof state.hangNotifiedStartTime === 'string' ? state.hangNotifiedStartTime : null,
    hangNotifiedAt: typeof state.hangNotifiedAt === 'string' ? state.hangNotifiedAt : null,
    staleReportPendingPid: typeof state.staleReportPendingPid === 'number' ? state.staleReportPendingPid : null,
    staleReportPendingStartTime: typeof state.staleReportPendingStartTime === 'string' ? state.staleReportPendingStartTime : null,
    staleReportPendingCreatedAt: typeof state.staleReportPendingCreatedAt === 'string' ? state.staleReportPendingCreatedAt : null,
    staleReportNotifiedPid: typeof state.staleReportNotifiedPid === 'number' ? state.staleReportNotifiedPid : null,
    staleReportNotifiedStartTime: typeof state.staleReportNotifiedStartTime === 'string' ? state.staleReportNotifiedStartTime : null,
    staleReportNotifiedAt: typeof state.staleReportNotifiedAt === 'string' ? state.staleReportNotifiedAt : null,
    stoppedNotifiedPid: typeof state.stoppedNotifiedPid === 'number' ? state.stoppedNotifiedPid : null,
    stoppedNotifiedStartTime: typeof state.stoppedNotifiedStartTime === 'string' ? state.stoppedNotifiedStartTime : null,
    stoppedNotifiedAt: typeof state.stoppedNotifiedAt === 'string' ? state.stoppedNotifiedAt : null,
    reportedPid: typeof state.reportedPid === 'number' ? state.reportedPid : null,
    reportedStartTime: typeof state.reportedStartTime === 'string' ? state.reportedStartTime : null,
    reportedCreatedAt: typeof state.reportedCreatedAt === 'string' ? state.reportedCreatedAt : null,
  });
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
 * config を解決できないエージェントは method: 'config-unresolvable' を返す
 * （恒久的失敗であり'pending'＝相手が稼働中で順番待ちとは区別する。Issue #173）。
 *
 * @param {object} params
 * @param {string} params.workerName
 * @param {string|null} params.agentId
 * @param {object} params.message    - { from, body }
 * @param {string} params.workspace
 * @param {string} params.homedir
 * @param {string} [params.repo] - main() が解決済みのリポジトリ名
 * @param {string|null} params.baseBranch - workers.json に永続化されたこのワーカーのPRベースブランチ。
 *   初回起動（spawn-worker.js）が登録し、resume 時に GH_MAESTRO_BASE_BRANCH として再注入する
 *   （Issue #269）。レガシーレコードでは null。
 * @returns {{ success: boolean, method: string, error?: string, newPaneId?: string }}
 */
function tryResumeAndDeliver({ workerName, agentId, message, workspace, homedir, baseBranch, repo }) {
  let agentConfig;
  try {
    agentConfig = agentId ? resolveAgentConfig(agentId, { workspace, homedir }) : null;
  } catch {
    agentConfig = null;
  }
  if (!agentConfig) {
    // config解決の恒久的失敗は'pending'（相手が稼働中で順番待ち＝正常）と区別する。
    // 'pending'のままだとshouldRetry()のisAwaitingIdleがtrueになり無限リトライ＋通知未発火になる。
    return { success: false, method: 'config-unresolvable', error: `agentId "${agentId}" のconfigを解決できません` };
  }

  if (repo) {
    const closedPr = closedPrGuard.checkClosedPr({ repo, branch: workerName, cwd: workspace });
    if (closedPr.blocked) {
      const detail = closedPr.number
        ? `ブランチ "${workerName}" にはクローズ済みPR #${closedPr.number} があります。`
        : `ブランチ "${workerName}" のPR状態を確認できませんでした。`;
      return { success: false, method: 'resume-failed', error: `${detail} ${closedPr.reason || ''}`.trim() };
    }
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

  // ── 応答契約の読み取り ──────────────────────────────────────────────────
  // orchestrator が set-response-contract.js で設定した契約があれば読み取り、
  // sinceTimestamp を注入した完全なspecをJSON文字列で onExit args 第7引数に追加する。
  // 契約のクリアは、配送試行が確定的な終着点に達したときだけ行う:
  //   - 生存確認まで成功（本関数末尾）
  //   - 5回のリトライを尽くした配送断念（runOnce の pending 再試行パス）
  // リトライ中（一時的な失敗でバックオフ中）は契約をそのまま残す。
  const contract = _readContract(workspace, workerName);
  let contractArg = '';
  if (contract && contract.type === 'artifact-or-message') {
    contractArg = JSON.stringify({ ...contract, sinceTimestamp });
  }

  let launched;
  try {
    launched = launchAgentHeadless({
      argv,
      cwd: worktreeDir,
      logPath,
      // resume 時もワーカー識別・ベースブランチを環境の事実として再注入する
      // （初回起動と同じ scripts/shared/worker-env.js。これが無いと resume 後のワーカーが
      // 自分を識別できず msg-send.js を誤用しうる）。GH_MAESTRO_BASE_BRANCH は初回起動時に
      // workers.json へ永続化した値を引く（Issue #269）。レガシーレコード（baseBranch null）は
      // 注入されず、後段の gh-create-pr.js がフェイルクローズする。
      env: buildWorkerEnv({ workerName, workspace, baseBranch }),
      // resume 後の異常終了は orchestrator へ通知する（初回起動と同じ終了フック）。
      // 第3〜第6引数（log-path・since-timestamp・log-offset）は resume 応答の
      // 代理送信判定に使う（worker-exit-hook.js参照）。新規起動（spawn-worker.js）は
      // これらを渡さず、異常終了通知だけが働く。
      // 第7引数 contractArg: 応答契約のJSON文字列（空文字列="契約なし"=message-required）
      onExit: {
        command: process.execPath,
        args: [
          path.join(__dirname, 'worker-exit-hook.js'),
          workspace, '', logPath, sinceTimestamp, String(logOffset),
          contractArg,
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

  try {
    const updated = updateWorkerProcess(workspace, workerName, launched);
    if (!updated) {
      // updateWorkerProcess の false はエントリ不在のみ（破損は throw でここに来ない）。
      return { success: false, method: 'resume-failed', error: `workers.json に worker "${workerName}" のエントリがありません` };
    }
  } catch (e) {
    // レジストリ破損・読み取り不能（readWorkersRaw の throw）。「エントリ不在」とは区別して
    // 報告しないと、破損が「ワーカーが見つからない」に化けて診断を誤誘導する（Issue #275
    // 項目1）。resume-failed としてバックオフに乗せる。
    return { success: false, method: 'resume-failed', error: `workers.json の読み取り・解析に失敗しました: ${e.message}` };
  }

  // 配送試行が生存確認まで成功した確定的な終着点 → 契約を消費する。
  // リトライ中（本関数が success: false で return したケース）では契約をクリアしない。
  if (contract) {
    _clearContract(workspace, workerName);
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
 * @param {string} [params.repo]     - main() が解決済みのリポジトリ名
 * @returns {{ success: boolean, method: string, error?: string }}
 */
function deliverMessage({ workerName, entry, message, workspace, homedir, issue, repo }) {
  if (_isWorkerAlive(entry)) {
    return {
      success: false,
      method: 'pending',
      error: `worker pid ${entry.pid} is alive (worker busy) — waiting for it to become idle for resume delivery`,
    };
  }

  const resumeResult = tryResumeAndDeliver({
    workerName, agentId: entry.agentId, message, workspace, homedir, baseBranch: entry.baseBranch, repo,
  });
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
  const { streamOutput = false, env = process.env } = opts;
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

  let values;
  try {
    ({ values } = parseFlags(args, {
      flags: { '--workspace': {}, '--interval': {}, '--hang-threshold-sec': {}, '--session-pid': {} },
      booleans: ['--once', '--force', '--help', '-h'],
      // 未知フラグ・位置引数はパーサ側で拒否される（argv-parsing-pitfalls参照）。
      positionals: { min: 0, max: 0 },
    }));
  } catch (e) {
    if (e.name !== 'ArgsValidationError') throw e;
    if (e.helpRequested) {
      writeOut(USAGE);
      return { code: 0, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
    }
    for (const ve of e.errors) writeErr(`worker-supervisor: ${ve.message}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  if (values['--help'] || values['-h']) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  const onceMode = values['--once'] === true;
  const force = values['--force'] === true;

  // ── 強制置き換えガード（Issue #384） ──────────────────────────────────
  // 本番の常駐プロセスはワーカーの作業対象ではない。オーケストレーターまたは人間
  // （GH_MAESTRO_WORKER=orchestrator / human）の名乗りがある場合のみ許可し、
  // 名乗りが無い場合やワーカー名乗りは role lease 取得や停止要求の前に即座に拒否する。
  if (force) {
    const guardRes = checkResidentForceGuard(env);
    if (!guardRes.allowed) {
      writeErr(guardRes.message);
      return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '', residentLease: null };
    }
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('worker-supervisor: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '' };
  }

  // intervalMs/hangThresholdMs は lease 拒否・例外時の早期 return でも参照するため、
  // role lease 取得より前に確定させる（TDZ 回避）。
  const intervalMs = (parseInt(values['--interval'] || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;
  const hangThresholdMs = (parseInt(values['--hang-threshold-sec'] || String(Math.round(DEFAULT_HANG_THRESHOLD_MS / 1000))) || DEFAULT_HANG_THRESHOLD_MS / 1000) * 1000;

  // Upgrade bridge: the old process uses a different script/role identity,
  // so acquiring the new lease alone cannot prevent overlap.
  let legacyPids = [];
  try { legacyPids = runningLegacyWorkerSupervisorPids(workspace); } catch {}
  if (legacyPids.length > 0 && !force) {
    writeErr(`worker-supervisor: 改名前の常駐プロセスを検出したため起動を拒否しました（pid: ${legacyPids.join(', ')}）。`);
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode, intervalMs, workspace, residentLease: null };
  }

  // ── 常駐プロセス用 role lease（Issue #240） ─────────────────────────────
  // 外部副作用（新着配送）を持つため --once でも排他する。取得は workspace 解決直後・
  // gh 呼び出しより前に行い、多重起動時は無駄な外部呼び出しを避けて即拒否する。
  // workspace 表記の差異（大文字小文字・末尾スラッシュ等）でもすり抜けないよう、
  // role lease は workspace を canonicalWorkspace で正規化して排他する（Issue #240）。
  let residentLease = null;
  {
    const role = WORKER_SUPERVISOR_ROLE;
    const handoffTargets = () => {
      const dup = findRunningInstance(workspace, { script: 'worker-supervisor.js', workerName: null });
      return [...new Set([...(dup ? [dup.pid] : []), ...legacyPids])];
    };
    try {
      const res = acquireResidentLease({ workspace, role, handoff: force, handoffStopTargets: handoffTargets, env });
      if (!res.acquired) {
        // 引き継ぎ期限超過（--force で既存所有者が終了しなかった）
        writeErr(
          `worker-supervisor: role "${role}" を引き継げませんでした（${res.reason}）` +
          (res.ownerPid ? `。既存プロセス pid=${res.ownerPid} が終了しません` : '') +
          `。既存プロセスを終了させてから再試行してください。`
        );
        return { code: 1, lines: out, errLines: err, runOnce: null, onceMode, intervalMs, workspace, residentLease: null };
      }
      residentLease = res;
    } catch (e) {
      writeErr(`worker-supervisor: 重複起動を検出しました。${e.message}`);
      writeErr('既存プロセスを終了させてから再起動するか、--force で引き継いでください。');
      return { code: 1, lines: out, errLines: err, runOnce: null, onceMode, intervalMs, workspace, residentLease: null };
    }
  }

  const sessionPid = resolveSessionPid(values['--session-pid']);

  // PID再利用検知のため、起動時に親セッションの起動時刻を捕捉する（best-effort。
  // 取得失敗時は expectedStartTime=null となり isProcessAlive のみの従来判定にフォールバック）。
  const expectedStartTime = _getProcessStartTime(sessionPid);
  const checkParent = _createDeadManSwitch(sessionPid, { expectedStartTime });

  // リポジトリ解決
  const ghOpts = { cwd: workspace };
  const repoResult = _ghRepoView(ghOpts);
  if (repoResult.status !== 0) {
    writeErr(`worker-supervisor: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '', residentLease };
  }
  const repo = repoResult.stdout.trim();
  if (!repo) {
    writeErr('worker-supervisor: リポジトリを解決できません（空のレスポンス）。');
    return { code: 1, lines: out, errLines: err, runOnce: null, onceMode: false, intervalMs: 0, workspace: '', residentLease };
  }

  // ホームディレクトリ（エージェント設定解決用）
  const homedir = process.env.HOME || process.env.USERPROFILE || '';

  // ── 書き込み連続失敗の警告（Issue #250） ─────────────────────────────
  // カーソル永続化（writeCursor）の失敗（他プロセスがカーソルファイルを掴んでいる等の
  // EPERM）は次のサイクルで再試行されるが、連続失敗が続くと配送済み状態がディスクに
  // 永続化されない。連続失敗が閾値（5回≒約100秒）に達したら orchestrator へ警告する。
  // カウンタはプロセス全体でなくワーカー単位で持つ（あるワーカーの成功が別ワーカーの
  // 連続失敗をリセットしないようにするため）。
  const writeFailureMonitors = new Map(); // workerName → monitor
  const getWriteFailureMonitor = (workerName, issue) => {
    let monitor = writeFailureMonitors.get(workerName);
    if (!monitor) {
      monitor = createWriteFailureMonitor({
        notify: ({ count, detail }) => {
          const body = `⚠️ ワーカー "${workerName}" のカーソル書き込みが ${count} 回連続で失敗しています（他プロセスが cursor ファイルを掴んでいる可能性）。最新のエラー: ${detail}`;
          let res;
          try {
            res = _notifyOrchestrator({ workspace, issue, body });
          } catch (e) {
            writeErr(`worker-supervisor: 書き込み連続失敗の警告の送信に失敗: ${e.message}`);
            return;
          }
          if (res.status !== 0) {
            writeErr(`worker-supervisor: 書き込み連続失敗の警告の送信に失敗: ${(res.stderr || '').trim()}`);
          }
        },
      });
      writeFailureMonitors.set(workerName, monitor);
    }
    return monitor;
  };

  // writeCursor の失敗でディスクのカーソルが巻き戻っても、同一プロセス内では重複配送
  // しないためのメモリ内配送済みキャッシュ（Issue #250）。サイズはディスク側と同じ
  // MAX_SEEN_IDS に制限する。プロセスが再起動すれば消える（その場合の正本はディスク）。
  const deliveredIdsCache = new Map(); // workerName → number[]
  const markDeliveredInMemory = (workerName, cid) => {
    const arr = deliveredIdsCache.get(workerName) || [];
    arr.push(cid);
    deliveredIdsCache.set(workerName, arr.slice(-MAX_SEEN_IDS));
  };
  const wasDeliveredInMemory = (workerName, cid) => {
    const arr = deliveredIdsCache.get(workerName) || [];
    return arr.includes(cid);
  };

  /**
   * 1回のポーリングサイクル。
   * 全ワーカーをスキャンし、新着メッセージの検出・配送を行う。
   */
  function runOnce() {
    // dead-man's switch: 親が死んでいたら cleanup して非ゼロ終了（exit 3）
    // exit 3 = 親セッション消滅。exit 0 にすると正常終了扱いとなり、Monitor の異常終了
    // アラーム経路と watchdog 通知が両方無効化される（Issue #301）。
    if (!checkParent()) {
      lifecycleCleanup(workspace);
      handleParentSessionDeath({ workspace, scriptName: 'worker-supervisor.js', role: WORKER_SUPERVISOR_ROLE, sessionPid });
      _parentDeathExit(PARENT_DEATH_EXIT_CODE);
    }

    writeOut('SCAN_START source=worker-supervisor.js scope=worker-delivery-scan orchestrator-inbox=separate-msg-poll.js');

    const workers = loadWorkers(workspace);
    let totalDetected = 0;

    for (const [workerName, entry] of workers) {
      if (!entry.issue) continue;

      const issue = String(entry.issue);
      const cursor = readCursor(workspace, workerName);

      // ── ハング検知 ──────────────────────────────────────────────────
      // ワーカーが生存しているがログファイルの更新が一定時間止まっていれば「ハングの疑い」
      // として orchestrator へ通知する。同一プロセス（PID+startTime）には1回のみ通知し、
      // ログが再び動いたらリセットする。
      //
      // 重複通知防止キーは pid 単独ではなく pid + startTime（起動時刻）の組で同一プロセスを
      // 識別する（居座り検知の staleReportNotifiedPid/StartTime と同じ理由、Issue #265）。
      // resumeで新プロセスが起動すると entry.startTime が更新され、baselineMs もそれに
      // 追随して新しくなる（下記）ため、resume直後は非ハング判定に落ちる。この非ハング分岐
      // は「ログが再び動いた」ことを表す HANG_RESUMED を出すが、旧PIDに対する通知済み状態が
      // 残っているだけで新プロセス自体は一度もハング通知されていない場合、これを
      // HANG_RESUMED として報告するのは誤り（ログが実際に動いたわけではない）。
      // pid+startTime が現在のエントリと一致する場合のみ「復帰」として報告し、一致しない
      // （＝別プロセスの通知済み状態が残留しているだけの）場合は無言でクリアする。
      if (_isWorkerAlive(entry)) {
        const logPath = workerLogPath(workspace, workerName);
        let mtimeMs = null;
        try {
          if (fs.existsSync(logPath)) {
            mtimeMs = fs.statSync(logPath).mtimeMs;
          }
        } catch {
          // ログファイルが存在しない・statできない → ハング判定はスキップ
        }

        if (mtimeMs !== null) {
          // 無反応時間の基準は「ログmtime」と「現在のプロセスの起動時刻」のうち
          // 新しい方とする（Issue #265）。resumeで新プロセスが起動した直後は
          // まだログを書いておらず、mtimeは前セッション終了時点のまま引き継がれる。
          // それをそのまま基準にすると、今動き始めたばかりのプロセスが前回の
          // 空白期間ぶん無反応だったと誤判定される。startTimeが無い/不正な
          // エントリでは同一性を確認できないため、従来どおりmtimeのみで判定する
          // （worker-liveness.js の isWorkerAlive と同じ「判定不能はfail-safe側」方針）。
          let baselineMs = mtimeMs;
          if (entry.startTime) {
            const startTimeMs = new Date(entry.startTime).getTime();
            if (!Number.isNaN(startTimeMs) && startTimeMs > baselineMs) {
              baselineMs = startTimeMs;
            }
          }
          const nowMs = Date.now();
          const staleMs = nowMs - baselineMs;
          if (staleMs > hangThresholdMs) {
            // ハング状態 — 同一プロセス（pid+startTime）には1回だけ通知
            const alreadyNotified = cursor.hangNotifiedPid === entry.pid
              && cursor.hangNotifiedStartTime === entry.startTime;
            if (!alreadyNotified) {
              const minutes = Math.floor(staleMs / 60000);
              const body = `⚠️ ワーカー "${workerName}" がハングしている疑いがあります（ログ最終更新から ${minutes} 分以上経過、PID ${entry.pid}）。状態を確認し、必要ならプロセスを終了して再起動を検討してください。`;
              let notified = false;
              try {
                const notifyResult = _notifyOrchestrator({ workspace, issue, body });
                notified = notifyResult.status === 0;
                if (!notified) {
                  writeErr(`worker-supervisor: hang通知の投稿に失敗: ${(notifyResult.stderr || '').trim()}`);
                }
              } catch (e) {
                writeErr(`worker-supervisor: hang通知の投稿に失敗: ${e.message}`);
              }
              // 通知成功時のみ通知済み状態を更新・永続化する。
              if (notified) {
                cursor.hangNotifiedPid = entry.pid;
                cursor.hangNotifiedStartTime = entry.startTime;
                cursor.hangNotifiedAt = new Date().toISOString();
                const elapsed = formatElapsedTime(baselineMs, nowMs);
                writeOut(`HANG_DETECTED:${workerName}:${entry.pid} elapsed=${elapsed}`);
                // 後続処理（gh apiコメント取得等）が失敗してループがcontinueしても通知済み
                // 状態が失われないよう、ここで先に永続化する。他プロセスがカーソルを掴んで
                // いる等の EPERM でも停止せず、次サイクルの writeCursor 成功時にまとめて
                // 永続化される（HANG_RESUMED と同じ扱い、Issue #250）。
                try {
                  writeCursor(workspace, workerName, cursor);
                } catch (e) {
                  writeErr(`worker-supervisor: ${workerName} のカーソル保存に失敗しました: ${e.message}`);
                  getWriteFailureMonitor(workerName, issue).onFailure(e.message);
                }
              }
            }
          } else if (cursor.hangNotifiedPid !== null) {
            // 通知済み状態が残っているが、いまは非ハング判定 → クリアする。
            // 「ログが再び動いた」と報告してよいのは、通知した本人（pid+startTime一致）が
            // 復帰した場合だけ。pid/startTimeが今のエントリと食い違う場合は、resumeで
            // 新プロセスに切り替わった結果、旧プロセスの通知済み状態が残留しているだけ
            // （その旧プロセスはもう存在しない）なので、HANG_RESUMEDは出さず黙って
            // クリアする（Issue #265）。
            const isSameProcess = cursor.hangNotifiedPid === entry.pid
              && cursor.hangNotifiedStartTime === entry.startTime;
            cursor.hangNotifiedPid = null;
            cursor.hangNotifiedStartTime = null;
            cursor.hangNotifiedAt = null;
            if (isSameProcess) {
              writeOut(`HANG_RESUMED:${workerName}:${entry.pid}`);
            }
            // クリア状態を後続処理より先に永続化する（上記HANG_DETECTEDと同じ理由）。
            // 他プロセスがカーソルを掴んでいる等の EPERM でも停止せず、次サイクルの
            // writeCursor 成功時にまとめて永続化される（Issue #250）。
            try {
              writeCursor(workspace, workerName, cursor);
            } catch (e) {
              writeErr(`worker-supervisor: ${workerName} のカーソル保存に失敗しました: ${e.message}`);
              getWriteFailureMonitor(workerName, issue).onFailure(e.message);
            }
          }
        }
      }

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
          repo,
        });

        if (deliveryResult.success) {
          cursor.deliveredIds.push(commentId);
          markDeliveredInMemory(workerName, commentId);
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
            writeErr(`worker-supervisor: ${workerName} comment ${commentId} — max retries (${MAX_RETRIES}) exceeded, giving up`);
            // 断念を stderr に書くだけでは誰も読まない（detachedプロセスのstderrは通常誰も
            // 監視していない）。orchestrator自身のinboxに投稿し、確実に気づけるようにする。
            const giveUpBody = `⚠️ ワーカー "${workerName}" へのメッセージ配送に${MAX_RETRIES}回失敗し断念しました（comment ${commentId}）。最後のエラー: ${deliveryResult.error || 'unknown'}。ワーカーが応答不能になっている可能性があります。状態を確認し、必要なら再起動を検討してください。`;
            try {
              const notifyResult = _notifyOrchestrator({ workspace, issue, body: giveUpBody });
              if (notifyResult.status !== 0) {
                writeErr(`worker-supervisor: 配送断念のorchestrator通知に失敗: ${(notifyResult.stderr || '').trim()}`);
              }
            } catch (e) {
              writeErr(`worker-supervisor: 配送断念のorchestrator通知に失敗: ${e.message}`);
            }
            // 5回のリトライを尽くした配送断念は確定的な終着点 → 契約を消費する。
            // これにより、別の新着メッセージで次回resumeされるときに不要な契約が残留しない。
            try {
              _clearContract(workspace, workerName);
            } catch {
              // クリア失敗は無視（次回のresumeでreadContractが最新契約を読むため）
            }
          }
        }
      }

      // ── 新着コメントのスキャン ─────────────────────────────────────
      // カーソルが無い初回は since を指定せず全件取得（seenIds で重複防止）
      const workerSince = cursor.since || null;
      const apiResult = _ghApiComments(repo, issue, workerSince, { cwd: workspace });

      if (apiResult.status !== 0) {
        writeErr(`worker-supervisor: gh api エラー (worker ${workerName}, issue ${issue}): ${apiResult.stderr || apiResult.error?.message || '(empty)'}`);
        continue;
      }

      let comments;
      try {
        comments = parseCommentsResponse(apiResult.stdout);
      } catch {
        writeErr(`worker-supervisor: JSON parse エラー (worker ${workerName}, issue ${issue})`);
        continue;
      }
      if (comments === null) {
        writeErr(`worker-supervisor: gh api の応答が配列ではありません (worker ${workerName}, issue ${issue})`);
        continue;
      }

      // ── 未報告のまま居座るワーカーの検知（Issue #263） ─────────────────
      // ハング検知（ログ更新時刻ベース）とは独立の判定軸。ワーカーが自分の直近の起動
      // （entry.startTime）以降に既に orchestrator へ報告を投稿しているのに、プロセスが
      // 終了せず生存し続けている状態を「居座り」として異常通知する。正常な終了処理の
      // 猶予として、報告コメントの投稿から10秒経過するまでは判定しない。
      //
      // 重複通知防止キーは pid 単独ではなく pid + startTime（起動時刻）の組で同一プロセスを
      // 識別する。同一ファイル内の生存判定（_isWorkerAlive → verifyProcessIdentity）と同じ
      // 理由: PIDだけをキーにすると、通知後にワーカーが終了し、OSがそのPIDを無関係な別
      // プロセスへ再利用した場合、再利用先が同じPIDで別の（未報告の）ワーカーとして
      // resume されても「既に通知済みのPID」と誤認して再通知を抑止してしまう。
      //
      // gh api の呼び出しは上の「新着コメントのスキャン」で取得済みの comments をそのまま
      // 再利用し、この判定専用の追加取得は行わない。ワーカーごとに毎周期2回目の全件取得を
      // 行うと、配送処理と同じ周期でAPI呼び出し数が倍になり、レート制限に達すると本Issueが
      // 直そうとしている「配送が止まる」事態を招く（本末転倒）。comments は since=cursor.since
      // で絞られているが、報告コメントが初めて出現するサイクルでは必ずこの取得結果に含まれる
      // （cursor.since はこのサイクルの終わりに comments の最大 created_at まで進むため、
      // 同一サイクル内であれば取りこぼさない。一度検知した後は pid+startTime ベースの重複
      // 排除で再通知しないため、翌サイクル以降 since がその報告コメントを過ぎても問題ない）。
      const isAlive = _isWorkerAlive(entry);
      if (isAlive && entry.startTime) {
        // 新プロセスが起動した場合は旧プロセスの停止通知キーをクリアする（同一プロセスなら保持し再通知を防ぐ）
        if (cursor.stoppedNotifiedPid !== null) {
          const isSameProcess = cursor.stoppedNotifiedPid === entry.pid
            && cursor.stoppedNotifiedStartTime === entry.startTime;
          if (!isSameProcess) {
            cursor.stoppedNotifiedPid = null;
            cursor.stoppedNotifiedStartTime = null;
            cursor.stoppedNotifiedAt = null;
          }
        }

        const reportResult = getReportStatusSinceStart(comments, workerName, entry.startTime);
        const commentReport = reportResult.status === 'reported' ? reportResult.report : null;
        if (commentReport) {
          cursor.reportedPid = entry.pid;
          cursor.reportedStartTime = entry.startTime;
          cursor.reportedCreatedAt = commentReport.created_at;
        }

        const pendingReportMatches = cursor.staleReportPendingPid === entry.pid
          && cursor.staleReportPendingStartTime === entry.startTime
          && cursor.staleReportPendingCreatedAt;
        const recordedReportMatches = cursor.reportedPid === entry.pid
          && cursor.reportedStartTime === entry.startTime
          && cursor.reportedCreatedAt;
        const latestReport = commentReport || (pendingReportMatches
          ? { created_at: cursor.staleReportPendingCreatedAt }
          : (recordedReportMatches ? { created_at: cursor.reportedCreatedAt } : null));
        const reported = latestReport !== null;
        const alreadyNotified = cursor.staleReportNotifiedPid === entry.pid
          && cursor.staleReportNotifiedStartTime === entry.startTime;
        const reportAgeMs = latestReport ? Date.now() - new Date(latestReport.created_at).getTime() : 0;
        if (reported === true && reportAgeMs < STALE_REPORT_GRACE_MS && !alreadyNotified) {
          // 報告コメントが cursor.since を追い越しても、猶予後の巡回で再評価できるよう
          // 報告時刻をカーソルとは独立して保存する（Issue #386）。
          cursor.staleReportPendingPid = entry.pid;
          cursor.staleReportPendingStartTime = entry.startTime;
          cursor.staleReportPendingCreatedAt = latestReport.created_at;
        } else if (reported === true && reportAgeMs >= STALE_REPORT_GRACE_MS && !alreadyNotified) {
          const elapsed = formatElapsedTime(latestReport.created_at);
          const body = `⚠️ ワーカー "${workerName}" は既に報告を投稿済み（投稿から ${elapsed} 経過）ですが、プロセス（PID ${entry.pid}）が生存しています。終了処理中・作業継続中・プロセスの終了漏れの可能性があります。この状態の間、新しい指示は配送されず待機し続けます。作業状況（未コミット変更・ログ等）を確認し、不要な残留プロセスの場合は終了してください。`;
          let notified = false;
          try {
            const notifyResult = _notifyOrchestrator({ workspace, issue, body });
            notified = notifyResult.status === 0;
            if (!notified) {
              writeErr(`worker-supervisor: 居座り通知の投稿に失敗: ${(notifyResult.stderr || '').trim()}`);
            }
          } catch (e) {
            writeErr(`worker-supervisor: 居座り通知の投稿に失敗: ${e.message}`);
          }
          // 通知成功時のみ通知済み状態を更新する（HANG_DETECTEDと同じ扱い）。永続化は
          // このワーカーの処理末尾にある共通の writeCursor に任せる（このブロックの後、
          // 新着メッセージのスキャン・配送でも同じ cursor オブジェクトを書き換えるため、
          // ここで個別に保存すると二重書き込みになる）。
          if (notified) {
            cursor.staleReportPendingPid = null;
            cursor.staleReportPendingStartTime = null;
            cursor.staleReportPendingCreatedAt = null;
            cursor.staleReportNotifiedPid = entry.pid;
            cursor.staleReportNotifiedStartTime = entry.startTime;
            cursor.staleReportNotifiedAt = new Date().toISOString();
            writeOut(`STALE_REPORT_DETECTED:${workerName}:${entry.pid} elapsed=${elapsed}`);
          }
        }
      } else if (isAlive) {
        // startTime が無い生存中プロセスで別PIDが動いた場合のみ停止通知キーをクリア
        if (cursor.stoppedNotifiedPid !== null && cursor.stoppedNotifiedPid !== entry.pid) {
          cursor.stoppedNotifiedPid = null;
          cursor.stoppedNotifiedStartTime = null;
          cursor.stoppedNotifiedAt = null;
        }
      } else {
        // プロセスが終了した保留報告は次のPIDへ持ち越さない。
        cursor.staleReportPendingPid = null;
        cursor.staleReportPendingStartTime = null;
        cursor.staleReportPendingCreatedAt = null;

        // ── 停止したワーカーの検知（Issue #411） ─────────────────────────
        // ワーカーのプロセスが生存していないことを検知した場合、orchestrator へ通知する。
        // 発火条件は「プロセスが生存していない」という事実のみとし、報告の有無を発火条件に
        // 含めない（停止と報告のタイムラグによる取りこぼしを防ぐため）。
        //
        // 報告状況は「報告済み／未投稿／判定不能（起動時刻なし・不正）」の3状態を区別して
        // 通知本文に明記する。cursor.since 以降の新着コメントに加えて、生存中に観測・永続化した
        // 報告（reportedPid+reportedStartTime）も参照することで、cursor.since が報告を
        // 追い越した後に停止した場合でも正しく「報告済み」と判定する。
        //
        // entry.startTime が null/未記録の場合でも、entry.pid があれば通知する（判定不能として報告）。
        // 重複通知防止キーは pid と startTime の組で照合する（同一PIDでも起動時刻が異なれば
        // 別プロセスとして再通知する）。
        // プロセスの停止・再起動・削除等の自動介入は一切行わない。
        if (entry.pid) {
          const alreadyNotified = cursor.stoppedNotifiedPid === entry.pid
            && cursor.stoppedNotifiedStartTime === (entry.startTime ?? null);
          if (!alreadyNotified) {
            let reported = null;
            if (entry.startTime) {
              const reportResult = getReportStatusSinceStart(comments, workerName, entry.startTime);
              if (reportResult.status === 'reported') {
                reported = true;
                cursor.reportedPid = entry.pid;
                cursor.reportedStartTime = entry.startTime;
                cursor.reportedCreatedAt = reportResult.report.created_at;
              } else if (reportResult.status === 'unknown') {
                reported = null;
              } else if (cursor.reportedPid === entry.pid && cursor.reportedStartTime === entry.startTime && cursor.reportedCreatedAt) {
                reported = true;
              } else {
                reported = false;
              }
            }

            const reportStatusText = reported === true
              ? '報告済み'
              : (reported === false ? '未投稿' : '判定不能（起動時刻なし・不正）');
            const body = `⚠️ ワーカー "${workerName}" のプロセス（PID ${entry.pid}）が停止しています。報告状況: ${reportStatusText}。`;
            let notified = false;
            try {
              const notifyResult = _notifyOrchestrator({ workspace, issue, body });
              notified = notifyResult.status === 0;
              if (!notified) {
                writeErr(`worker-supervisor: 停止通知の投稿に失敗: ${(notifyResult.stderr || '').trim()}`);
              }
            } catch (e) {
              writeErr(`worker-supervisor: 停止通知の投稿に失敗: ${e.message}`);
            }
            if (notified) {
              cursor.stoppedNotifiedPid = entry.pid;
              cursor.stoppedNotifiedStartTime = entry.startTime ?? null;
              cursor.stoppedNotifiedAt = new Date().toISOString();
              writeOut(`STOP_DETECTED:${workerName}:${entry.pid}`);
            }
          }
        }
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

        // 配送前に deliveredIds をチェック（重複防止）。writeCursor の失敗でディスクが
        // 巻き戻っても同一プロセス内で重複配送しないよう、メモリ上の配送済みキャッシュ
        // も併せて確認する（Issue #250）。
        if (cursor.deliveredIds.includes(candidate.cid) || wasDeliveredInMemory(workerName, candidate.cid)) {
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
          repo,
        });

        cursor.seenIds.push(candidate.cid);

        if (deliveryResult.success) {
          cursor.deliveredIds.push(candidate.cid);
          markDeliveredInMemory(workerName, candidate.cid);
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

      // カーソル永続化は他プロセスがカーソルファイルを掴んでいる等で EPERM 失敗しうる
      // （Issue #250）。例外はここで捕捉してこのワーカーの処理を終え、次サイクルで再試行
      // する。ディスクが巻き戻っても deliveredIds はメモリキャッシュで重複配送を防ぐ。
      try {
        writeCursor(workspace, workerName, cursor);
        getWriteFailureMonitor(workerName, issue).onSuccess();
      } catch (e) {
        writeErr(`worker-supervisor: ${workerName} のカーソル保存に失敗しました: ${e.message}`);
        getWriteFailureMonitor(workerName, issue).onFailure(e.message);
        continue;
      }
    }

    writeOut(`SCAN_END:${workers.size}:${totalDetected} source=worker-supervisor.js scope=worker-delivery-scan workers=${workers.size} detected=${totalDetected} orchestrator-inbox=separate-msg-poll.js`);
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
    residentLease,
  };
}

let _readContract = readContract;
let _clearContract = clearContract;

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  // --help/-h は role lease 取得等の副作用より前に判定する。
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  const result = main(undefined, { streamOutput: true });

  // role lease の解放は main() の成功・失敗を問わず、全 exit 経路で行う。
  // main() が lease を取得していない（help・引数エラー）場合は null で no-op。
  function releaseResidentLease() {
    if (result.residentLease && typeof result.residentLease.release === 'function') {
      result.residentLease.release();
    }
  }

  for (const l of result.errLines) process.stderr.write(l + '\n');

  if (result.code !== 0) {
    releaseResidentLease();
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(result.code);
  }

  if (result.runOnce === null) {
    // --help（main() が USAGE を返す場合）
    releaseResidentLease();
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  // PID registry に自己登録（表示・診断用途。排他の正本は role lease であり、二重化しない）
  registerProcess(result.workspace, { script: 'worker-supervisor.js' });

  const ru = result.runOnce;

  function cleanup() {
    lifecycleCleanup(result.workspace);
    releaseResidentLease();
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
    // 常駐監視の異常終了（非ゼロexit）を orchestrator へ通知する（Issue #301）。
    // これまで worker-supervisor は異常終了時に一切通知していなかった。
    // 正常終了（exit 0 = SIGINT / SIGTERM）では何もしない。
    // --once 完了も exit 0 のため通知されない。
    process.on('exit', () => { notifyWatchdogExit({ workspace: result.workspace, scriptName: 'worker-supervisor.js' }); });
    ru();
    setInterval(ru, result.intervalMs);
  }
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setGetProcessStartTime: (fn) => { _injectedGetProcessStartTime = fn; },
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhApiComments: (fn) => { _ghApiComments = fn; },
  _setIsWorkerAlive: (fn) => { _isWorkerAlive = fn; },
  _setSleep: (fn) => { _sleep = fn; },
  _setNotifyOrchestrator: (fn) => { _notifyOrchestrator = fn; },
  // 実装を直接参照（テストが注入を戻す際の復元用。PR #251 の引数検証テストから使う）
  _notifyOrchestrator,
  _setReadContract: (fn) => { _readContract = fn; },
  _setClearContract: (fn) => { _clearContract = fn; },
  _setCreateDeadManSwitch: (fn) => { _createDeadManSwitch = fn; },
  _setParentDeathExit: (fn) => { _parentDeathExit = fn; },
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
