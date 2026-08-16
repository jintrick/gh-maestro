#!/usr/bin/env node
// msg-poll.js — GitHub Issue コメントをポーリングして新着メッセージを stdout に通知する
//
// Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once | --wait <sec>]
//
// Output (stdout):
//   worker mode:       NEW_MESSAGE:<commentId>
//   orchestrator mode: NEW_MESSAGE:<issue>:<commentId>
//
// poll-reviews.js と同型の設計。エージェント自身のターン内で
// blocking poll として実行され、detached sidecar にはならない。
//
// 既読状態は .gh-maestro/msg-state/<self>.json に永続化される（v2スキーマ、Issue #207）。
// 既読の正本は「明示的に既読化されたコメントID集合（readByIssue）」であり、時刻カーソル
// （since）による既読推測は行わない。sinceByIssue は取得範囲の絞り込み（パフォーマンス
// 最適化）にのみ使う（ウォーターマークの1秒前から差分取得し、境界秒の取りこぼしを防ぐ）。
// orchestrator モードでは state が欠落・破損・旧形式（未初期化）の場合、空状態を暗黙作成
// せず走査を停止して「reset-session.js での初期化が必要」と報告する。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { validateField } = require('./shared/validate');
const { isRetryableGhFailure, graphqlListComments } = require('./shared/gh-fallback');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const readStateLib = require('./shared/read-state');
const {
  resolveSessionPid,
  createDeadManSwitch,
  getProcessStartTime,
  registerProcess,
  findRunningInstance,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');
const { acquireResidentLease } = require('./shared/worker-lease');
const { listUnprocessedResidentAuditEvents, removeResidentAuditEvent } = require('./shared/resident-audit');
const { createWriteFailureMonitor } = require('./shared/write-failure-warning');
const { notifyWatchdogExit, PARENT_DEATH_EXIT_CODE } = require('./shared/watchdog-exit-notify');
const { handleParentSessionDeath } = require('./shared/resident-parent-death');

// テスト注入（test-process-spawn-safety ルール準拠）。既定は実装。
let _createDeadManSwitch = createDeadManSwitch;
let _parentDeathExit = (code) => process.exit(code);

const DEFAULT_INTERVAL_SEC = 20;
const MARKER_RE = /^<!--\s*gh-maestro\s+(\{.*\})\s*-->/;

const USAGE = `msg-poll.js — GitHub Issue コメントを定期スキャンし新着メッセージを stdout に通知する

Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once | --wait <sec>] [--session-pid <pid>] [--force]
       node msg-poll.js --watch-pid <pid> [--interval <sec>]

Arguments:
  <self>                 自分の名前（worker 名、または "orchestrator"）

Options:
  --issue <N>            監視対象の Issue 番号（worker モードでは必須、orchestrator モードでは指定不要）
  --workspace <path>     ワークスペースパス（省略時は環境変数またはCWDから解決）
  --interval <sec>       ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）
  --once                 1回だけスキャンして終了する（継続ポーリングしない）
  --wait <sec>           新着メッセージを1件検出するか、指定秒数が経過するまでフォアグラウンドで
                          待機する（内部的には --interval 秒間隔でリトライする）。新着を1件検出した
                          時点、またはタイムアウト時点のいずれか早い方で exit code 0 で終了する。
                          新着が複数件たまっていても、1回の呼び出しで出力・既読化されるのは
                          最も古い1件のみ。残りは次回の --wait 呼び出しで改めて返される。
                          --once と同時指定はできない（エラー終了する）。
                          継続モードと同様にPID registryへ自己登録し、終了時に解除する。
  --session-pid <pid>    監視対象のセッションPID（dead-man's switch用。省略時は自動検出）
  --force                同じ role を既に保持している生存プロセスがいても、既存所有者へ
                          停止要求を送ってから起動する（継続モード・--wait モードのみ有効。
                          lease判定を無効化せず、引き継げなければ exit 1 する。既定では
                          多重起動を検知して exit 1 する）。
  --watch-pid <pid>      他の <self> 引数を無視し、指定PIDの生存監視のみを行う特殊モード。
                          「重複起動を検出しました」エラー時に代替コマンドとして案内される
                          （このモードは msg-poll.js 自身を起動するかどうかの判断を必要としない）。
                          PIDが生存している間は何も出力しない。死亡を検知した時点で
                          \`PID_DIED:<pid>\` を1行出力して exit 0 する。Monitorのcommandに
                          そのまま渡すことを想定している。PID registryへの自己登録は行わない
                          （監視対象そのものではなくその健全性を見ているだけのため）。

Output (stdout):
  新着メッセージを1行ずつ出力:
    worker モード:       NEW_MESSAGE:<commentId>
    orchestrator モード: NEW_MESSAGE:<issue>:<commentId>
    orchestrator モード: LOCK_DENIED:<role>[:<ownerPid>] / HANDOFF_WAIT:<role>[:<ownerPid>]
                          （常駐プロセスの role lease で起動が拒否された・引き継ぎ待機に
                          入った監査イベント。各巡回で未処理分を処理済み化して出力する。
                          GitHub への投稿は行わない）
  --watch-pid モード:    PID_DIED:<pid>（監視対象PIDの死亡を検知した1回のみ）

このスクリプトはエージェントのターン内で blocking 実行される。detached 起動しない。
既読状態は .gh-maestro/msg-state/<self>.json（v2スキーマ）に永続化され、--once/--wait の
繰り返し実行でも二重通知しない。既読の正本は明示既読コメントID集合（readByIssue）であり、
時刻カーソル（since）による既読推測・初回サイレント catch-up は行わない。sinceByIssue は
取得範囲の絞り込みのみに使い、ウォーターマークの1秒前から差分取得する（取りこぼし防止）。
orchestrator モードでは state が欠落・破損・旧形式（未初期化）の場合、空状態を暗黙作成せず
走査を停止し、stderr に「reset-session.js での初期化が必要」と報告する。
gh 呼び出し失敗（ネットワーク断・rate limit 等）はそのサイクルをスキップし次サイクルへ継続する。

ライフサイクル管理:
  ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
  消滅時はPID registryを解除して自動exitする。継続モード・--wait モードは起動時にPID registryへ
  自己登録し、role lease（role = msgpoll-<self>、<workspace>/.gh-maestro/leases/）を
  プロセス寿命中保持する。正常終了・シグナル・初期化失敗の全経路で解放する。`;

/**
 * 「重複起動を検出しました」エラー時に案内する、既存PIDを監視するための
 * 代替コマンド文字列を組み立てる。
 *
 * @param {number} pid
 * @param {string|null} [intervalSec]
 * @returns {string}
 */
function buildWatchPidCommand(pid, intervalSec) {
  const parts = ['node', JSON.stringify(__filename), '--watch-pid', String(pid)];
  if (intervalSec) parts.push('--interval', String(intervalSec));
  return parts.join(' ');
}

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

const GH_TIMEOUT_MS = 30000;

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghApiComments = (repo, issue, since, opts = {}) => {
  const callOpts = { ...opts, per_page: 100 };
  if (since) callOpts.since = since;
  const restResult = listComments(repo, issue, callOpts);

  if (restResult.status === 0 || !isRetryableGhFailure(restResult)) {
    return restResult;
  }

  process.stderr.write('msg-poll: REST API失敗のためGraphQLにフォールバックします\n');
  return graphqlListComments({ repo, issue, since, opts: { timeout: GH_TIMEOUT_MS, ...opts } });
};

// ── ヘルパー ──────────────────────────────────────────────────────────────
//
// 既読状態（msg-state/<self>.json）の読み書きは scripts/shared/read-state.js に集約した。
// v2 スキーマ（{ schemaVersion, initialized, generation, readByIssue }）で、既読判定は
// 時刻カーソルではなく「明示的に既読化されたコメントID集合」を使う（Issue #207）。
// statePath / readState / writeState はテスト互換のため共有モジュールを再エクスポートする。

const statePath = readStateLib.statePath;
const readState = readStateLib.readState;
const writeState = readStateLib.writeState;

/**
 * 今回の走査で既読として記録するIDを Issue ごとに Set で集める。
 * @param {Map<string, Set<number>>} map
 * @param {string} issue
 * @param {number} cid
 */
function addRecord(map, issue, cid) {
  if (!map.has(issue)) map.set(issue, new Set());
  map.get(issue).add(cid);
}

/**
 * ISO8601 時刻文字列から deltaSec 秒を加算して秒精度（ミリ秒なし）で返す。
 * パース不能なら null。
 *
 * 取得最適化カーソル（sinceByIssue）の安全マージン用。GitHub の since フィルタは
 * 「created_at > since」の排他的挙動とみなし、境界秒に新着が詰まる場合の取りこぼしを
 * 防ぐため、ウォーターマークの1秒前を取得開始点にする（新着は必ずウォーターマーク以上の
 * created_at を持つため、1秒のマージンで全件を確実に含める）。
 *
 * @param {string} iso
 * @param {number} deltaSec
 * @returns {string|null}
 */
function addSeconds(iso, deltaSec) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + deltaSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseMarker(body) {
  if (!body) return null;
  const firstLine = body.split('\n')[0];
  const m = firstLine.match(MARKER_RE);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    if (meta && typeof meta.to === 'string') {
      return meta;
    }
    return null;
  } catch {
    return null;
  }
}

