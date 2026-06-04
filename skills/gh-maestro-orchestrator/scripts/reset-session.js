#!/usr/bin/env node
// reset-session.js
// gh-maestroセッションを強制リセットする。
// workers.jsonの破損・pane消滅・worktree残骸など、どんな状態からでも
// できる限りクリーンアップしてから終了する（途中エラーで止まらない）。
//
// Usage:
//   node reset-session.js [--workspace <path>]

const { spawnSync, execSync } = require('child_process');
const { resolve } = require('path');
const { existsSync, readFileSync, writeFileSync, rmSync,
        readdirSync, statSync, lstatSync, rmdirSync } = require('fs');

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };
const workspace = get('--workspace') ?? process.cwd();

const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
const worktreesDir = resolve(workspace, '.gh-maestro', 'worktrees');

const results = { killed: [], skipped: [], worktrees: [], errors: [] };

const log  = (msg) => console.log(`[reset] ${msg}`);
const warn = (msg) => console.warn(`[reset] ⚠ ${msg}`);

// ── 現在 WezTerm に存在する pane_id の Set を返す ────────────────

const getAlivePaneIds = () => {
  const r = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) {
    warn(`wezterm cli list 失敗: ${r.stderr.trim()} — pane生存確認をスキップします`);
    return new Set();
  }
  try {
    return new Set(JSON.parse(r.stdout).map(p => String(p.pane_id)));
  } catch (e) {
    warn(`wezterm cli list の出力パース失敗: ${e.message} — pane生存確認をスキップします`);
    return new Set();
  }
};

// ── workers.json を安全に読む ─────────────────────────────────────

const loadWorkers = () => {
  if (!existsSync(workersJson)) return {};
  try {
    const parsed = JSON.parse(readFileSync(workersJson, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    warn(`workers.json の内容が不正です（型: ${typeof parsed}）。空として扱います。`);
    return {};
  } catch (e) {
    warn(`workers.json のパースに失敗しました: ${e.message} — 空として扱います。`);
    return {};
  }
};

// ── junction/symlinkを除去する ────────────────────────────────────

const unlinkJunctions = (dir) => {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    warn(`readdirSync 失敗: ${dir} — ${e.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    try {
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        rmdirSync(fullPath);
      } else if (st.isDirectory()) {
        unlinkJunctions(fullPath);
      }
    } catch (e) {
      warn(`junction除去失敗: ${fullPath} — ${e.message}`);
    }
  }
};

// ── worktreeを削除する（junction除去 → git → prune → rmSync） ────

const removeWorktree = (dir) => {
  unlinkJunctions(dir);

  try {
    execSync(`git worktree remove --force --force "${dir}"`, { cwd: workspace, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    warn(`git worktree remove 失敗: ${e.message.split('\n')[0]}`);
  }

  try {
    execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' });
  } catch (e) {
    warn(`git worktree prune 失敗: ${e.message.split('\n')[0]}`);
  }

  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, reason: `rmSync 失敗: ${e.message}` };
    }
  }
  return { ok: true };
};

// ── 1. ワーカーペインをkill ───────────────────────────────────────

log('ワーカーペインをkillします...');
const workers = loadWorkers();
const alivePanes = getAlivePaneIds();

for (const [name, paneId] of Object.entries(workers)) {
  if (name === 'orchestrator') continue;
  const id = String(paneId ?? '');
  if (!id) {
    warn(`"${name}" の pane_id が空です。スキップ。`);
    results.skipped.push(name);
    continue;
  }
  if (alivePanes.size > 0 && !alivePanes.has(id)) {
    log(`"${name}" (pane ${id}) は既に存在しません。スキップ。`);
    results.skipped.push(name);
    continue;
  }
  const r = spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', id], { encoding: 'utf8' });
  if (r.status === 0) {
    log(`"${name}" (pane ${id}) をkillしました。`);
    results.killed.push(name);
  } else {
    warn(`"${name}" (pane ${id}) のkillに失敗しました: ${r.stderr.trim()}`);
    results.skipped.push(name);
  }
}

// ── 2. worktreesディレクトリ以下を全削除 ─────────────────────────

log('worktreeを削除します...');
if (existsSync(worktreesDir)) {
  let entries = [];
  try {
    entries = readdirSync(worktreesDir).filter(e => {
      try { return statSync(resolve(worktreesDir, e)).isDirectory(); } catch (e2) {
        warn(`statSync 失敗: ${e} — ${e2.message}`);
        return false;
      }
    });
  } catch (e) {
    warn(`worktreesDir の読み取りに失敗しました: ${e.message}`);
  }
  for (const entry of entries) {
    const dir = resolve(worktreesDir, entry);
    const result = removeWorktree(dir);
    if (result.ok) {
      log(`worktree "${entry}" を削除しました。`);
      results.worktrees.push(entry);
    } else {
      warn(`worktree "${entry}" の削除に失敗しました: ${result.reason}`);
      results.errors.push(`${entry}: ${result.reason}`);
    }
  }
} else {
  log('worktreesディレクトリが存在しません。スキップ。');
}

try {
  execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' });
  log('git worktree prune 完了。');
} catch (e) {
  warn(`git worktree prune 失敗: ${e.message.split('\n')[0]}`);
}

// ── 3. workers.json をリセット ───────────────────────────────────

log('workers.json をリセットします...');
const orchPaneId = process.env.WEZTERM_PANE ?? null;
const fresh = orchPaneId ? { orchestrator: orchPaneId } : {};
try {
  writeFileSync(workersJson, JSON.stringify(fresh, null, 2), 'utf8');
  log(`workers.json をリセットしました。${orchPaneId ? `orchestrator pane: ${orchPaneId}` : 'orchestratorのpane_idは次回spawn時に設定されます。'}`);
} catch (e) {
  warn(`workers.json の書き込みに失敗しました: ${e.message}`);
  results.errors.push(`workers.json write: ${e.message}`);
}

// ── 4. サマリー ──────────────────────────────────────────────────

log('');
log('=== リセット完了 ===');
if (results.killed.length)    log(`kill済み:        ${results.killed.join(', ')}`);
if (results.skipped.length)   log(`スキップ:        ${results.skipped.join(', ')}`);
if (results.worktrees.length) log(`worktree削除:    ${results.worktrees.join(', ')}`);
if (results.errors.length) {
  warn(`失敗項目:`);
  results.errors.forEach(e => warn(`  ${e}`));
} else {
  log('全項目正常に完了しました。');
}
