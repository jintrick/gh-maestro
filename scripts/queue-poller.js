#!/usr/bin/env node
// queue-poller.js — ファイルシステムキューの pending 監視と pane 通知
//
// workspace ごとに 1 プロセス。inbox/ を監視し、pending を検出して
// 宛先 pane に通知を送る。ack が来ない pending には再通知し、
// 閾値超過で orchestrator の inbox にエスカレートメッセージを送る。
//
// Usage:
//   node queue-poller.js [--workspace <path>]
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { enqueue, listPending, pruneAcked } = require('./queue');
const { notifyPane } = require('./pane-notify');
const { weztermCli } = require('./wezterm-cli');

// ── 閾値（先頭定数） ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;       // 定期スキャン間隔（ms）
const STALE_HEARTBEAT_MS = 15000;    // heartbeat がこの時間超で stale
const RE_NOTIFY_INTERVAL_MS = 120000; // 再通知間隔（ms）
const STUCK_THRESHOLD_MS = 600000;   // 10分 - この時間超で escallation
const PRUNE_INTERVAL_MS = 3600000;   // 1時間 - prune の実行間隔
const PRUNE_MAX_AGE_MS = 86400000;   // 24時間 - acked メッセージの保持期間
const MAX_MUX_CHECK_FAILURES = 3;    // 連続 mux 到達性失敗で degraded モードへ遷移

const USAGE = `queue-poller.js — キュー pending 監視と pane 通知

Usage: node queue-poller.js [options]

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

poller は workspace ごとに 1 プロセス起動される。二重起動防止には poller.json の
atomic 作成（wx）＋ stale heartbeat 乗っ取りを使用する。
起動は lazy-start: queue-send.js が enqueue 後に stale 検出して spawn する。`;

// ── mux 識別子 ──────────────────────────────────────────────────────────

/**
 * 現在の WezTerm mux セッションの識別子を返す。
 * WEZTERM_UNIX_SOCKET は wezterm プロセス（mux）ごとに一意であり、
 * ターミナル再起動を跨ぐと変化する。これにより「旧 mux に取り残された poller」を検出できる。
 *
 * @returns {string|null} 識別子、または取得不能時 null
 */
function getMuxId() {
  return process.env.WEZTERM_UNIX_SOCKET || null;
}

/**
 * 現在のプロセスから WezTerm mux への到達性を検証する。
 * WEZTERM_MOCK env があればモックスクリプトを使う（テスト用）。
 *
 * @returns {boolean} wezterm cli list が成功すれば true
 */
function checkMuxReachable() {
  try {
    const result = weztermCli('cli', 'list', '--format', 'json');
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── poller.json 管理 ────────────────────────────────────────────────────

function pollerJsonPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'queue', 'poller.json');
}

/**
 * poller.json の lease を取得する（二重起動防止 + stale 乗っ取り）。
 * このロジックは queue-send.js（lazy-start）と共用するため、payload を引数で受け取る。
 *
 * @param {string} workspace  ワークスペース絶対パス
 * @param {string} payload    poller.json に書き込む JSON 文字列
 * @returns {boolean}  この呼び出し元が poller を起動/続行すべきなら true
 */
