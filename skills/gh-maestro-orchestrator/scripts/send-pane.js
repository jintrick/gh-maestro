#!/usr/bin/env node
// Usage: node send-pane.js <pane-id> <message>
const { spawnSync } = require('child_process');

const [paneId, ...rest] = process.argv.slice(2);
const message = rest.join(' ');

if (!paneId || !message) {
  console.error('Usage: send-pane.js <pane-id> <message>');
  process.exit(1);
}

function wez(...args) {
  const r = spawnSync('wezterm', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

wez('cli', 'send-text', '--pane-id', paneId, message);
wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
