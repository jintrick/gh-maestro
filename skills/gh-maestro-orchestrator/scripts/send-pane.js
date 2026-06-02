#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message>
//
// worker-name は .gh-maestro/workers.json で pane-id に解決される。
// "orchestrator" を指定するとorchestratorペインに送信する。
// 送信方向に応じて送信者名を自動的にメッセージ先頭に付与する。

const path = require('path');
const { spawnSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');

const [name, ...rest] = process.argv.slice(2);
const message = rest.join(' ');

if (!name || !message) {
  console.error('Usage: send-pane.js <worker-name> <message>');
  process.exit(1);
}

// workers.json で name → pane-id を解決（見つからなければ name をそのまま使用）
const workersJson = path.resolve(__dirname, '..', 'workers.json');
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
const prefix = senderName ? `${senderName}です。` : '';
const fullMessage = prefix + message;

function wez(...args) {
  const r = spawnSync('wezterm', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

wez('cli', 'send-text', '--pane-id', paneId, fullMessage);
wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
