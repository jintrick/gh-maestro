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
const { enqueue, listPending } = require('./queue');
const { notifyPane } = require('./pane-notify');

// ── 閾値（先頭定数） ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;       // 定期スキャン間隔（ms）
const STALE_HEARTBEAT_MS = 15000;    // heartbeat がこの時間超で stale
const RE_NOTIFY_INTERVAL_MS = 120000; // 再通知間隔（ms）
const STUCK_THRESHOLD_MS = 600000;   // 10分 - この時間超で escallation

const USAGE = `queue-poller.js — キュー pending 監視と pane 通知

Usage: node queue-poller.js [options]

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

poller は workspace ごとに 1 プロセス起動される。二重起動防止には poller.json の
atomic 作成（wx）＋ stale heartbeat 乗っ取りを使用する。
起動は lazy-start: queue-send.js が enqueue 後に stale 検出して spawn する。`;

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
    if (!isPlaceholder && elapsed < STALE_HEARTBEAT_MS) {
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
  });
  return acquirePollerLease(workspace, payload);
}

/**
 * heartbeat を更新する。
 */
function updateHeartbeat(workspace) {
  try {
    const existing = JSON.parse(fs.readFileSync(pollerJsonPath(workspace), 'utf8'));
    existing.heartbeat = Date.now();
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

// ── 通知テンプレート ────────────────────────────────────────────────────

/**
 * 通知文を生成する。
 * （server-plan.md Phase 3 のテンプレートに従う）
 */
function buildNotificationText(scriptDir, pendingForRecipient) {
  const lines = [
    `新着メッセージが ${pendingForRecipient.length} 件あります。以下を読み、受理したら`,
    `node ${path.join(scriptDir, 'queue-ack.js')} <messageId> を実行してください。`,
    `既に処理済みの場合も ack だけしてください。`,
  ];
  for (const msg of pendingForRecipient) {
    lines.push(`- ${msg.path || '（不明なパス）'}`);
  }
  return lines.join('\n');
}

// ── メインループ ────────────────────────────────────────────────────────

function runPoller(workspace) {
  const scriptsDir = __dirname;
  const inboxRoot = path.join(workspace, '.gh-maestro', 'queue', 'inbox');

  // lastNotifiedAt: messageId → Date.now()
  const lastNotifiedAt = new Map();

  // stuckEscalated: messageId → boolean （再エスカレート防止）
  const stuckEscalated = new Set();

  /**
   * 1回のスキャン実行。
   * pending を検出し、宛先ごとに通知・再通知・エスカレートを処理する。
   */
  function scan() {
    // heartbeat 更新
    updateHeartbeat(workspace);

    const pending = listPending(workspace);
    if (pending.length === 0) return;

    // 宛先ごとにグルーピング
    const byRecipient = new Map();
    for (const msg of pending) {
      const to = msg.to || 'unknown';
      if (!byRecipient.has(to)) byRecipient.set(to, []);
      byRecipient.get(to).push(msg);
    }

    const now = Date.now();

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

      // 通知送信（成功時のみ lastNotifiedAt を進める）
      if (notifyIds.length > 0) {
        const pendingForRecipient = msgs.filter(m => notifyIds.includes(m.messageId));
        const text = buildNotificationText(scriptsDir, pendingForRecipient);
        try {
          notifyPane(workspace, recipient, text);
          // 通知成功 → タイムスタンプ更新（失敗したら次スキャンで再通知）
          for (const mid of notifyIds) lastNotifiedAt.set(mid, now);
        } catch (err) {
          process.stderr.write(`[poller] ${recipient} への通知失敗: ${err.message}\n`);
        }
      }
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

module.exports = { acquirePollerLease };
