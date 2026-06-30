#!/usr/bin/env node
// remove-worker.js
// ワーカーペインをkillし、worktreeを即座に削除し、workers.jsonからエントリを削除する。
// 削除に失敗した場合でも次回reset-session.jsが保険として掃除する。
//
// Usage:
//   node remove-worker.js \
//     --worker-name <name> \
//     --workspace <path>

const { spawnSync, execSync } = require('child_process');
const { resolve } = require('path');
const { readFileSync, writeFileSync, existsSync, rmSync } = require('fs');
const { unlinkJunctions } = require('./unlink-junctions');

const USAGE = `remove-worker.js — ワーカーのペインを kill し worktree を削除する

Usage: node remove-worker.js --worker-name <name> [--workspace <path>]

Options:
  --worker-name <name>  削除するワーカー名（必須）
  --workspace <path>    ワークスペース（デフォルト CWD）

ペインを kill し、worktree と同名ブランチを削除し、workers.json からエントリを除く。
削除に失敗しても次回 reset-session.js が保険として掃除する。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const workerName = get('--worker-name');
const workspace  = get('--workspace') ?? process.cwd();

const fail = (msg) => { console.error(`remove-worker: ${msg}`); process.exit(1); };
if (!workerName) { console.error(USAGE); process.exit(1); }

const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
const worktreeDir  = resolve(workspace, '.gh-maestro', 'worktrees', workerName);
const IS_WIN       = process.platform === 'win32';

if (!existsSync(workersJson)) fail(`workers.json が見つかりません: ${workersJson}`);

let workers;
try {
  workers = JSON.parse(readFileSync(workersJson, 'utf8'));
} catch (e) {
  fail(`workers.json のパースに失敗しました: ${e.message}`);
}

// ── ペインをkill ─────────────────────────────────────────────────────

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const paneId = workers[workerName] || null;
if (!paneId) {
  console.warn(`remove-worker: ワーカー "${workerName}" の pane_id が workers.json に存在しません — worktree削除のみ実行します`);
} else {
  const exitResult = spawnSync('wezterm', ['cli', 'send-text', '--pane-id', paneId, '--no-paste', '/exit\n'], { encoding: 'utf8' });
  if (exitResult.status !== 0) {
    console.warn(`remove-worker: /exit 送信失敗 (pane ${paneId}): ${exitResult.stderr.trim()} — kill-paneに進みます`);
  }
  sleep(1000);

  const killResult = spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8' });
  if (killResult.status !== 0) {
    console.warn(`remove-worker: kill-pane 失敗 (pane ${paneId}): ${killResult.stderr.trim()}`);
  }

  // プロセスがハンドルを解放するまで少し待つ
  sleep(500);
}

// ── worktreeを即座に削除 ──────────────────────────────────────────────

const psRemove = (dir) => {
  if (!IS_WIN) return false;
  const escaped = dir.replace(/'/g, "''");
  try {
    execSync(
      `powershell -NoProfile -Command "[System.IO.Directory]::Delete('${escaped}', $true)"`,
      { stdio: 'pipe', timeout: 15000 }
    );
    return !existsSync(dir);
  } catch (_) {
    return false;
  }
};

if (existsSync(worktreeDir)) {
  console.warn(`remove-worker: worktree "${workerName}" を削除します...`);

  unlinkJunctions(worktreeDir, (msg) => console.warn(`remove-worker: ${msg}`));

  // git worktree remove
  try {
    execSync(`git worktree remove --force --force "${worktreeDir}"`, { cwd: workspace, stdio: 'pipe' });
  } catch (e) {
    console.warn(`remove-worker: git worktree remove 失敗: ${e.message.split('\n')[0]}`);
  }

  try {
    execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' });
  } catch (e) {
    console.warn(`remove-worker: git worktree prune 失敗: ${e.message.split('\n')[0]}`);
  }

  // git branch -D（worktreeと同名のブランチを削除）
  try {
    execSync(`git branch -D "${workerName}"`, { cwd: workspace, stdio: 'pipe' });
  } catch (e) {
    console.warn(`remove-worker: git branch -D 失敗: ${e.message.split('\n')[0]}`);
  }

  if (existsSync(worktreeDir)) {
    if (IS_WIN) {
      psRemove(worktreeDir);
    } else {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`remove-worker: rmSync 失敗: ${e.message.split('\n')[0]}`);
      }
    }
  }

  if (existsSync(worktreeDir)) {
    console.warn(`remove-worker: worktree "${workerName}" の削除に失敗しました — 次回セッション開始時にreset-session.jsが再試行します`);
  } else {
    console.warn(`remove-worker: worktree "${workerName}" を削除しました`);
  }
} else {
  console.warn(`remove-worker: worktree "${workerName}" のディレクトリが存在しません — スキップします`);
}

// ── workers.jsonから削除 ──────────────────────────────────────────────

delete workers[workerName];
writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
