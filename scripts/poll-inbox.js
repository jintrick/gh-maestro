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
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');

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

// ── inbox パス ──────────────────────────────────────────────────────────────

function inboxDir() {
  return path.join(workspace, '.gh-maestro', 'queue', 'inbox', self);
}

// ── メイン ──────────────────────────────────────────────────────────────────

const seen = new Set();

/**
 * inbox を1回スキャンし、未通知の pending を stdout に出力する。
 * 壊れた JSON はスキップ（listPending/receive と同様のベストエフォート）。
 * inbox ディレクトリが存在しない場合は何も出力しない。
 */
function scanOnce() {
  const dir = inboxDir();

  let files;
  try {
    if (!fs.existsSync(dir)) return;
    files = fs.readdirSync(dir);
  } catch {
    // dir disappeared between existsSync and readdirSync (TOCTOU) — safe to skip
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const messageId = file.slice(0, -5); // strip .json
    if (seen.has(messageId)) continue;

    const filePath = path.join(dir, file);

    // ファイルが完全な JSON か検証する。壊れたファイルで seen.add してしまうと、
    // その後ファイルが正常化しても同一プロセス内で二度と通知されないため、
    // seen.add は JSON パース成功後に実行する。
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      JSON.parse(content);
    } catch {
      // unparseable or unreadable — skip, don't add to seen (retry next scan)
      continue;
    }

    seen.add(messageId);
    process.stdout.write(`NEW_MESSAGE:${messageId}\n`);
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

if (onceMode) {
  scanOnce();
  process.exit(0);
}

// 継続ポーリング: 初回スキャンを即実行し、その後 interval で定期スキャン
scanOnce();
intervalHandle = setInterval(scanOnce, intervalMs);
// interval は unref しない — これがイベントループを維持し、プロセスが存続する
