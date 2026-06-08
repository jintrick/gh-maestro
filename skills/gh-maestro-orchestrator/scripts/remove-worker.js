#!/usr/bin/env node
// remove-worker.js
// ワーカーペインをkillし、workers.jsonからエントリを削除する。
// worktreeの削除は次回orchestrator起動時のreset-session.jsに委ねる。
//
// Usage:
//   node remove-worker.js \
//     --worker-name <name> \
//     --workspace <path>

const { spawnSync } = require('child_process');
const { resolve } = require('path');
const { readFileSync, writeFileSync, existsSync } = require('fs');

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const workerName = get('--worker-name');
const workspace  = get('--workspace') ?? process.cwd();

const fail = (msg) => { console.error(`remove-worker: ${msg}`); process.exit(1); };
if (!workerName) fail('--worker-name が必要です');

const workersJson = resolve(workspace, '.gh-maestro', 'workers.json');

if (!existsSync(workersJson)) fail(`workers.json が見つかりません: ${workersJson}`);

let workers;
try {
  workers = JSON.parse(readFileSync(workersJson, 'utf8'));
} catch (e) {
  fail(`workers.json のパースに失敗しました: ${e.message}`);
}

const paneId = workers[workerName] || null;
if (!paneId) {
  console.warn(`remove-worker: ワーカー "${workerName}" の pane_id が workers.json に存在しません (value: ${JSON.stringify(workers[workerName])}) — スキップします`);
} else {
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const exitResult = spawnSync('wezterm', ['cli', 'send-text', '--pane-id', paneId, '--no-paste', '/exit\n'], { encoding: 'utf8' });
  if (exitResult.status !== 0) {
    console.warn(`remove-worker: /exit 送信失敗 (pane ${paneId}): ${exitResult.stderr.trim()} — kill-paneに進みます`);
  }
  sleep(1000);

  const killResult = spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8' });
  if (killResult.status !== 0) {
    console.warn(`remove-worker: kill-pane 失敗 (pane ${paneId}): ${killResult.stderr.trim()}`);
  }
}

delete workers[workerName];
writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
