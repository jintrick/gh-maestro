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
const fullMessage = prefix + message;

function wez(...a) {
  return spawnSync('wezterm', a, { encoding: 'utf8' });
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// メッセージが注入されたか確認するため末尾20文字を検索する
const probe = fullMessage.slice(-20);

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  wez('cli', 'send-text', '--pane-id', paneId, fullMessage);

  const result = wez('cli', 'get-text', '--pane-id', paneId);
  if (result.stdout && result.stdout.includes(probe)) {
    // 注入確認 → Enterを送信して完了
    const r = wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
    process.exit(r.status ?? 0);
  }

  if (attempt < MAX_RETRIES) {
    sleep(RETRY_DELAY_MS);
  }
}

process.stderr.write(`send-pane: failed to deliver message after ${MAX_RETRIES} attempts\n`);
process.exit(1);
