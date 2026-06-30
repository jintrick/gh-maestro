#!/usr/bin/env node
// poll-and-notify.js <ISSUE> --workspace <path>
// spawn-worker.js が gh-maestro-coder を起動するときに自動で起動するヘルパー。
// poll-pr.js を子プロセスで実行し、stdout 各行を orchestrator へ send-pane.js 経由で転送する。
// poll-pr.js が終了したらこのプロセスも終了する（detached で呼ばれるため親とは無関係に生存する）。

'use strict';

const { spawn, spawnSync } = require('child_process');
const { resolve } = require('path');

const argv = process.argv.slice(2);
const issue = argv[0];
const wsIdx = argv.indexOf('--workspace');
const workspace = wsIdx !== -1 ? argv[wsIdx + 1] : null;

if (!issue || !workspace) {
  console.error('Usage: node poll-and-notify.js <ISSUE> --workspace <path>');
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
    spawnSync(process.execPath, [
      resolve(scriptsDir, 'send-pane.js'),
      'orchestrator',
      '--workspace', workspace,
      line.trim(),
    ], { stdio: 'inherit' });
  }
});

poll.on('exit', (code) => {
  if (buf.trim()) {
    spawnSync(process.execPath, [
      resolve(scriptsDir, 'send-pane.js'),
      'orchestrator',
      '--workspace', workspace,
      buf.trim(),
    ], { stdio: 'inherit' });
  }
  process.exit(code ?? 0);
});
