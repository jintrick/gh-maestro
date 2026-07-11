#!/usr/bin/env node
// remove-worker.js
// ワーカーペインをkillし、worktreeを即座に削除し、workers.jsonからエントリを削除する。
// ディレクトリ実体がロックで残っても（kill直後のハンドル未解放。Windowsでは正常）
// 次回reset-session.jsがjunction非追跡で安全に掃除する。残骸を手動rmしないこと。
//
// Usage:
//   node remove-worker.js \
//     --worker-name <name> \
//     --workspace <path>

const { spawnSync, execSync } = require('./child-process');
const { resolve } = require('path');
const { readFileSync, writeFileSync, existsSync, rmSync } = require('fs');
const { unlinkJunctions } = require('./unlink-junctions');
const { normalizeWorkerEntry } = require('./worker-entry');
const { worktreeRemove, worktreePrune } = require('./git-worktree');
const { killProcessTree } = require('./kill-tree');
const { sweepRegistry } = require('./process-lifecycle');

const USAGE = `remove-worker.js — ワーカーのペインを kill し worktree を削除する

Usage: node remove-worker.js --worker-name <name> [--workspace <path>]

Options:
  --worker-name <name>  削除するワーカー名（必須）
  --workspace <path>    ワークスペース（デフォルト CWD）

ペインを kill し、worktree と同名ブランチを削除し、workers.json からエントリを除く。
ディレクトリがロックで残っても次回 reset-session.js が junction 非追跡で安全に掃除する
（残骸を手動 rm しないこと。node_modules junction を辿って共有ファイルを壊す）。`;

// argv を1回だけ順に走査し、各フラグが消費した値をフラグ判定の対象から除外する。
// これをしないと --worker-name '--help' のような値そのものが誤ってフラグとして解釈される。
function parseArgs(argv) {
  let help = false;
  let workerName, workspace;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--worker-name') {
      workerName = argv[++i];
    } else if (a === '--workspace') {
      workspace = argv[++i];
    }
  }
  return { help, workerName, workspace };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { help, workerName, workspace: workspaceArg } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    process.exit(0);
  }

  const workspace = workspaceArg ?? process.cwd();

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

  const workerEntry = normalizeWorkerEntry(workers[workerName]);
  const paneId = workerEntry.paneId;

  // ── 後方互換: レガシーな detached notifier（poll-and-notify.js）を kill ──────
  // Phase 1 以前に起動されたセッションの workers.json には notifierPid が残っている可能性がある。
  // Phase 2 以降の新規 spawn では notifier は起動されないが、移行過渡期の後方互換として残す。
  if (workerEntry.notifierPid) {
    killProcessTree(workerEntry.notifierPid);
    console.warn(`remove-worker: レガシー notifier (pid ${workerEntry.notifierPid}) を終了しました`);
  }

  if (!paneId) {
    console.warn(`remove-worker: ワーカー "${workerName}" の pane_id が workers.json に存在しません — worktree削除のみ実行します`);
  } else {
    const exitResult = spawnSync('wezterm', ['cli', '--no-auto-start', 'send-text', '--pane-id', paneId, '--no-paste', '/exit\n'], { encoding: 'utf8' });
    if (exitResult.status !== 0) {
      console.warn(`remove-worker: /exit 送信失敗 (pane ${paneId}): ${exitResult.stderr.trim()} — kill-paneに進みます`);
    }
    sleep(1000);

    const killResult = spawnSync('wezterm', ['cli', '--no-auto-start', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8' });
    if (killResult.status !== 0) {
      console.warn(`remove-worker: kill-pane 失敗 (pane ${paneId}): ${killResult.stderr.trim()}`);
    }

    // プロセスがハンドルを解放するまで少し待つ
    sleep(500);
  }

  // ── PID registry sweep: ワーカーの登録PIDを同一性確認の上で kill ─────
  // req.9: workerName に紐づく登録PIDを発見し、同一性確認後にkillする
  {
    const sweepResults = sweepRegistry(workspace, {
      match: (entry) => entry.workerName === workerName,
    });
    if (sweepResults.killed.length > 0) {
      console.warn(`remove-worker: PID registry: ${sweepResults.killed.length} 件のプロセスを終了しました`);
      for (const k of sweepResults.killed) {
        console.warn(`remove-worker:   pid=${k.pid} script=${k.script || '-'}`);
      }
    }
    if (sweepResults.cleaned.length > 0) {
      console.warn(`remove-worker: PID registry: ${sweepResults.cleaned.length} 件のstaleエントリを掃除しました`);
    }
    for (const e of sweepResults.errors) {
      console.warn(`remove-worker: PID registry error: ${e}`);
    }
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
      worktreeRemove(worktreeDir, workspace, { doubleForce: true });
    } catch (e) {
      console.warn(`remove-worker: git worktree remove 失敗: ${e.message.split('\n')[0]}`);
    }

    try {
      worktreePrune(workspace);
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
      console.warn(`remove-worker: worktree "${workerName}" のメタデータ・ブランチ・workers.json エントリは削除済み。ディレクトリ実体だけがロックで残りました（kill直後のハンドル未解放。Windowsでは正常な挙動で、失敗ではありません）。次回セッションの reset-session.js が junction 非追跡で安全に掃除します。`);
      console.warn(`remove-worker: [重要・orchestratorへ] この残骸ディレクトリを手動の rm / rm -rf で消さないこと。worktree 内の node_modules は共有ワークスペースへの junction であり、rm は junction を辿って共有ファイルを破壊します。放置して reset-session.js に任せてください。`);
    } else {
      console.warn(`remove-worker: worktree "${workerName}" を削除しました`);
    }
  } else {
    console.warn(`remove-worker: worktree "${workerName}" のディレクトリが存在しません — スキップします`);
  }

  // ── msg-state の削除 ────────────────────────────────────────────────────
  // GitHub コメントのポーリングカーソルを削除する（ベストエフォート、ENOENT は成功扱い）。
  {
    const msgStateFile = resolve(workspace, '.gh-maestro', 'msg-state', `${workerName}.json`);
    try {
      if (existsSync(msgStateFile)) {
        rmSync(msgStateFile);
        console.warn(`remove-worker: msg-state "${workerName}.json" を削除しました`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`remove-worker: msg-state 削除に失敗しました（ワーカー削除は続行します）: ${e.message}`);
      }
    }
  }

  // ── workers.jsonから削除 ──────────────────────────────────────────────

  delete workers[workerName];
  writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
}

module.exports = { parseArgs };
