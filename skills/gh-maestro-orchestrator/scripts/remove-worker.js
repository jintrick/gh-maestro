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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// /exit を送信してagyをグレースフルに終了させてからペインを閉じる
const exitResult = spawnSync('wezterm', ['cli', 'send-text', '--pane-id', paneId, '--no-paste', '/exit\n'], { encoding: 'utf8' });
if (exitResult.status !== 0) {
  console.warn(`remove-worker: /exit 送信失敗 (pane ${paneId}): ${exitResult.stderr.trim()} — kill-paneに進みます`);
}
sleep(1000);

const killResult = spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8' });
if (killResult.status !== 0) {
  console.warn(`remove-worker: kill-pane 失敗 (pane ${paneId}): ${killResult.stderr.trim()} — 削除処理は続行します`);
}

// kill後もプロセス終了を少し待つ
sleep(500);

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
// 事前にロックを解除しておく（locked状態でも --force --force で外せるが、念のため）
try {
  const unlockResult = execSync(`git worktree unlock "${worktreeDir}"`, { cwd: workspace, stdio: 'pipe', encoding: 'utf8' });
  console.log(`remove-worker: worktreeのロックを解除しました`);
} catch (e) {
  // ロックされていない場合もエラーになるので無視
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 2000;
let removed = false;
for (let i = 0; i < MAX_RETRIES; i++) {
  try {
    // stdio: 'pipe' にして実際のgitエラーをキャプチャする
    execSync(`git worktree remove --force --force "${worktreeDir}"`, { cwd: workspace, stdio: 'pipe' });
    removed = true;
    break;
  } catch (e) {
    const gitStderr = (e.stderr || Buffer.alloc(0)).toString().trim();
    const gitStdout = (e.stdout || Buffer.alloc(0)).toString().trim();
    const detail = gitStderr || gitStdout || e.message.split('\n')[0];
    console.warn(`remove-worker: git worktree remove 失敗 (${i + 1}/${MAX_RETRIES}): ${detail}`);
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
    execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' });
  } catch (e) {
    console.warn(`remove-worker: git worktree prune 失敗: ${(e.stderr || Buffer.alloc(0)).toString().trim() || e.message.split('\n')[0]}`);
  }
  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch (e) {
      fail(`worktreeディレクトリの削除に失敗しました: ${worktreeDir}\n  ${e.message}`);
    }
  }
}

// git worktree remove が空ディレクトリを残す場合があるため後処理
if (existsSync(worktreeDir)) {
  try {
    rmdirSync(worktreeDir);
  } catch (e) {
    // 空でなければ失敗するが、その場合は問題なし
    console.warn(`remove-worker: 空ディレクトリ除去スキップ: ${worktreeDir} — ${e.message}`);
  }
}

// workers.json からエントリを削除
delete workers[workerName];
writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