// ── 引数解析（main() と CLI プリフライトの両方から共有） ──────────────────

/**
 * CLI引数を解析する。main() と CLI エントリポイントの多重起動プリフライトチェックが
 * 別々に parseFlags を呼び直すと解析ロジックが乖離するため、ここに一本化する。
 *
 * @param {string[]} args
 * @returns {{
 *   help: boolean,
 *   validationErrors?: Array<{ message: string }>|null,  // 検証エラー時のみ設定（help・成功時は null）
 *   self?: string, issueArg?: string|null, workspaceArg?: string|null,
 *   intervalArg?: string|null, sessionPidArg?: string|null,
 *   onceMode?: boolean, force?: boolean, waitArg?: string|null,
 * }}
 */
function parseArgs(args) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(args, {
      flags: { '--workspace': {}, '--issue': {}, '--interval': {}, '--session-pid': {}, '--wait': {} },
      booleans: ['--once', '--force', '--help', '-h'],
      // self（ワーカー名/recipient）は最大1つの位置引数。未知フラグ（-- 始まり）は
      // パーサ側で拒否される（Issue #14 / argv-parsing-pitfalls。先頭に来て self として
      // 採用されるとポーリング・状態更新・PID registry操作まで進んでしまうため）。
      positionals: { min: 0, max: 1 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      return { help: true, validationErrors: null };
    }
    return { help: false, validationErrors: err.errors };
  }

  if (values['--help'] || values['-h']) {
    return { help: true, validationErrors: null };
  }

  return {
    help: false,
    validationErrors: null,
    self: rest[0],
    issueArg: values['--issue'],
    workspaceArg: values['--workspace'],
    intervalArg: values['--interval'],
    sessionPidArg: values['--session-pid'],
    onceMode: values['--once'] === true,
    force: values['--force'] === true,
    waitArg: values['--wait'],
  };
}

