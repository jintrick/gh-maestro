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
        readdirSync, statSync, lstatSync, rmdirSync, renameSync } = require('fs');

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };
const workspace = get('--workspace') ?? process.cwd();

const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
const worktreesDir = resolve(workspace, '.gh-maestro', 'worktrees');
const IS_WIN = process.platform === 'win32';

const results = { killed: [], skipped: [], worktrees: [], errors: [] };

const log  = (msg) => console.log(`[reset] ${msg}`);
const warn = (msg) => console.warn(`[reset] ⚠ ${msg}`);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

// ── [Windows] worktreesDir配下で動作中のプロセスをWMIで強制終了 ──

const killProcessesInWorktrees = (dir) => {
  if (!IS_WIN) return 0;
  // WMI の WorkingDirectory は末尾に \ が付く場合があるため TrimEnd で正規化
  const escaped = dir.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const script = [
    `$base = '${escaped}'.TrimEnd('\\\\')`,
    `$killed = 0`,
    `Get-WmiObject Win32_Process | ForEach-Object {`,
    `  $wd = $_.WorkingDirectory`,
    `  if ($wd -ne $null -and $wd.TrimEnd('\\\\').ToLower() -like ($base.ToLower() + '*')) {`,
    `    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue`,
    `    $killed++`,
    `  }`,
    `}`,
    `Write-Output $killed`,
  ].join(' ');
  try {
    const out = execSync(`powershell -NoProfile -Command "${script}"`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    const n = parseInt(out.trim(), 10) || 0;
    if (n > 0) log(`WMI: worktrees配下のプロセスを ${n} 件強制終了しました。`);
    return n;
  } catch (e) {
    warn(`WMIプロセス終了失敗: ${e.message.split('\n')[0]}`);
    return 0;
  }
};

// ── [Windows] PowerShell で強制削除 ──────────────────────────────

const psRemove = (dir) => {
  if (!IS_WIN) return false;
  // Remove-Item -Recurse は PowerShell 5.x で junction を辿り中身を削除するため使用不可。
  // [System.IO.Directory]::Delete は junction 自体を削除し中身を辿らない。
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

// ── [Windows] robocopy で中身を空にしてから削除（最終兵器）───────
// 空ディレクトリを /MIR でミラーリングすることで全ファイルを除去する。
// ロックされたファイルはスキップされるが、その後 rmSync で枠だけ消せることが多い。

const robocopyRemove = (dir) => {
  if (!IS_WIN) return false;
  const tmp = dir + '__empty_tmp__';
  try {
    execSync(`mkdir "${tmp}"`, { stdio: 'pipe' });
    execSync(`robocopy "${tmp}" "${dir}" /MIR /NFL /NDL /NJH /NJS /nc /ns /np`,
      { stdio: 'pipe', timeout: 15000 });
    execSync(`rmdir /S /Q "${tmp}"`, { stdio: 'pipe' });
    execSync(`rmdir /S /Q "${dir}"`, { stdio: 'pipe' });
    return !existsSync(dir);
  } catch (_) {
    try { execSync(`rmdir /S /Q "${tmp}"`, { stdio: 'pipe' }); } catch (_2) { /* ignore */ }
    return !existsSync(dir);
  }
};

// ── 削除できない場合はリネームして quarantine ────────────────────
// リネームはファイルハンドルを保持していても大抵成功する（パス変更のみ）。
// __orphan_* は次回 reset 時に再試行される。

const quarantine = (dir) => {
  const orphan = resolve(worktreesDir, `__orphan_${Date.now()}`);
  try {
    renameSync(dir, orphan);
    warn(`削除不可のため quarantine しました: ${orphan}`);
    return { ok: true, quarantined: true };
  } catch (e) {
    return { ok: false, reason: `quarantine失敗: ${e.message}` };
  }
};

// ── __orphan_* の後始末（前回残骸を再試行） ──────────────────────

const cleanupOrphans = () => {
  if (!existsSync(worktreesDir)) return;
  let entries;
  try { entries = readdirSync(worktreesDir); } catch (_) { return; }
  for (const e of entries) {
    if (!e.startsWith('__orphan_')) continue;
    const dir = resolve(worktreesDir, e);
    log(`前回の quarantine を再試行: ${e}`);
    if (psRemove(dir) || robocopyRemove(dir)) {
      log(`  → 削除成功: ${e}`);
    } else {
      warn(`  → 削除失敗（次回も再試行します）: ${e}`);
    }
  }
};

// ── worktreeを削除する（junction除去 → git → PowerShell → robocopy → quarantine） ──

const removeWorktree = (dir) => {
  unlinkJunctions(dir);

  try {
    execSync(`git worktree remove --force --force "${dir}"`, { cwd: workspace, stdio: 'pipe' });
    if (!existsSync(dir)) return { ok: true };
  } catch (e) {
    warn(`git worktree remove 失敗: ${e.message.split('\n')[0]}`);
  }

  try {
    execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' });
  } catch (e) {
    warn(`git worktree prune 失敗: ${e.message.split('\n')[0]}`);
  }

  if (!existsSync(dir)) return { ok: true };

  // PowerShell Remove-Item（Windows主役、非Windowsは rmSync）
  if (IS_WIN) {
    if (psRemove(dir)) return { ok: true };
  } else {
    try {
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return { ok: true };
    } catch (e) {
      warn(`rmSync 失敗: ${e.message.split('\n')[0]}`);
    }
  }

  // robocopy で強制削除（Windows限定）
  if (IS_WIN && robocopyRemove(dir)) return { ok: true };

  // 最終手段: quarantine（セッションをブロックしないためリネームして退避）
  return quarantine(dir);
};

// ═══════════════════════════════════════════════════════════════════
// 1. 前回の quarantine ゴミを掃除
// ═══════════════════════════════════════════════════════════════════

log('前回の quarantine 残骸を確認します...');
cleanupOrphans();

// ═══════════════════════════════════════════════════════════════════
// 2. ワーカーペインをkill
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// 3. worktrees配下のプロセスをWMIで直接終了（Windows）
//    kill-pane がペインを閉じても子プロセスが生き残る場合への対策
// ═══════════════════════════════════════════════════════════════════

if (existsSync(worktreesDir)) {
  log('worktrees配下で動作中のプロセスを確認・終了します...');
  const killed = killProcessesInWorktrees(worktreesDir);
  if (killed > 0) {
    // プロセス終了後、OSがハンドルを解放するまで少し待つ
    log('プロセス終了を待ちます (1秒)...');
    sleep(1000);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4. worktreesディレクトリ以下を全削除
// ═══════════════════════════════════════════════════════════════════

log('worktreeを削除します...');
if (existsSync(worktreesDir)) {
  let entries = [];
  try {
    entries = readdirSync(worktreesDir).filter(e => {
      if (e.startsWith('__orphan_')) return false; // cleanupOrphans で処理済み
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
      if (result.quarantined) {
        warn(`worktree "${entry}" は quarantine しました（次回リセット時に削除されます）。`);
      } else {
        log(`worktree "${entry}" を削除しました。`);
      }
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

// ═══════════════════════════════════════════════════════════════════
// 5. workers.json をリセット
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// 6. サマリー
// ═══════════════════════════════════════════════════════════════════

log('');
log('=== リセット完了 ===');
if (results.killed.length)    log(`kill済み:        ${results.killed.join(', ')}`);
if (results.skipped.length)   log(`スキップ:        ${results.skipped.join(', ')}`);
if (results.worktrees.length) log(`worktree削除:    ${results.worktrees.join(', ')}`);
if (results.errors.length) {
  warn(`失敗項目 (次回セッション開始には影響しません):`);
  results.errors.forEach(e => warn(`  ${e}`));
} else {
  log('全項目正常に完了しました。');
}
