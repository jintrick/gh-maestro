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
const { spawn } = require('child_process');
const { enqueue } = require('./queue');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { acquirePollerLease } = require('./queue-poller');

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

// ── 引数パース ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--kind', '--message-id']);

if (exitFlagMiss) {
  console.error('queue-send: フラグには値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const [recipient, ...msgParts] = rest;
const message = msgParts.join(' ');

if (!recipient || !message) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
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
    kind: values['--kind'] || undefined,
    messageId: values['--message-id'] || undefined,
  });
  console.log(result.messageId);

  // ── lazy-start: poller が起動していなければ起動する ────────────────────
  // GH_MAESTRO_DISABLE_LAZY_POLLER=1 でゲート（テスト用）

  if (!process.env.GH_MAESTRO_DISABLE_LAZY_POLLER) {
    // GH_MAESTRO_POLLER_SCRIPT でモック注入可（テスト用）
    const pollerScript = process.env.GH_MAESTRO_POLLER_SCRIPT || path.join(__dirname, 'queue-poller.js');

    // acquirePollerLease（queue-poller.js と共用）で lease 取得を試みる
    const placeholderPayload = JSON.stringify({
      pid: 0, // プレースホルダー — claimPoller が即乗っ取る
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
    });
    const acquired = acquirePollerLease(workspace, placeholderPayload);

    if (acquired) {
      const child = spawn(process.execPath, [pollerScript, '--workspace', workspace], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  }

  process.exit(0);
} catch (err) {
  console.error(`queue-send: enqueue に失敗しました: ${err.message}`);
  process.exit(1);
}