// ── メインロジック ────────────────────────────────────────────────────────

/**
 * 引数バリデーションと初期化を行い、poll 実行に必要なオブジェクトを返す。
 * scanOnce() は初回のスキャン実行前には呼ばれない（呼び出し側が制御する）。
 *
 * @param {string[]} [argsOverride]  省略時は process.argv.slice(2)
 * @param {{ streamOutput?: boolean }} [opts]  streamOutput=true で scanOnce
 *   内の出力をリアルタイムに process.stdout へも流す（継続モード CLI 用）
 * @returns {{
 *   code: number, lines: string[], errLines: string[],
 *   scanOnce: (() => void) | null,   // code !== 0 のときは null
 *   onceMode: boolean,
 *   intervalMs: number,
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
  const parsed = parseArgs(args);

  if (parsed.help) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err, scanOnce: null, onceMode: true, intervalMs: 0 };
  }

  if (parsed.validationErrors) {
    for (const e of parsed.validationErrors) writeErr(`msg-poll: ${e.message}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const { self, issueArg, onceMode, force, waitArg } = parsed;

  if (onceMode && waitArg != null) {
    writeErr('msg-poll: --once と --wait は同時指定できません。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const waitMode = !onceMode && waitArg != null;
  let waitMs = 0;
  if (waitMode) {
    const parsedWait = parseInt(waitArg, 10);
    if (!Number.isFinite(parsedWait) || parsedWait <= 0) {
      writeErr(`msg-poll: --wait には正の整数（秒）を指定してください: ${waitArg}`);
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
    }
    waitMs = parsedWait * 1000;
  }

  if (!self) {
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  // path-safety 検証（queue-path-safety.md 準拠）
  try {
    validateField('self', self);
  } catch (e) {
    writeErr(`msg-poll: ${e.message}`);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  // orchestrator かどうか
  const isOrchestrator = self === 'orchestrator';

  // worker モードでは --issue 必須
  if (!isOrchestrator && !issueArg) {
    writeErr('msg-poll: worker モードでは --issue <N> が必須です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const workspace = resolveWorkspace(parsed.workspaceArg);
  if (!workspace) {
    writeErr('msg-poll: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const intervalMs = (parseInt(parsed.intervalArg || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;

  // ── 書き込み連続失敗の警告（Issue #250） ─────────────────────────────
  // markReadMany の失敗（他プロセスが msg-state を掴んでいる等の EPERM）は次のサイクルで
  // 再試行されるが、連続失敗が続くと既読がディスクに永続化されないまま通知が重複しうる。
  // 閾値（5回≒約100秒）に達したら orchestrator へ警告する。失敗が1回でも成功すれば
  // カウンタはリセットされ、警告は再び閾値分の連続失敗が積もるまで再送されない。
  // 送信先 Issue は worker モードでは監視対象（--issue）、orchestrator モードでは
  // orchestrator 自身は Issue を持たないため workers.json の先頭ワーカーを使う。
  const writeFailureMonitor = createWriteFailureMonitor({
    notify: ({ count, detail }) => {
      const issue = resolveNotifyIssue();
      const body = `⚠️ msg-poll の既読状態の書き込みが ${count} 回連続で失敗しています（他プロセスが msg-state を掴んでいる可能性）。最新のエラー: ${detail}`;
      if (!issue) {
        writeErr(`msg-poll: 書き込み連続失敗の警告を送信できません（送信先Issueがありません）: ${body}`);
        return;
      }
      let res;
      try {
        res = _notifyOrchestrator({ workspace, issue, body });
      } catch (e) {
        writeErr(`msg-poll: 書き込み連続失敗の警告の送信に失敗: ${e.message}`);
        return;
      }
      if (res.status !== 0) {
        writeErr(`msg-poll: 書き込み連続失敗の警告の送信に失敗: ${(res.stderr || '').trim()}`);
      }
    },
  });

  function resolveNotifyIssue() {
    if (issueArg) return String(issueArg);
    if (!isOrchestrator) return null;
    try {
      const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
      if (fs.existsSync(workersPath)) {
        const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
        const first = Object.values(workers || {}).find((w) => w && w.issue);
        if (first && first.issue) return String(first.issue);
      }
    } catch {}
    return null;
  }

  // ── セッションPID解決（dead-man's switch） ────────────────────────────

  const sessionPid = resolveSessionPid(parsed.sessionPidArg);

  // PID再利用検知のため、起動時に親セッションの起動時刻を捕捉する（best-effort。
  // 取得失敗時は expectedStartTime=null となり isProcessAlive のみの従来判定にフォールバック）。
  const expectedStartTime = getProcessStartTime(sessionPid);

  // ── 常駐プロセス用 role lease（Issue #240） ───────────────────────────
  // 継続モード・--wait モードのみ排他する（--once は読み取り専用の一回実行のため）。
  // 取得は resolveWorkspace 直後・gh 呼び出しより前に行い、多重起動時は無駄な外部呼び出しを
  // 避けて即拒否する。workspace 表記の差異（大文字小文字・末尾スラッシュ等）でもすり抜けない
  // よう、role lease は workspace を canonicalWorkspace で正規化して排他する（Issue #240）。
  // role は親セッション死亡時の lease 解放（handleParentSessionDeath）でも参照するため
  // --once でも算出する（lease 未取得なら解放は no-op）。
  const role = `msgpoll-${self}`;
  let residentLease = null;
  if (!onceMode) {
    const handoffTargets = () => {
      const workerNameForRegistry = self !== 'orchestrator' ? self : null;
      const dup = findRunningInstance(workspace, { script: 'msg-poll.js', workerName: workerNameForRegistry });
      return dup ? [dup.pid] : [];
    };
    try {
      const res = acquireResidentLease({ workspace, role, handoff: force, handoffStopTargets: handoffTargets });
      if (!res.acquired) {
        // 引き継ぎ期限超過（--force で既存所有者が終了しなかった）
        writeErr(
          `msg-poll: role "${role}" を引き継げませんでした（${res.reason}）` +
          (res.ownerPid ? `。既存プロセス pid=${res.ownerPid} が終了しません` : '') +
          `。既存のMonitorを使い回すか、--force を再指定してください。`
        );
        return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode, intervalMs, residentLease: null };
      }
      residentLease = res;
    } catch (e) {
      // live lease による拒否。--watch-pid による監視コマンドを案内する。
      writeErr(`msg-poll: 重複起動を検出しました。${e.message}`);
      const pidMatch = /pid (\d+)/.exec(e.message);
      if (pidMatch) {
        const ownerPid = parseInt(pidMatch[1], 10);
        writeErr('代わりに以下をMonitorでpersistent:trueとして起動してください（このコマンドをそのまま使うこと。判断は不要）:');
        writeErr(`  ${buildWatchPidCommand(ownerPid)}`);
        writeErr(
          `このコマンドは pid=${ownerPid} の生存を監視し続け、死亡時に \`PID_DIED:${ownerPid}\` を通知します。` +
          'その通知を受け取ったら、そのときはじめて改めてこのコマンドを --force なしで起動し直してください。'
        );
      }
      return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode, intervalMs, residentLease: null };
    }
  }

  // ── リポジトリ解決 ──────────────────────────────────────────────────

  const ghOpts = { cwd: workspace };
  const repoResult = _ghRepoView(ghOpts);
  if (repoResult.status !== 0) {
    writeErr(`msg-poll: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0, residentLease };
  }
  const repo = repoResult.stdout.trim();

  // ── カーソル読み込み ─────────────────────────────────────────────────

  const state = readState(workspace, self);

  // ── dead-man's switch: 毎周回で親セッションの生存を確認 ──────────
  // expectedStartTime（起動時に捕捉）を渡し、同じ PID に別プロセスが再利用された場合も
  // 死と判定できるようにする（isProcessAlive のみの判定にしない）。

  const checkParent = _createDeadManSwitch(sessionPid, { expectedStartTime });

  /**
   * 1回のスキャン。
   *
   * 既読判定は時刻カーソルではなく、明示的に既読化されたコメントID集合
   * （readState の readByIssue）で行う（Issue #207）。gh api の since は取得範囲の
   * 絞り込み（パフォーマンス最適化）にのみ使い、ウォーターマーク（sinceByIssue）の
   * 1秒前から差分取得する。取りこぼしは「1秒の安全マージン」「持ち越しがある間は
   * ウォーターマークを進めない」「取得失敗時は進めない（フェイルクローズ）」で構造的に
   * 防ぐ。既読判定は常に ID 集合との照合で行う。
   *
   * @param {{ maxGhTimeoutMs?: number, singleMessage?: boolean }} [opts]
   *   maxGhTimeoutMs: gh 呼び出しの上限タイムアウト（ms）。
   *   --wait モードで締切間際に呼ばれた場合、既定の GH_TIMEOUT_MS（30秒）を待つと
   *   --wait で指定した秒数を大幅に超過しうるため、残り時間に応じて上限を絞り込む。
   *   （最低 1000ms は確保する。0 以下を spawnSync の timeout に渡すとタイムアウトが
   *   無効化されてしまうため）
   *   singleMessage: true の場合、新着が複数件あっても最も古い1件のみを
   *   NEW_MESSAGE として出力・既読化する（--wait モード専用）。残り（持ち越し）は
   *   既読記録せず、次回呼び出しで改めて検出される（全件再取得のため消失しない）。
   */
  function scanOnce(opts = {}) {
    const { maxGhTimeoutMs, singleMessage = false } = opts;
    const callOpts = maxGhTimeoutMs != null
      ? { cwd: workspace, timeout: Math.min(GH_TIMEOUT_MS, Math.max(1000, maxGhTimeoutMs)) }
      : ghOpts;

    // dead-man's switch: 親が死んでいたら cleanup して非ゼロ終了（exit 3）
    // exit 3 = 親セッション消滅。exit 0 にすると正常終了扱いとなり、Monitor の異常終了
    // アラーム経路と watchdog 通知が両方無効化される（Issue #301）。
    // stdout は Monitor 通知チャンネルなので使わず、理由は lease 解放とともに
    // handleParentSessionDeath が stderr へ出す。
    if (!checkParent()) {
      lifecycleCleanup(workspace);
      handleParentSessionDeath({ workspace, scriptName: 'msg-poll.js', role, sessionPid });
      _parentDeathExit(PARENT_DEATH_EXIT_CODE);
    }

    // ── 監査イベントの処理（orchestrator のみ） ────────────────────────
    // 常駐プロセスの role lease で発生した lock-denied / handoff-wait を読み出し、
    // 処理済み化（削除）してから stdout に出力する。GitHub への投稿はしない
    // （投稿判断は orchestrator 側）。出力 → 削除の順で、クラッシュ時は重複出力側に倒れる。
    // 消費は role lease 保持モード（継続 / --wait）だけに限定する。--once は lease を
    // 取得せず、共有キューを読むと削除前に同じイベントを他プロセスと読み合って
    // 重複出力しうる（Issue #240 レビュー指摘）。
    // --wait（singleMessage）では監査行の出力を「新着検出」と誤判定させないため除外する。
    if (isOrchestrator && !singleMessage && residentLease !== null) {
      // 監査イベントの読み出し・削除はファイルI/Oを伴うため失敗しうる（Issue #289）。
      // ここで例外が未捕捉だと setInterval コールバックまで漏れて常駐プロセスが exit 1 で
      // 崩壊し、orchestrator の inbox 監視が静かに停止する。捕捉して stderr に出し、
      // このサイクルをスキップして継続する（次サイクルで再試行される）。
      try {
        const events = listUnprocessedResidentAuditEvents(workspace);
        for (const { file, event } of events) {
          const ownerPid = event.detail && event.detail.ownerPid != null ? `:${event.detail.ownerPid}` : '';
          writeOut(`${event.type === 'lock-denied' ? 'LOCK_DENIED' : 'HANDOFF_WAIT'}:${event.role}${ownerPid}`);
          removeResidentAuditEvent(workspace, file);
        }
      } catch (e) {
        writeErr(`msg-poll: 監査イベントの処理に失敗しました（次サイクルで再試行）: ${e.message}`);
      }
    }

    // ── 既読状態の読み込み（v2・ID正本） ────────────────────────────────
    const stateResult = readState(workspace, self);
    let state;
    if (isOrchestrator) {
      // orchestrator は空状態を暗黙作成しない。欠落・破損・旧形式は走査を停止して
      // 「明示初期化（reset-session.js）が必要」と報告する（Issue #207）。
      if (stateResult.status === 'missing' || stateResult.status === 'corrupt') {
        writeErr(`msg-poll: orchestrator msg-state が未初期化です（${stateResult.status}）。reset-session.js で初期化してください。`);
        return;
      }
      if (stateResult.status === 'legacy') {
        writeErr('msg-poll: orchestrator msg-state が旧形式(v1)です。reset-session.js で移行（再ベースライン）してください。');
        return;
      }
      state = stateResult.state;
    } else {
      // worker モード（レガシー経路。inbox-supervisor.js に置き換え済み）:
      // 欠落・破損時は空状態で初期化して再通知する従来挙動を維持する（Q3承認）。
      // 後段の markReadMany が state の初期化を要求するため、ここで明示的に初期化する。
      if (stateResult.status === 'ok') {
        state = stateResult.state;
      } else {
        let initState;
        if (stateResult.status === 'legacy') {
          // 旧形式の既通知ID（seenIds）を既読集合へ引き継ぐ
          const legacySeen = Array.isArray(stateResult.state && stateResult.state.seenIds) ? stateResult.state.seenIds : [];
          initState = readStateLib.initializeState(workspace, self, {
            byIssue: { [String(issueArg)]: legacySeen.filter((x) => typeof x === 'number' && Number.isFinite(x)) },
            generation: 'legacy-migration',
          });
        } else {
          initState = readStateLib.initializeState(workspace, self, {
            byIssue: {},
            generation: 'worker-init',
          });
        }
        if (!initState.ok) {
          writeErr(`msg-poll: worker msg-state の初期化に失敗しました: ${initState.error}`);
          return;
        }
        state = initState.state;
      }
    }

    // 既読集合を Issue ごとの Set として引き出しておく（O(1) 照合用）
    const readIdsByIssue = new Map();
    for (const [issue, ids] of Object.entries(state.readByIssue || {})) {
      readIdsByIssue.set(issue, new Set(ids));
    }

    // ── コメントの全件取得 ──────────────────────────────────────────────
    // since は使わない（既読判定から外す。Issue #207）
    let allIssuesAndComments = [];

    if (isOrchestrator) {
      const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
      let workers = {};
      try {
        if (fs.existsSync(workersPath)) {
          const raw = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            workers = raw;
          }
        }
      } catch {
        // workers.json が読めない・parse できない → 空扱いで継続
      }

      const issues = new Set();
      for (const entry of Object.values(workers)) {
        if (entry && typeof entry === 'object' && entry.issue) {
          issues.add(String(entry.issue));
        }
      }

      for (const issue of issues) {
        // 取得範囲の絞り込み（パフォーマンス最適化）: sinceByIssue（ウォーターマーク）の
        // 1秒前から取得する。既読判定には使わない（既読判定は常にID集合で行う。Issue #207）。
        // 取得失敗時はウォーターマークが進まないため、次サイクルで同じ範囲を再取得する
        // （フェイルクローズ。黙って古いコメントを見逃さない）。
        const watermark = typeof state.sinceByIssue[issue] === 'string' ? state.sinceByIssue[issue] : null;
        const fetchSince = watermark ? addSeconds(watermark, -1) : null;
        const result = _ghApiComments(repo, issue, fetchSince, callOpts);
        if (result.status !== 0) {
          const errMsg = result.error && result.error.code === 'ETIMEDOUT'
            ? `gh api タイムアウト (issue ${issue})`
            : `gh api エラー (issue ${issue}): ${result.stderr || result.error?.message || '(empty)'}`;
          writeErr(`msg-poll: ${errMsg}`);
          continue;
        }
        let comments;
        try {
          comments = parseCommentsResponse(result.stdout);
        } catch {
          writeErr(`msg-poll: JSON parse エラー (issue ${issue})`);
          continue;
        }
        if (comments === null) {
          writeErr(`msg-poll: gh api の応答が配列ではありません (issue ${issue})`);
          continue;
        }
        for (const c of comments) {
          allIssuesAndComments.push({ issue, comment: c });
        }
      }
    } else {
      // worker モードも取得最適化カーソル（1秒前から）で絞り込む
      const workerKey = String(issueArg);
      const workerWatermark = typeof state.sinceByIssue[workerKey] === 'string' ? state.sinceByIssue[workerKey] : null;
      const workerFetchSince = workerWatermark ? addSeconds(workerWatermark, -1) : null;
      const result = _ghApiComments(repo, issueArg, workerFetchSince, callOpts);
      if (result.status !== 0) {
        const errMsg = result.error && result.error.code === 'ETIMEDOUT'
          ? 'gh api タイムアウト'
          : `gh api エラー: ${result.stderr || result.error?.message || '(empty)'}`;
        writeErr(`msg-poll: ${errMsg}`);
        return;
      }
      let comments;
      try {
        comments = parseCommentsResponse(result.stdout);
      } catch {
        writeErr('msg-poll: JSON parse エラー');
        return;
      }
      if (comments === null) {
        writeErr('msg-poll: gh api の応答が配列ではありません');
        return;
      }
      for (const c of comments) {
        allIssuesAndComments.push({ issue: issueArg, comment: c });
      }
    }

    // ── 新着候補の抽出（ID正本。時刻・初回スキャンによる既読推測はしない） ──
    // 各コメントの ID を既読集合と照合し、未記録のものは「なぜ通知しないか」を
    // 分類した上で既読として明示記録する。これにより毎走査の再処理を避ける。

    const candidatesByIssue = new Map(); // issue -> [{ cid, created_at, issue }]
    const recordReadByIssue = new Map(); // issue -> Set<number>（今回記録する既読ID）
    const maxCreatedByIssue = new Map(); // 診断用 sinceByIssue（既読判定には使わない）

    for (const { issue, comment: c } of allIssuesAndComments) {
      const issueKey = String(issue);
      const cid = c.id;
      if (cid == null) continue; // ID 欠落は記録不能（GitHub では発生しない想定）

      // 診断用の max created_at（全コメント対象）
      if (c.created_at) {
        const cur = maxCreatedByIssue.get(issueKey);
        if (!cur || c.created_at > cur) maxCreatedByIssue.set(issueKey, c.created_at);
      }

      const readIds = readIdsByIssue.get(issueKey);
      if (readIds && readIds.has(cid)) continue; // 既読 → 重複として無視

      // created_at 欠落は候補から除外し、既読として記録（毎走査の再処理を避ける）
      if (!c.created_at) {
        addRecord(recordReadByIssue, issueKey, cid);
        continue;
      }

      const meta = parseMarker(c.body);
      if (!meta) {
        addRecord(recordReadByIssue, issueKey, cid); // マーカーなし → 既読記録
        continue;
      }
      if (meta.to !== self) {
        addRecord(recordReadByIssue, issueKey, cid); // 自分宛てでない → 既読記録
        continue;
      }

      if (!candidatesByIssue.has(issueKey)) candidatesByIssue.set(issueKey, []);
      candidatesByIssue.get(issueKey).push({ cid, created_at: c.created_at, issue: issueKey });
    }

    const allCandidates = [];
    for (const arr of candidatesByIssue.values()) allCandidates.push(...arr);
    allCandidates.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.cid - b.cid;
    });

    // singleMessage: 最も古い1件のみを出力・既読化する。残り（持ち越し）は既読記録しない。
    const emitted = singleMessage ? allCandidates.slice(0, 1) : allCandidates;
    const emittedIds = new Set(emitted.map((e) => e.cid));

    for (const e of emitted) {
      if (isOrchestrator) {
        writeOut(`NEW_MESSAGE:${e.issue}:${e.cid}`);
      } else {
        writeOut(`NEW_MESSAGE:${e.cid}`);
      }
    }

    // 持ち越し候補（未出力）がある Issue は、ウォーターマークを進めない。
    // 進めると since ベースの取得範囲から持ち越し分が消え、永久に再取得できなくなる
    // （--wait / singleMessage 契約を壊す）。次サイクルで同じ範囲を再取得する。
    const issuesWithDeferred = new Set();
    for (const [issue, arr] of candidatesByIssue) {
      if (arr.some((e) => !emittedIds.has(e.cid))) {
        issuesWithDeferred.add(issue);
      }
    }

    // ── 既読の永続化 ───────────────────────────────────────────────────
    // 通知（出力）した ID と、通知しないことが明示されている ID を記録する。
    // 出力 → 記録の順で、クラッシュ時は「重複通知」側に倒れる（握り潰しはしない）。
    // 持ち越し候補（singleMessage で未出力のもの）は記録しない。
    for (const e of emitted) {
      addRecord(recordReadByIssue, e.issue, e.cid);
    }

    const byIssue = {};
    for (const [issue, ids] of recordReadByIssue) {
      byIssue[issue] = [...ids];
    }
    const sinceByIssue = {};
    for (const [issue, ts] of maxCreatedByIssue) {
      if (issuesWithDeferred.has(issue)) continue;
      sinceByIssue[issue] = ts;
    }
    // 既読の永続化は他プロセスが msg-state を掴んでいる等で EPERM 失敗しうる（Issue #250）。
    // 例外はここで捕捉して常駐プロセスを止めず、次サイクルで再試行する。NEW_MESSAGE は
    // 既に出力済みなので、失敗時は「重複通知」側に倒れる（握り潰しはしない）。
    let markErrorDetail = null;
    try {
      const markResult = readStateLib.markReadMany(workspace, self, { byIssue, sinceByIssue });
      if (!markResult.ok) {
        markErrorDetail = markResult.error;
      }
    } catch (e) {
      writeErr(`msg-poll: 既読状態の更新で例外が発生しました: ${e.message}`);
      markErrorDetail = e.message;
      writeFailureMonitor.onFailure(markErrorDetail);
      return;
    }
    if (markErrorDetail != null) {
      writeErr(`msg-poll: 既読状態の更新に失敗しました: ${markErrorDetail}`);
      writeFailureMonitor.onFailure(markErrorDetail);
    } else {
      writeFailureMonitor.onSuccess();
    }
  }

  return {
    code: 0,
    lines: out,
    errLines: err,
    scanOnce,
    onceMode,
    intervalMs,
    workspace,
    sessionPid,
    self,
    force,
    waitMode,
    waitMs,
    residentLease,
    issueArg,
  };
}

