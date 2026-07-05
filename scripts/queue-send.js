#!/usr/bin/env node
// queue-send.js — enqueue a message into the filesystem queue
//
// Usage:
//   node queue-send.js <recipient> <message> [--kind <k>] [--message-id <id>] [--workspace <path>]
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const fs = require('fs');
const path = require('path');
const { enqueue } = require('./queue');

const USAGE = `queue-send.js — メッセージをファイルシステムキューに送信する

Usage: node queue-send.js <recipient> <message> [options]

Arguments:
  <recipient>           送信先（worker名、または "orchestrator"）
  <message>             メッセージ本文

Options:
  --kind <k>            メッセージ種別（既定: instruction）
  --message-id <id>     messageId を指定（省略時は自動生成）
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

workspace 解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索`;

// ── workspace 解決 ──────────────────────────────────────────────────────

function findWorkspaceFromCwd() {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.gh-maestro'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── 引数パース ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

/**
 * Extract the value of a flag from args and return [value, usedIndices].
 * usedIndices contains the flag index and its value index, or empty array if not found.
 * If the flag is present but has no value, exits with usage error.
 */
function extractFlag(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return [null, []];
  if (idx + 1 >= args.length || args[idx + 1].startsWith('--')) {
    console.error(`queue-send: ${flag} には値が必要です。`);
    console.error(USAGE);
    process.exit(1);
  }
  return [args[idx + 1], [idx, idx + 1]];
}

const [workspaceArg, wsIndices] = extractFlag('--workspace');
const [kindArg, kindIndices] = extractFlag('--kind');
const [messageIdArg, midIndices] = extractFlag('--message-id');

// Strip known flag-value pairs from positional args
const skipIndices = new Set([...wsIndices, ...kindIndices, ...midIndices]);
const positional = args.filter((_, i) => !skipIndices.has(i));

const [recipient, ...msgParts] = positional;
const message = msgParts.join(' ');

if (!recipient || !message) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = process.env.GH_MAESTRO_WORKSPACE || workspaceArg || findWorkspaceFromCwd();
if (!workspace) {
  console.error('queue-send: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

const from = process.env.GH_MAESTRO_WORKER || 'orchestrator';

// ── enqueue ─────────────────────────────────────────────────────────────

try {
  const result = enqueue(workspace, {
    to: recipient,
    from,
    body: message,
    kind: kindArg || undefined,
    messageId: messageIdArg || undefined,
  });
  console.log(result.messageId);
  process.exit(0);
} catch (err) {
  console.error(`queue-send: enqueue に失敗しました: ${err.message}`);
  process.exit(1);
}
