#!/usr/bin/env node
// queue-prune.js — prune acknowledged messages older than a configurable threshold
//
// Usage:
//   node queue-prune.js [--max-age <hours>] [--workspace <path>]
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search

'use strict';

const { pruneAcked } = require('./queue');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');

const DEFAULT_MAX_AGE_HOURS = 24;

const USAGE = `queue-prune.js — acked メッセージを削除する

Usage: node queue-prune.js [options]

Options:
  --max-age <hours>     保持期間（時間単位、既定: ${DEFAULT_MAX_AGE_HOURS}）
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

acked ディレクトリ内の、指定時間より古いメッセージを削除します。
pending（inbox）のメッセージには触れません。`;

// ── 引数パース ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, exitFlagMiss } = parseFlags(args, ['--workspace', '--max-age']);

if (exitFlagMiss) {
  console.error('queue-prune: フラグには値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
if (!workspace) {
  console.error('queue-prune: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

// ── max-age 解決 ────────────────────────────────────────────────────────

let maxAgeMs;
if (values['--max-age']) {
  const hours = parseFloat(values['--max-age']);
  if (isNaN(hours) || hours < 0) {
    console.error(`queue-prune: --max-age には 0 以上の数値を指定してください（指定値: ${values['--max-age']}）`);
    process.exit(1);
  }
  maxAgeMs = hours * 3600 * 1000;
} else {
  maxAgeMs = DEFAULT_MAX_AGE_HOURS * 3600 * 1000;
}

// ── prune ───────────────────────────────────────────────────────────────

try {
  const deleted = pruneAcked(workspace, maxAgeMs);
  console.log(`pruned: ${deleted} acked message(s)`);
  process.exit(0);
} catch (err) {
  console.error(`queue-prune: prune に失敗しました: ${err.message}`);
  process.exit(1);
}