// ── --wait モード ────────────────────────────────────────────────────────

// orchestrator への書き込み連続失敗の警告（Issue #250）。テストで注入可能。
// inbox-supervisor.js の _notifyOrchestrator と同型。msg-send.js は本文を位置引数で
// 受け付けない（--stdin / --body-file のみ）ため、spawnSync の input で stdin 経由に渡す。
let _notifySpawn = spawnSync;
let _notifyOrchestrator = ({ workspace, issue, body }) => {
  // 非ワーカーコンテキストの msg-send.js は宛先を位置引数（recipient）で受け取る。
  // 省略すると recipient が undefined になり usage エラーで必ず送信失敗する（PR #251 レビュー指摘）。
  return _notifySpawn(process.execPath, [
    path.join(__dirname, 'msg-send.js'),
    'orchestrator',
    '--stdin',
    '--from', 'msg-poll',
    '--issue', issue,
    '--workspace', workspace,
  ], { encoding: 'utf8', input: body });
};

let _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * --wait モード: 新着メッセージを検出するか waitMs が経過するまで、
 * scanOnce を intervalMs 間隔でリトライする。
 *
 * @param {{ scanOnce: (opts?: { maxGhTimeoutMs?: number, singleMessage?: boolean }) => void, lines: string[], intervalMs: number, waitMs: number }} result
 *   main() の戻り値（waitMode: true のもの）
 * @returns {Promise<boolean>} 新着を検出すれば true、タイムアウトなら false
 */
