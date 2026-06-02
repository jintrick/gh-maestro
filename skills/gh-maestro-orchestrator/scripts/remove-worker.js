#!/usr/bin/env node
// remove-worker.js
// ワーカーペインにexitを送信し、終了を待ってworktreeを削除する
//
// Usage:
//   node remove-worker.js \
//     --worker-name <name> \
//     --workspace <path>

const { spawnSync, execSync } = require('child_process');
const { resolve } = require('path');
const { readFileSync, writeFileSync, existsSync } = require('fs');

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const workerName = get('--worker-name');
const workspace  = get('--workspace') ?? process.cwd();

const fail = (msg) => { console.error(`remove-worker: ${msg}`); process.exit(1); };
if (!workerName) fail('--worker-name が必要です');

const workersJson = resolve(workspace, '.gh-maestro', 'workers.json');
const worktreeDir = resolve(workspace, '.gh-maestro', 'worktrees', workerName);

if (!existsSync(workersJson)) fail(`workers.json が見つかりません: ${workersJson}`);

const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
const paneId = workers[workerName];
if (!paneId) fail(`ワーカー "${workerName}" が workers.json に存在しません`);

// ワーカーペインにexit送信
function wez(...args) {
  spawnSync('wezterm', args, { stdio: 'inherit' });
}

wez('cli', 'send-text', '--pane-id', paneId, 'exit');
wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');

// ペイン終了を待つ（最大10秒）
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  const r = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8' });
  if (r.status === 0) {
    const panes = JSON.parse(r.stdout);
    const alive = panes.some(p => String(p.pane_id) === String(paneId));
    if (!alive) break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}

// worktree削除
try {
  execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: workspace, stdio: 'inherit' });
} catch (e) {
  console.error(`remove-worker: git worktree remove 失敗 — ${e.message}`);
  process.exit(1);
}

// workers.json からエントリを削除
delete workers[workerName];
writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
