#!/usr/bin/env node
// queue-ack.js — acknowledge a message in the filesystem queue by messageId
//
// Usage:
//   node queue-ack.js <messageId> [--workspace <path>]
//
// messageId is unique across all recipients, so no recipient flag is needed.
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const { ack } = require('./queue');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');

const USAGE = `queue-ack.js — メッセージを受理（ack）する

Usage: node queue-ack.js <messageId> [options]

Arguments:
  <messageId>           ack するメッセージの ID（全 inbox から横断検索）

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

messageId はキューの全 recipient を通じてユニークであるため、宛先指定は不要です。
既に ack 済みの messageId を指定してもエラーになりません（冪等）。`;

// ── 引数パース ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace']);

if (exitFlagMiss) {
  console.error('queue-ack: --workspace には値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const [messageId] = rest;

if (!messageId) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
if (!workspace) {
  console.error('queue-ack: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

// ── ack ─────────────────────────────────────────────────────────────────

try {
  const found = ack(workspace, messageId);
  if (!found) {
    console.error(`queue-ack: messageId "${messageId}" が見つかりません`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(`queue-ack: ack に失敗しました: ${err.message}`);
  process.exit(1);
}
