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

const fs = require('fs');
const path = require('path');
const { ack } = require('./queue');

const USAGE = `queue-ack.js — メッセージを受理（ack）する

Usage: node queue-ack.js <messageId> [options]

Arguments:
  <messageId>           ack するメッセージの ID（全 inbox から横断検索）

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

messageId はキューの全 recipient を通じてユニークであるため、宛先指定は不要です。
既に ack 済みの messageId を指定してもエラーになりません（冪等）。`;

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

const wsIdx = args.indexOf('--workspace');
const workspaceArg = (wsIdx !== -1 && args[wsIdx + 1]) ? args[wsIdx + 1] : null;

// Guard: wsIdx===-1 のとき wsIdx+1=0 が第1引数（messageId）を誤って除外しない
const positional = wsIdx === -1
  ? args
  : args.filter((_, i) => i !== wsIdx && i !== wsIdx + 1);
const [messageId] = positional;

if (!messageId) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = process.env.GH_MAESTRO_WORKSPACE || workspaceArg || findWorkspaceFromCwd();
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