function acquirePollerLease(workspace, payload) {
  const pPath = pollerJsonPath(workspace);
  fs.mkdirSync(path.dirname(pPath), { recursive: true });

  // 1. atomic 作成（wx）を試みる
  try {
    fs.writeFileSync(pPath, payload, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // 2. EEXIST: 既存の poller.json を読んで stale 判定
  try {
    const existing = JSON.parse(fs.readFileSync(pPath, 'utf8'));
    // pid===0 は lazy-start のプレースホルダー → 即乗っ取り
    const isPlaceholder = !existing.pid || existing.pid === 0;
    const elapsed = Date.now() - (existing.heartbeat || 0);

    // muxId 不一致チェック: 両方とも存在し、かつ異なる値 かつ 既存 poller が
    // 自己申告で degraded (muxReachable===false) の場合のみ stale と同等に扱う。
    // muxReachable===true の健全 poller は muxId が違っても殺さない（クロスターミナル DoS 防止）。
    // muxReachable が未定義（旧フォーマット）の場合は後方互換のためスキップ。
    const currentMuxId = getMuxId();
    const existingMuxId = existing.muxId || null;
    const muxMismatch = currentMuxId && existingMuxId && currentMuxId !== existingMuxId;
    const degradedAndMismatch = muxMismatch && existing.muxReachable === false;

    if (!isPlaceholder && elapsed < STALE_HEARTBEAT_MS && !degradedAndMismatch) {
      // 別プロセスが生きている → 退出
      return false;
    }
    // stale: 乗っ取り
    // 既存プロセスを kill してから乗っ取る（pid>0 かつ自プロセスでない場合のみ）
    if (existing.pid && existing.pid > 0 && existing.pid !== process.pid) {
      try { process.kill(existing.pid, 0); } catch { /* 既に死んでいる */ }
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* best-effort */ }
    }
    fs.writeFileSync(pPath, payload, 'utf8');
    return true;
  } catch {
    // 読み取りエラー → 上書き
    try { fs.writeFileSync(pPath, payload, 'utf8'); } catch {}
    return true;
  }
}

/**
 * poller プロセスとしての lease 取得。
 * acquirePollerLease を自プロセスの pid で呼ぶ薄いラッパー。
 *
 * @returns {boolean} このプロセスがプライマリ poller として続行すべきなら true
 */
function claimPoller(workspace) {
  const payload = JSON.stringify({
    pid: process.pid,
    heartbeat: Date.now(),
    startedAt: new Date().toISOString(),
    muxId: getMuxId(),
    muxReachable: true, // 起動直後は健全と仮定（初回スキャンで検証される）
  });
  return acquirePollerLease(workspace, payload);
}

/**
 * heartbeat を更新する。muxReachable が渡された場合はあわせて書き込む。
 *
 * @param {string}  workspace
 * @param {boolean} [muxReachable]  現在の mux 到達性（未指定時は既存値を維持）
 */
function updateHeartbeat(workspace, muxReachable) {
  try {
    const existing = JSON.parse(fs.readFileSync(pollerJsonPath(workspace), 'utf8'));
    existing.heartbeat = Date.now();
    if (muxReachable !== undefined) {
      existing.muxReachable = muxReachable;
    }
    fs.writeFileSync(pollerJsonPath(workspace), JSON.stringify(existing), 'utf8');
  } catch {
    // 書き込み失敗は無視（次のスキャンで再試行）
  }
}

/**
 * poller.json を削除してロックを解放する。
 */
function releasePoller(workspace) {
  try { fs.unlinkSync(pollerJsonPath(workspace)); } catch {}
}

// ── last-notified 永続化 ─────────────────────────────────────────────────

function pollerStatePath(workspace) {
  return path.join(workspace, '.gh-maestro', 'queue', 'poller-state.json');
}

/**
 * poller-state.json を tmp→rename でアトミックに書き込む。
 *
 * @param {string} workspace  ワークスペース絶対パス
 * @param {Map<string,number>} lastNotifiedAt  messageId → 最終通知時刻（ms）
 */
function writeLastNotifiedState(workspace, lastNotifiedAt) {
  const statePath = pollerStatePath(workspace);
  const tmpDir = path.join(path.dirname(statePath), 'tmp');

  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  const obj = {};
  for (const [mid, ts] of lastNotifiedAt) {
    obj[mid] = ts;
  }
  const payload = JSON.stringify({ lastNotifiedAt: obj });

  const tmpPath = path.join(tmpDir, 'poller-state.json.' + Date.now());
  try {
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, statePath);
  } catch {
    // best-effort: 書き込み失敗は無視（次回 scan で再試行）
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * poller-state.json を読み取る（他プロセスからの参照用）。
 *
 * @param {string} workspace  ワークスペース絶対パス
 * @returns {{ lastNotifiedAt: Record<string,number> }|null}
 */
function readLastNotifiedState(workspace) {
  const statePath = pollerStatePath(workspace);
  try {
    if (!fs.existsSync(statePath)) return null;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed.lastNotifiedAt === 'object') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ── 通知テンプレート ────────────────────────────────────────────────────

/**
 * 中身ゼロの wake 信号を返す。
 * 受信側は poll-inbox.js で FS を pull し SSOT ファイルを自分で読むため、
 * 業務本文・定型文を含まない wake 信号のみを送る。
 * wezterm send-text はレイテンシ最適化のヒントに過ぎず、pull が唯一の配送根拠。
 */
function buildWakeSignal() {
  return '';
}

// ── メインループ ────────────────────────────────────────────────────────

function runPoller(workspace) {
  const inboxRoot = path.join(workspace, '.gh-maestro', 'queue', 'inbox');

  // lastNotifiedAt: messageId → Date.now()
  const lastNotifiedAt = new Map();

  // stuckEscalated: messageId → boolean （再エスカレート防止）
  const stuckEscalated = new Set();

  // lastPruneTime: 前回 pruneAcked を実行した時刻
  let lastPruneTime = Date.now();

  // muxReachable: 現在の mux 到達性（degraded モード管理用）
  // muxConsecutiveFailures: mux 到達性チェックの連続失敗回数
  let muxReachable = true;
  let muxConsecutiveFailures = 0;

  /**
   * 1回のスキャン実行。
   * pending を検出し、宛先ごとに通知・再通知・エスカレートを処理する。
   */
  function scan() {
    // heartbeat 更新（muxReachable もあわせて永続化）
    updateHeartbeat(workspace, muxReachable);

    const now = Date.now();

    // mux 到達性の自己検証: 連続失敗で degraded モードへ遷移し、
    // poller.json に muxReachable:false を書く。一過性なら自動復帰。
    // 自主 exit はしない — 次の enqueue lazy-start が degraded poller を
    // muxId 不一致 + muxReachable===false の条件で正当に交代する。
    //
    // getMuxId() が null の環境（WezTerm 外、CI/CD 等）では mux-check を
    // スキップする。WEZTERM_UNIX_SOCKET が無い環境では wezterm cli list が
    // 常に失敗するため、チェックすると正常な poller が誤って degraded になる。
    if (getMuxId() !== null) {
      if (checkMuxReachable()) {
        muxConsecutiveFailures = 0;
        if (!muxReachable) {
          muxReachable = true;
          process.stderr.write('[poller] mux reachable again: leaving degraded mode\n');
          updateHeartbeat(workspace, muxReachable);
        }
      } else {
        muxConsecutiveFailures++;
        process.stderr.write(
          `[poller] mux reachability check failed (${muxConsecutiveFailures}/${MAX_MUX_CHECK_FAILURES})\n`
        );
        if (muxConsecutiveFailures >= MAX_MUX_CHECK_FAILURES && muxReachable) {
          muxReachable = false;
          process.stderr.write('[poller] mux unreachable: entering degraded mode (will keep retrying)\n');
          updateHeartbeat(workspace, muxReachable);
        }
      }
    }

    // acked prune を定期的に実行（24h 保持）
    // pending の有無に関わらずタイマー駆動で実行し、idle 時も acked/ が無限に溜まらないようにする
    if (now - lastPruneTime >= PRUNE_INTERVAL_MS) {
      try {
        const pruned = pruneAcked(workspace, PRUNE_MAX_AGE_MS);
        if (pruned > 0) {
          process.stderr.write(`[poller] prune: ${pruned} acked message(s) deleted\n`);
        }
      } catch {
        // best-effort: prune の失敗は無視
      }
      lastPruneTime = now;
    }

    const pending = listPending(workspace);
    if (pending.length === 0) return;

    // 宛先ごとにグルーピング
    const byRecipient = new Map();
    for (const msg of pending) {
      const to = msg.to || 'unknown';
      if (!byRecipient.has(to)) byRecipient.set(to, []);
      byRecipient.get(to).push(msg);
    }

    for (const [recipient, msgs] of byRecipient) {
      const notifyIds = [];

      for (const msg of msgs) {
        const mid = msg.messageId;
        if (!mid) continue;

        const lastNotified = lastNotifiedAt.get(mid) || 0;
        const createdAt = msg.createdAt ? new Date(msg.createdAt).getTime() : now;
        const age = now - createdAt;

        // 通知すべきか？
        // - 初回通知（lastNotified === 0）
        // - 再通知間隔超過
        // - エスカレート（stuck）
        const shouldNotify = lastNotified === 0 || (now - lastNotified) >= RE_NOTIFY_INTERVAL_MS;

        if (shouldNotify) {
          notifyIds.push(mid);
          // lastNotifiedAt は notifyPane 成功後に進める（失敗時は次スキャンで再通知）
        }

        // エスカレート: stuck かつ未エスカレート
        // escalation メッセージ自身は再エスカレートしない（無限ループ防止）
        const isEscalation = msg.kind === 'escalation' || (mid && mid.startsWith('escalation-'));
        if (!isEscalation && age >= STUCK_THRESHOLD_MS && !stuckEscalated.has(mid)) {
          stuckEscalated.add(mid);
          try {
            const result = enqueue(workspace, {
              to: 'orchestrator',
              from: 'poller',
              kind: 'escalation',
              body: `メッセージ ${mid} が ${Math.floor(age / 1000)} 秒間 pending のままです。` +
                    `宛先: ${recipient}、作成日時: ${msg.createdAt || '不明'}。確認してください。`,
              messageId: `escalation-${mid}`,
            });
            process.stderr.write(`[poller] エスカレート: ${result.messageId}\n`);
          } catch (err) {
            process.stderr.write(`[poller] エスカレート enqueue 失敗: ${err.message}\n`);
          }
        }
      }

      // wake 信号送信（成功時のみ lastNotifiedAt を進める）
      if (notifyIds.length > 0) {
        const wakeSignal = buildWakeSignal();
        try {
          notifyPane(workspace, recipient, wakeSignal);
          // 通知成功 → タイムスタンプ更新（失敗したら次スキャンで再通知）
          for (const mid of notifyIds) lastNotifiedAt.set(mid, now);
        } catch (err) {
          process.stderr.write(`[poller] ${recipient} への通知失敗: ${err.message}\n`);
        }
      }
    }

    // ack 済み・消滅済みのエントリを刈り取る（メモリリーク + state 肥大化防止）
    const pendingIds = new Set(pending.map(m => m.messageId).filter(Boolean));
    for (const mid of lastNotifiedAt.keys()) {
      if (!pendingIds.has(mid)) lastNotifiedAt.delete(mid);
    }
    for (const mid of stuckEscalated) {
      if (!pendingIds.has(mid)) stuckEscalated.delete(mid);
    }

    // 通知後に lastNotifiedAt を永続化（他プロセスからの参照用）
    if (lastNotifiedAt.size > 0) {
      writeLastNotifiedState(workspace, lastNotifiedAt);
    }
  }

  // ── fs.watch による即時スキャン ──────────────────────────────────────

  let watchTimer = null;
  function triggerScan() {
    if (watchTimer) return; // 直列化: 最後の呼び出しだけ実行
    watchTimer = setTimeout(() => {
      watchTimer = null;
      scan();
    }, 200); // 200ms でバッチング
  }

  try {
    fs.mkdirSync(inboxRoot, { recursive: true });
  } catch {}
  try {
    const watcher = fs.watch(inboxRoot, { recursive: true });
    watcher.on('change', triggerScan);
    // watcher は uncatchable なエラーを投げることがある（特に Windows）が、
    // 無視して定期スキャンにフォールバックする
    watcher.on('error', () => {});
  } catch {
    // fs.watch が使えない環境では定期スキャンのみ
  }

  // ── 定期スキャン ──────────────────────────────────────────────────────

  // 初回スキャンを即実行
  scan();

  const intervalHandle = setInterval(scan, POLL_INTERVAL_MS);

  // プロセス終了時のクリーンアップ
  function cleanup() {
    releasePoller(workspace);
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => { releasePoller(workspace); });
}

// ═════════════════════════════════════════════════════════════════════════
// エントリポイント
// ═════════════════════════════════════════════════════════════════════════

if (require.main === module) {

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, exitFlagMiss } = parseFlags(args, ['--workspace']);

if (exitFlagMiss) {
  console.error('queue-poller: --workspace には値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
if (!workspace) {
  console.error('queue-poller: ワークスペースを解決できません。');
  process.exit(1);
}

// 二重起動防止: claim できなければ終了
if (!claimPoller(workspace)) {
  // 別の poller が稼働中
  process.exit(0);
}

runPoller(workspace);
} // require.main === module

module.exports = { acquirePollerLease, pollerStatePath, readLastNotifiedState, writeLastNotifiedState, getMuxId, checkMuxReachable };
