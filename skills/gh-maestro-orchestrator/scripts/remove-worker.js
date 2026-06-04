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
const { readFileSync, writeFileSync, existsSync, lstatSync, rmdirSync, readdirSync, rmSync } = require('fs');

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const workerName = get('--worker-name');
const workspace  = get('--workspace') ?? process.cwd();

const resetCmd = `node "${resolve(__dirname, 'reset-session.js')}" --workspace "${workspace}"`;
const fail = (msg) => {
  console.error(`remove-worker: ${msg}`);
  console.error(`  → 手動でのリセットが必要な場合は次のコマンドを実行してください:`);
  console.error(`    ${resetCmd}`);
  process.exit(1);
};
if (!workerName) fail('--worker-name が必要です');

const workersJson = resolve(workspace, '.gh-maestro', 'workers.json');
const worktreeDir = resolve(workspace, '.gh-maestro', 'worktrees', workerName);

if (!existsSync(workersJson)) fail(`workers.json が見つかりません: ${workersJson}`);

let workers;
try {
  workers = JSON.parse(readFileSync(workersJson, 'utf8'));
} catch (e) {
  fail(`workers.json のパースに失敗しました: ${e.message}`);
}
const paneId = workers[workerName];
if (!paneId) fail(`ワーカー "${workerName}" が workers.json に存在しません`);

// ワーカーペインをkill（プロセスごと即時終了）
const killResult = spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8' });
if (killResult.status !== 0) {
  console.warn(`remove-worker: kill-pane 失敗 (pane ${paneId}): ${killResult.stderr.trim()} — 削除処理は続行します`);
}

// Windowsではkill後もファイルハンドルが残るため、プロセス終了を待つ
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
sleep(1500);

// worktree内のjunction（node_modules等）を先に外す
// → git worktree remove がリンク先を再帰削除するのを防ぐ
(function unlinkJunctions(dir) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.warn(`remove-worker: readdirSync 失敗: ${dir} — ${e.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    try {
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        rmdirSync(fullPath); // junctionをリンク先を消さずに除去
      } else if (st.isDirectory()) {
        unlinkJunctions(fullPath);
      }
    } catch (e) {
      console.warn(`remove-worker: junction除去失敗: ${fullPath} — ${e.message}`);
    }
  }
})(worktreeDir);

// worktree削除（リトライ付き）
const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 1000;
let removed = false;
for (let i = 0; i < MAX_RETRIES; i++) {
  try {
    execSync(`git worktree remove --force --force "${worktreeDir}"`, { cwd: workspace, stdio: 'inherit' });
    removed = true;
    break;
  } catch (e) {
    console.warn(`remove-worker: git worktree remove 失敗 (${i + 1}/${MAX_RETRIES}): ${e.message.split('\n')[0]}`);
    if (i < MAX_RETRIES - 1) {
      console.warn(`  リトライします...`);
      sleep(RETRY_INTERVAL_MS);
    }
  }
}

if (!removed) {
  // 全リトライ失敗。git worktree prune + Node.js で強制削除。
  console.warn('remove-worker: git worktree remove が全試行失敗。フォールバックで削除します。');
  try {
    execSync('git worktree prune', { cwd: workspace, stdio: 'inherit' });
  } catch (e) {
    console.warn(`remove-worker: git worktree prune 失敗: ${e.message.split('\n')[0]}`);
  }
  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch (e) {
      fail(`worktreeディレクトリの削除に失敗しました: ${worktreeDir}\n  ${e.message}`);
    }
  }
}

// workers.json からエントリを削除
delete workers[workerName];
writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
