#!/usr/bin/env node
// queue-status.js — show filesystem queue status (pending/delivered/stuck counts, pending list)
//
// Usage:
//   node queue-status.js [--workspace <path>]
//
// Display only — no side effects (no prune).
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const fs = require('fs');
const path = require('path');
const { listPending } = require('./queue');
const { readLastNotifiedState } = require('./queue-poller');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');

// ── Stuck threshold ─────────────────────────────────────────────────────
// A pending message is considered "stuck" if it has been pending longer
// than this threshold. Matches docs/server-plan.md default (10 minutes).
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

const USAGE = `queue-status.js — ファイルシステムキューの状態を表示する

Usage: node queue-status.js [options]

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

表示内容:
  - pending / delivered / stuck の件数
  - pending メッセージの一覧（messageId・宛先・経過時間）
  副作用はありません（prune は行いません）。`;

// ── 引数パース ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, exitFlagMiss } = parseFlags(args, ['--workspace']);

if (exitFlagMiss) {
  console.error('queue-status: --workspace には値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
if (!workspace) {
  console.error('queue-status: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

// ── カウントユーティリティ ──────────────────────────────────────────────

function countJsonFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
  } catch {
    // TOCTOU: dir disappeared
    return 0;
  }
}

function countAllMessages(rootDir) {
  try {
    if (!fs.existsSync(rootDir)) return 0;
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        total += countJsonFiles(path.join(rootDir, entry.name));
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// ── 収集 ────────────────────────────────────────────────────────────────

const queueRoot = path.join(workspace, '.gh-maestro', 'queue');
const inboxRoot = path.join(queueRoot, 'inbox');
const ackedRoot = path.join(queueRoot, 'acked');

const pending = listPending(workspace);
const deliveredCount = countAllMessages(ackedRoot);
const pollerState = readLastNotifiedState(workspace);
const lastNotifiedAt = pollerState ? pollerState.lastNotifiedAt : null;

const now = Date.now();
let stuckCount = 0;

// ── 表示: 件数 ──────────────────────────────────────────────────────────

console.log(`queue-status: ${path.join(workspace, '.gh-maestro', 'queue')}`);
console.log('');

const pendingCount = pending.length;
const pendingLabel = `Pending:    ${pendingCount}`;
const deliveredLabel = `Delivered:  ${deliveredCount}`;

// stuck 判定: pending の createdAt が閾値超
for (const msg of pending) {
  if (!msg || !msg.createdAt) continue;
  const createdAt = new Date(msg.createdAt).getTime();
  if (!isNaN(createdAt) && now - createdAt > STUCK_THRESHOLD_MS) {
    stuckCount++;
  }
}

console.log(pendingLabel);
console.log(deliveredLabel);
console.log(`Stuck:      ${stuckCount}`);
console.log('');

// ── 表示: pending 一覧 ──────────────────────────────────────────────────

if (pending.length > 0) {
  console.log('Pending messages:');
  for (const msg of pending) {
    if (!msg) { console.log('  <broken message>'); continue; }
    const id = msg.messageId || '?';
    const to = msg.to || '?';
    let elapsedStr = '?';
    let stuckMarker = '';
    let isStuck = false;
    if (msg.createdAt) {
      const createdAt = new Date(msg.createdAt).getTime();
      if (!isNaN(createdAt)) {
        const elapsed = now - createdAt;
        elapsedStr = formatElapsed(elapsed);
        isStuck = elapsed > STUCK_THRESHOLD_MS;
        stuckMarker = isStuck ? ' (STUCK)' : '';
      }
    }
    console.log(`  ${id}   ${to}   ${elapsedStr}${stuckMarker}`);

    // stuck エントリの最終通知時刻を表示（poller-state.json から読み取り）
    if (isStuck && lastNotifiedAt && lastNotifiedAt[id]) {
      const lastNotified = lastNotifiedAt[id];
      const ts = new Date(lastNotified).getTime();
      if (!isNaN(ts)) {
        const lastNotifiedDate = new Date(ts).toISOString();
        const elapsedSinceNotified = now - ts;
        console.log(`           last-notified: ${lastNotifiedDate} (${formatElapsed(elapsedSinceNotified)})`);
      } else {
        console.log('           last-notified: (不正な時刻)');
      }
    } else if (isStuck) {
      console.log('           last-notified: (未通知)');
    }
  }
}

function formatElapsed(ms) {
  if (ms < 1000) return '0s ago';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s ago`;
  return `${seconds}s ago`;
}
