#!/usr/bin/env node
// poll-and-notify.js <ISSUE> --workspace <path> [--from <name>]
// spawn-worker.js が gh-maestro-coder を起動するときに自動で起動するヘルパー。
// poll-pr.js を子プロセスで実行し、stdout 各行を orchestrator の inbox へ
// enqueue する（Phase 4 移行により send-pane.js 呼び出しから enqueue に変更）。
// WezTerm 通知は poller に任せる。
// poll-pr.js が終了したらこのプロセスも終了する（detached で呼ばれるため親とは無関係に生存する）。

'use strict';

const path = require('path');
const { spawn } = require('./child-process');
const { enqueue } = require('./queue');
// queue-poller は遅延 require: テストが GH_MAESTRO_DISABLE_LAZY_POLLER=1 で
// ensurePoller の要件をスキップするとき、存在しないモジュールを require しないようにするため。

const argv = process.argv.slice(2);
const issue = argv[0];
const wsIdx = argv.indexOf('--workspace');
const fromIdx = argv.indexOf('--from');
const workspace = wsIdx !== -1 ? argv[wsIdx + 1] : null;
// --from が値なしで末尾に来た場合のガード（undefined で enqueue クラッシュを防止）
const fromArg = fromIdx !== -1 ? argv[fromIdx + 1] : undefined;
const fromName = (fromArg && !fromArg.startsWith('--')) ? fromArg : (process.env.GH_MAESTRO_WORKER || 'coder');

if (!issue || !workspace) {
  console.error('Usage: node poll-and-notify.js <ISSUE> --workspace <path> [--from <name>]');
  process.exit(1);
}

const scriptsDir = __dirname;

const poll = spawn(process.execPath, [path.resolve(scriptsDir, 'poll-pr.js'), issue], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'inherit'],
});

// lazy-start poller は初回 enqueue 成功時に1回だけ試行する
let pollerStarted = false;

/**
 * enqueue 成功後に poller の lazy-start を試みる。
 * send-pane.js / queue-send.js と同じロジック。poller が未起動のセッションでも
 * worker → orchestrator 通知（PR_DETECTED 等）が inbox に埋もれず可視化される。
 */
function ensurePoller() {
  if (pollerStarted) return;
  pollerStarted = true;

  if (process.env.GH_MAESTRO_DISABLE_LAZY_POLLER) return;

  try {
    const { acquirePollerLease } = require('./queue-poller');
    const pollerScript = path.join(scriptsDir, 'queue-poller.js');
    const placeholderPayload = JSON.stringify({
      pid: 0,
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
    });
    const acquired = acquirePollerLease(workspace, placeholderPayload);

    if (acquired) {
      const child = spawn(process.execPath, [pollerScript, '--workspace', workspace], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
  } catch (e) {
    // poller 起動失敗は配送の成否に影響しない。
    // 次回 enqueue 時に lazy-start が再試行される。
    process.stderr.write(`poll-and-notify: poller lazy-start に失敗しました（enqueue は成功）: ${e.message}\n`);
  }
}

function doEnqueue(body) {
  try {
    enqueue(workspace, {
      to: 'orchestrator',
      from: fromName,
      kind: 'notification',
      body,
    });
    ensurePoller();
  } catch (err) {
    process.stderr.write(`poll-and-notify: enqueue 失敗: ${err.message}\n`);
  }
}

let buf = '';
poll.stdout.on('data', (data) => {
  buf += data.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    doEnqueue(line.trim());
  }
});

// 'close' イベントを使う: stdout/stderr が完全に閉じてから発火するため、
// 'data' で読み残したバッファ末尾のデータが失われない。
// 'exit' は stdout バッファがフラッシュされる前に発火しうるため使わない。
poll.on('close', (code) => {
  if (buf.trim()) {
    doEnqueue(buf.trim());
  }
  process.exit(code ?? 0);
});
