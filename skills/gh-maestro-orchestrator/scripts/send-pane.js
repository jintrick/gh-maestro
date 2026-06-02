#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message>
//
// worker-name は .gh-maestro/workers.json で pane-id に解決される。
// "orchestrator" を指定するとorchestratorペインに送信する。

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
if (existsSync(workersJson)) {
  const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  if (workers[name]) paneId = workers[name];
}

function wez(...args) {
  const r = spawnSync('wezterm', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

wez('cli', 'send-text', '--pane-id', paneId, message);
wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
