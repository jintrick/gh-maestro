#!/usr/bin/env node
// remove-worker.js
// ワーカーペインをkillし、worktreeを削除する
//
// Usage:
//   node remove-worker.js \
//     --worker-name <name> \
//     --workspace <path>

const { spawnSync, execSync } = require('child_process');
const { resolve } = require('path');
const { readFileSync, writeFileSync, existsSync, lstatSync, rmdirSync, readdirSync } = require('fs');

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

// ワーカーペインをkill（プロセスごと即時終了）
spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', paneId], { stdio: 'inherit' });

// worktree内のシンボリックリンク（junction含む）を先に外す
// → git worktree remove がリンク先を再帰削除するのを防ぐ
(function unlinkSymlinks(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    try {
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        rmdirSync(fullPath); // junction/symlinkをリンク先を消さずに除去
      } else if (stat.isDirectory()) {
        unlinkSymlinks(fullPath);
      }
    } catch (_) {}
  }
})(worktreeDir);

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
