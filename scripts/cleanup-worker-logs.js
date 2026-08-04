#!/usr/bin/env node
'use strict';
// cleanup-worker-logs.js
// 既存のワーカーログから thinking_tokens 進捗イベント行（claude-ds系が大量出力する
// 中身のない雑音。scripts/shared/strip-thinking-token-lines.js 参照）を取り除く
// 手動メンテナンスCLI。
//
// worker-exit-hook.js が今後の分は毎回exit時に自動で圧縮するが、本コマンドは
// それ以前に既に肥大化した既存ログを一括で圧縮するために使う。
//
// 実行中のワーカー（まだそのログへ追記し続けているプロセス）に対しては使わないこと。
// 追記中のファイルを置き換えると、書き込み側は古いinodeへ書き続けて新しい内容が消失する
// （scripts/shared/strip-thinking-token-lines.js の冒頭コメント参照）。
//
// Usage:
//   node cleanup-worker-logs.js [--workspace <path>] [--worker <name>]

const fs = require('fs');
const path = require('path');
const { parseFlags, hasHelpFlag, resolveWorkspace } = require('./shared/workspace');
const { workerLogPath } = require('./shared/headless-launch');
const { compactWorkerLog } = require('./shared/strip-thinking-token-lines');

const USAGE = `cleanup-worker-logs.js — ワーカーログから thinking_tokens 進捗イベント行を取り除く

Usage: node cleanup-worker-logs.js [--workspace <path>] [--worker <name>]

Options:
  --workspace <path>  ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または
                      CWDからの .gh-maestro/ 上方探索で解決）
  --worker <name>     指定したワーカーのログのみ圧縮する（省略時は
                      .gh-maestro/worker-logs/ 配下の *.log 全件）
  --help, -h          このヘルプを表示する

実行中（まだ追記中）のワーカーに対しては使わないこと。プロセスが完全に終了した
ログだけを対象にする。ファイルごとに「圧縮結果: <path> — N行削除」または
「変更なし: <path>」を表示する。`;

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--workspace', '--worker']);

  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  if (rest.length > 0) {
    console.error(`cleanup-worker-logs: 未知の引数です: ${rest.join(' ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  const fail = (msg) => { console.error(`cleanup-worker-logs: ${msg}`); process.exit(1); };

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) fail('ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');

  let targets;
  if (values['--worker']) {
    targets = [workerLogPath(workspace, values['--worker'])];
  } else {
    const dir = path.join(workspace, '.gh-maestro', 'worker-logs');
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      fail(`worker-logs ディレクトリを読めません: ${dir} — ${e.message}`);
    }
    targets = entries.filter((f) => f.endsWith('.log')).map((f) => path.join(dir, f));
  }

  if (targets.length === 0) {
    console.log('cleanup-worker-logs: 対象ログがありません');
    process.exit(0);
  }

  for (const logPath of targets) {
    let result;
    try {
      result = compactWorkerLog(logPath);
    } catch (e) {
      console.error(`cleanup-worker-logs: 圧縮に失敗: ${logPath} — ${e.message}`);
      continue;
    }
    if (result.compacted) {
      console.log(`圧縮結果: ${logPath} — ${result.removedLines}行削除`);
    } else {
      console.log(`変更なし: ${logPath}`);
    }
  }
}

module.exports = {};