async function runWaitMode(result) {
  const { scanOnce, lines, intervalMs, waitMs } = result;
  const start = Date.now();
  while (true) {
    const before = lines.length;
    // gh 呼び出しの上限を残り時間に絞り、--wait の締切超過を最小化する
    const remainingForGh = Math.max(0, waitMs - (Date.now() - start));
    // --wait は1回の呼び出しで常に高々1件しか返さない契約（Issue #99）
    scanOnce({ maxGhTimeoutMs: remainingForGh, singleMessage: true });
    if (lines.length > before) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= waitMs) return false;
    const remaining = waitMs - elapsed;
    await _sleep(Math.min(intervalMs, remaining));
  }
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  // ── --watch-pid: 既存の生存プロセスを監視するだけの軽量モード ──────────
  // <self> 等の他の引数を必要としない、完全に独立したモード。
  // 「重複起動を検出しました」時の代替コマンドとして案内される。
  if (rawArgs.includes('--watch-pid')) {
    let watchValues, watchRest;
    try {
      ({ values: watchValues, rest: watchRest } = parseFlags(rawArgs, {
        flags: { '--watch-pid': {}, '--interval': {} },
        booleans: [],
        // watch-pid モードは位置引数を取らない。余剰な位置引数・未知フラグは黙って無視しない
        // （パーサ側で拒否。argv-parsing-pitfalls参照）。
        positionals: { min: 0, max: 0 },
      }));
    } catch (err) {
      if (err.name !== 'ArgsValidationError') throw err;
      for (const e of err.errors) process.stderr.write(`msg-poll: ${e.message}\n`);
      process.exit(1);
    }
    const watchPid = parseInt(watchValues['--watch-pid'], 10);
    if (!Number.isFinite(watchPid) || watchPid <= 0) {
      process.stderr.write(`msg-poll: --watch-pid には正の整数のPIDを指定してください: ${watchValues['--watch-pid']}\n`);
      process.exit(1);
    }
    const watchIntervalMs = (parseInt(watchValues['--interval'] || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;

    // PID再利用検知のため、監視開始時に捕捉した起動時刻を dead-man's switch に渡す。
    // 監視対象の PID が別プロセスに再利用された場合も即 PID_DIED を発火し、古いプロセスを
    // 追いかけ続けることを防ぐ。実体が消えた場合は3周回連続で確認してから通知する
    // （一過性の誤検出で PID_DIED を出さない。false positive は orchestrator の再起動を
    // 誘導するため、通知は遅くても正しく倒す）。
    const watchStartTime = getProcessStartTime(watchPid);
    const checkWatchedPid = _createDeadManSwitch(watchPid, { expectedStartTime: watchStartTime });
    const emitWatchResult = () => {
      if (!checkWatchedPid()) {
        process.stdout.write(`PID_DIED:${watchPid}\n`);
        process.exit(0);
      }
    };
    emitWatchResult();
    const watchIntervalHandle = setInterval(emitWatchResult, watchIntervalMs);
    process.on('SIGINT', () => { clearInterval(watchIntervalHandle); process.exit(0); });
    process.on('SIGTERM', () => { clearInterval(watchIntervalHandle); process.exit(0); });
    return;
  }

  // main() と同じ parseArgs() を再利用する（解析ロジックを2箇所に分けない）。
  const parsedForCli = parseArgs(rawArgs);
  // 検証エラー（未知引数・値欠落等）がある場合は main() がエラー終了するため、
  // 多重起動プリフライトのロック取得・gh解決などの副作用を走らせない（不正引数で
  // 素早く fail-fast する）。
  const hasValidationErrors = !parsedForCli.help && parsedForCli.validationErrors != null;
  const isWait = !parsedForCli.help && !hasValidationErrors && !parsedForCli.onceMode && parsedForCli.waitArg != null;
  const isContinuous = !parsedForCli.help && !hasValidationErrors && !parsedForCli.onceMode && !isWait;

  // 継続モード・--wait モードでは scanOnce の出力をリアルタイムに stdout へ流す
  const result = main(undefined, { streamOutput: isContinuous || isWait });

  // role lease の解放は main() の成功・失敗を問わず、全 exit 経路で行う。
  // main() が lease を取得していない（help・エラー・--once）場合は null で no-op。
  function releaseResidentLease() {
    if (result.residentLease && typeof result.residentLease.release === 'function') {
      result.residentLease.release();
    }
  }

  // 初期エラー／help はここで出力
  for (const l of result.errLines) process.stderr.write(l + '\n');

  if (result.code !== 0) {
    releaseResidentLease();
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(result.code);
  }

  if (result.scanOnce === null) {
    // --help
    releaseResidentLease();
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  const sc = result.scanOnce;

  if (result.onceMode) {
    releaseResidentLease();
    sc();
    // streamOutput が false なので lines/errLines に収集されている。
    // scanOnce 内のエラー（未初期化報告等）も stderr に出して黙殺しない。
    for (const l of result.errLines) process.stderr.write(l + '\n');
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  // 常駐監視（継続モード・--wait モード）の異常終了（非ゼロexit）を orchestrator へ通知する
  // （Issue #289 受け入れ条件3）。起動時エラー・--help・--once の早期 exit は上で既に
  // return/exit 済みのため、ここに到達するのは resident な監視だけ。正常終了（exit 0 =
  // SIGINT/SIGTERM/親セッション消滅/--wait 完了）では何もしない。
  // 通知先は worker モードの監視対象 Issue（issueArg）を明示する。workers.json の先頭ワーカー
  // 推測フォールバックに落とすと、別 Issue へ誤配送されたり宛先不明で破棄されたりして
  // 監視停止が待機側へ届かない（Issue #289 レビュー指摘）。orchestrator 専用モードなど
  // Issue が本当に無い場合だけ、ヘルパー側のフォールバックが使われる。
  process.on('exit', () => { notifyWatchdogExit({ workspace: result.workspace, scriptName: 'msg-poll.js', issue: result.issueArg }); });

  // ── PID registry に自己登録（継続モード・--wait モード） ────────────
  // worker モードの場合は workerName を含めて登録する。
  // これにより remove-worker.js の sweep が entry.workerName でマッチできる。
  // （registry は表示・診断用途。排他の正本は role lease であり、これは二重化しない）

  registerProcess(result.workspace, {
    script: 'msg-poll.js',
    workerName: result.self !== 'orchestrator' ? result.self : null,
  });

  if (result.waitMode) {
    // --wait モード: 新着検出 or タイムアウトのいずれか早い方で exit 0 する。
    // streamOutput が true なので scanOnce の出力は直接 stdout へ出る。
    function cleanupWait() {
      lifecycleCleanup(result.workspace);
      releaseResidentLease();
    }

    process.on('SIGINT', () => { cleanupWait(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupWait(); process.exit(0); });

    runWaitMode(result).then(() => {
      cleanupWait();
      process.exit(0);
    });

    return;
  }

  // 継続モード: streamOutput が true なので scanOnce の出力は直接 stdout へ出る
  let intervalHandle = null;

  function cleanup() {
    if (intervalHandle) clearInterval(intervalHandle);
    lifecycleCleanup(result.workspace);
    releaseResidentLease();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  sc();
  intervalHandle = setInterval(sc, result.intervalMs);
  // interval は unref しない — イベントループを維持する
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhApiComments: (fn) => { _ghApiComments = fn; },
  _setSleep: (fn) => { _sleep = fn; },
  _setNotifyOrchestrator: (fn) => { _notifyOrchestrator = fn; },
  // 実装を直接参照（テストが注入を戻す際の復元用。PR #251 の引数検証テストから使う）
  _notifyOrchestrator,
  _setNotifySpawn: (fn) => { _notifySpawn = fn; },
  _setCreateDeadManSwitch: (fn) => { _createDeadManSwitch = fn; },
  _setParentDeathExit: (fn) => { _parentDeathExit = fn; },
  main,
  runWaitMode,
  // 内部ロジックの単体テスト用
  parseArgs,
  parseMarker,
  parseCommentsResponse,
  readState,
  writeState,
  statePath,
  buildWatchPidCommand,
  MARKER_RE,
  USAGE,
};
