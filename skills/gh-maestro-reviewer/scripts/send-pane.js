#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message> --workspace <path>
//
// worker-name は .gh-maestro/workers.json で pane-id に解決される。
// "orchestrator" を指定するとorchestratorペインに送信する。
// 送信方向に応じて送信者名を自動的にメッセージ先頭に付与する。

const path = require('path');
const { spawnSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');

const args = process.argv.slice(2);
const wsIdx = args.indexOf('--workspace');
const workspace = wsIdx !== -1 ? args[wsIdx + 1] : null;

// --workspace とその値を除いた残りを解析
const rest = args.filter((_, i) => i !== wsIdx && i !== wsIdx + 1);
const [name, ...msgParts] = rest;
const message = msgParts.join(' ');

if (!name || !message) {
  console.error('Usage: send-pane.js <worker-name> <message> --workspace <path>');
  process.exit(1);
}

// workers.json のパスを解決
const workersJson = workspace
  ? path.resolve(workspace, '.gh-maestro', 'workers.json')
  : path.resolve(__dirname, '..', 'workers.json'); // 後方互換

let paneId = name;
let senderName = null;

if (existsSync(workersJson)) {
  const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  if (workers[name]) paneId = workers[name];

  // 送信者を逆引き: 現在のpane-idがworkersのどのエントリか
  const myPaneId = String(process.env.WEZTERM_PANE ?? '');
  if (myPaneId) {
    for (const [k, v] of Object.entries(workers)) {
      if (String(v) === myPaneId) { senderName = k; break; }
    }
  }
}

// 送信者名をメッセージ先頭に付与
const prefix = senderName === 'orchestrator'
  ? 'orchestratorです。'
  : senderName ? `${senderName}担当workerです。` : '';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

function wez(...a) {
  return spawnSync('wezterm', a, { encoding: 'utf8' });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  const id = Math.random().toString(36).slice(2, 8);
  const fullMessage = prefix + message + ` [${id}]`;

  // リトライ時は前回の入力をクリア
  if (attempt > 1) {
    wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\x15');
    sleep(100);
  }

  wez('cli', 'send-text', '--pane-id', paneId, fullMessage);
  sleep(150);

  const result = wez('cli', 'get-text', '--pane-id', paneId);
  if (result.stdout && result.stdout.includes(id)) {
    wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
    process.exit(0);
  }

  if (attempt < MAX_RETRIES) sleep(RETRY_DELAY_MS);
}

process.stderr.write(`send-pane: failed to deliver message after ${MAX_RETRIES} attempts\n`);
process.exit(1);
