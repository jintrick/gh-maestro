#!/usr/bin/env node
// poll-inbox.js — 自分の inbox を定期的にスキャンし、新着を stdout に通知する
//
// Usage: node poll-inbox.js <self> [--workspace <path>] [--interval <sec>] [--once]
//
// Output (stdout):
//   NEW_MESSAGE:<messageId>  新しい pending メッセージを検出
//
// poll-reviews.js と同型の設計。ワーカー自身のターン内で blocking poll として
// 実行され、detached sidecar にはならない。orchestrator も自分の inbox 監視に使う。
//
// 状態追跡はインメモリ（Set）。プロセス再起動時は全 pending を再通知する。
// これは正しい挙動: 未処理メッセージは再通知されるべきであり、ack 済みは
// inbox に存在しないため再通知されない。
//
// inbox スキャンは queue.js の receive() に委譲している（DRY）。
// receive() が recipient 名の path-safety 検証を担うため、poll-inbox.js 側で
// 別途 validate する必要はない（#25 purgeInbox と同型の防御）。
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const path = require('path');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { receive } = require('./queue');

const DEFAULT_INTERVAL_SEC = 2;

const USAGE = `poll-inbox.js — 自分の inbox を定期スキャンし新着を stdout に通知する

Usage: node poll-inbox.js <self> [options]

Arguments:
  <self>                 自分の名前（worker 名、または "orchestrator"）

Options:
  --workspace <path>     ワークスペースパス（省略時は環境変数またはCWDから解決）
  --interval <sec>       ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）
  --once                 1回だけスキャンして終了する（継続ポーリングしない）

Output (stdout):
  NEW_MESSAGE:<messageId>  新着 pending メッセージを1行ずつ出力

このスクリプトは worker のターン内で blocking 実行される。detached 起動しない。
inbox/<self>/ を定期スキャンし、未通知の pending を検出する。
既に通知済みの messageId は同一プロセス内では再通知しない（インメモリ Set で管理）。
再起動時は全 pending が再通知される（ack 済みは inbox に無いため通知されない）。
self 名は queue.js の validateField で path-safety が検証される（#25 同型）。

worker の通信ループ:
  1. Monitor 等で poll-inbox.js を起動
  2. NEW_MESSAGE:<messageId> を検出
  3. inbox/<self>/<messageId>.json を読んで内容を把握
  4. メッセージを処理
  5. queue-ack.js <messageId> で ack
  6. Monitor に戻る`;

// ── 引数パース ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--interval']);

if (exitFlagMiss) {
  console.error('poll-inbox: フラグには値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const onceMode = rest.includes('--once');
const positional = rest.filter(a => a !== '--once');
const self = positional[0];

if (!self) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
if (!workspace) {
  console.error('poll-inbox: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

const intervalMs = (parseInt(values['--interval'] || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;

// ── self 名の検証（queue.js receive() の validateField に委譲） ────────────

// receive() は recipient 名の path-safety を検証する。
// 起動時に1回呼んで名前を検証し、不正なら即座に exit する。
try {
  receive(workspace, self);
} catch (err) {
  process.stderr.write(`poll-inbox: ${err.message}\n`);
  process.exit(1);
}

// ── メイン ──────────────────────────────────────────────────────────────────

const seen = new Set();

/**
 * inbox を1回スキャンし、未通知の pending を stdout に出力する。
 *
 * queue.js の receive() に inbox 読み取りを委譲している（DRY）。
 * receive() が JSON parse / ENOENT / TOCTOU / corrupted file skip を
 * すべて処理するため、poll-inbox.js 側で再実装しない。
 * seen.add は receive() が正常にパースしたメッセージに対してのみ実行される
 * ため、破損ファイルで誤って seen に入ることはない。
 */
function scanOnce() {
  let messages;
  try {
    messages = receive(workspace, self);
  } catch (err) {
    // receive() の validateField は起動時に通過済みのため、ここでの throw は
    // TOCTOU（inbox ディレクトリがロックされる等）のみ。安全に skip する。
    return;
  }

  for (const msg of messages) {
    if (seen.has(msg.messageId)) continue;
    seen.add(msg.messageId);
    process.stdout.write(`NEW_MESSAGE:${msg.messageId}\n`);
  }
}

// ── シグナルハンドラ ────────────────────────────────────────────────────────

// SIGINT/SIGTERM でクリーンに終了。setInterval は unref しない（イベントループを維持）。
let intervalHandle = null;

function cleanup() {
  if (intervalHandle) clearInterval(intervalHandle);
  // 明示的に exit して、unref されていないタイマーがあっても即座に終了する
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ── 実行 ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (onceMode) {
    scanOnce();
    process.exit(0);
  }

  // 継続ポーリング: 初回スキャンを即実行し、その後 interval で定期スキャン
  scanOnce();
  intervalHandle = setInterval(scanOnce, intervalMs);
  // interval は unref しない — これがイベントループを維持し、プロセスが存続する
}

// テスト用 export: scanOnce を同一プロセスで複数回呼び in-memory dedup を検証可能にする
module.exports = { scanOnce };
