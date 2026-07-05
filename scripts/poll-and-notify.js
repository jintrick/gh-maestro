#!/usr/bin/env node
// poll-and-notify.js <ISSUE> --workspace <path> [--from <name>]
// spawn-worker.js が gh-maestro-coder を起動するときに自動で起動するヘルパー。
// poll-pr.js を子プロセスで実行し、stdout 各行を orchestrator の inbox へ
// enqueue する（Phase 4 移行により send-pane.js 呼び出しから enqueue に変更）。
// WezTerm 通知は poller に任せる。
// poll-pr.js が終了したらこのプロセスも終了する（detached で呼ばれるため親とは無関係に生存する）。

'use strict';

const { spawn } = require('child_process');
const { resolve } = require('path');
const { enqueue } = require('./queue');

const argv = process.argv.slice(2);
const issue = argv[0];
const wsIdx = argv.indexOf('--workspace');
const fromIdx = argv.indexOf('--from');
const workspace = wsIdx !== -1 ? argv[wsIdx + 1] : null;
const fromName = fromIdx !== -1 ? argv[fromIdx + 1] : (process.env.GH_MAESTRO_WORKER || 'coder');

if (!issue || !workspace) {
  console.error('Usage: node poll-and-notify.js <ISSUE> --workspace <path> [--from <name>]');
  process.exit(1);
}

const scriptsDir = __dirname;

const poll = spawn(process.execPath, [resolve(scriptsDir, 'poll-pr.js'), issue], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let buf = '';
poll.stdout.on('data', (data) => {
  buf += data.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      enqueue(workspace, {
        to: 'orchestrator',
        from: fromName,
        kind: 'notification',
        body: line.trim(),
      });
    } catch (err) {
      process.stderr.write(`poll-and-notify: enqueue 失敗: ${err.message}\n`);
    }
  }
});

poll.on('exit', (code) => {
  if (buf.trim()) {
    try {
      enqueue(workspace, {
        to: 'orchestrator',
        from: fromName,
        kind: 'notification',
        body: buf.trim(),
      });
    } catch (err) {
      process.stderr.write(`poll-and-notify: enqueue 失敗 (final): ${err.message}\n`);
    }
  }
  process.exit(code ?? 0);
});
