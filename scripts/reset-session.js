#!/usr/bin/env node
// reset-session.js
// gh-maestroセッションを強制リセットする。
// workers.jsonの破損・pane消滅・worktree残骸など、どんな状態からでも
// できる限りクリーンアップしてから終了する（途中エラーで止まらない）。
//
// Usage:
//   node reset-session.js [--workspace <path>]

const { spawnSync, execSync } = require('./child-process');
const path = require('path');
const { resolve } = path;
const { existsSync, readFileSync, writeFileSync, rmSync,
        readdirSync, statSync, renameSync, unlinkSync } = require('fs');
const { unlinkJunctions } = require('./unlink-junctions');
const { normalizeWorkerEntry } = require('./worker-entry');
const { killProcessTree } = require('./kill-tree');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { worktreeRemove, worktreePrune } = require('./git-worktree');
const { sweepRegistry } = require('./process-lifecycle');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const USAGE = `reset-session.js — gh-maestro セッションを強制リセットする

Usage: node reset-session.js [--workspace <path>] [--quiet]

Options:
  --workspace <path>  ワークスペース（デフォルト CWD）
  --quiet             進捗ログを抑制する

workers.json の破損・pane 消滅・worktree 残骸など、どんな状態からでもできる限り
クリーンアップしてから終了する（途中エラーで止まらない）。`;

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--workspace'], ['--quiet']);

  // exitFlagMiss（値欠落）を先に判定する。未消費の値トークンが rest に残るため、
  // それがたまたま "--help" と一致すると後段の hasHelpFlag が誤検出しうる。
  // 値欠落は常にエラー優先（フェイルクローズ）とする。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }
  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }
  const workspace = values['--workspace'] ?? process.cwd();
  const quiet = values['--quiet'] === true;

  const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
  const worktreesDir = resolve(workspace, '.gh-maestro', 'worktrees');
  const IS_WIN = process.platform === 'win32';

  const results = { killed: [], skipped: [], worktrees: [], errors: [] };

  const log  = (msg) => { if (!quiet) console.log(`[reset] ${msg}`); };
  const warn = (msg) => console.warn(`[reset] ⚠ ${msg}`);

  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  // ── 現在 WezTerm に存在する pane_id の Set を返す ────────────────

  const getAlivePaneIds = () => {
    const r = spawnSync('wezterm', ['cli', '--no-auto-start', 'list', '--format', 'json'], { encoding: 'utf8' });
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

  // ── junction/symlinkを除去する（unlink-junctions.js 参照） ──────

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
    ].join('; ');
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
      execSync(`robocopy "${tmp}" "${dir}" /MIR /XJ /NFL /NDL /NJH /NJS /nc /ns /np`,
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
    unlinkJunctions(dir, warn);

    try {
      worktreeRemove(dir, workspace, { doubleForce: true });
      if (!existsSync(dir)) return { ok: true };
    } catch (e) {
      warn(`git worktree remove 失敗: ${e.message.split('\n')[0]}`);
    }

    try {
      worktreePrune(workspace);
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
  // 2. ワーカープロセスをkill
  // ═══════════════════════════════════════════════════════════════════

  log('ワーカープロセスをkillします...');
  const workers = loadWorkers();
  const alivePanes = getAlivePaneIds();

  for (const [name, entry] of Object.entries(workers)) {
    if (name === 'orchestrator') continue;
    const normalized = normalizeWorkerEntry(entry);

    // 後方互換: レガシーな detached notifier（poll-and-notify.js）を kill
    // 過去のセッションの workers.json には notifierPid が残っている可能性がある。
    if (normalized.notifierPid) {
      killProcessTree(normalized.notifierPid);
      log(`"${name}" のレガシー notifier (pid ${normalized.notifierPid}) を終了しました。`);
    }

    let handled = false;

    // headless ワーカー: 登録PIDは中継シムのもの。配下にログインシェルとエージェント本体が
    // ぶら下がるためツリー全体を落とす。
    if (normalized.pid) {
      if (isWorkerAlive(normalized)) {
        killProcessTree(normalized.pid);
        log(`"${name}" (pid ${normalized.pid}) をkillしました。`);
        results.killed.push(name);
      } else {
        log(`"${name}" (pid ${normalized.pid}) は既に終了しています。スキップ。`);
        results.skipped.push(name);
      }
      handled = true;
    }

    // 後方互換: 移行前セッション（Issue #151 以前）が残した WezTerm ペインを kill。
    // 起動経路が headless に変わってもこの掃除経路は必要である
    // （.claude/rules/legacy-process-cleanup-safety.md 参照）。
    const id = normalized.paneId ?? '';
    if (id) {
      if (alivePanes.size > 0 && !alivePanes.has(id)) {
        log(`"${name}" のレガシーpane ${id} は既に存在しません。スキップ。`);
        if (!handled) results.skipped.push(name);
      } else {
        const r = spawnSync('wezterm', ['cli', '--no-auto-start', 'kill-pane', '--pane-id', id], { encoding: 'utf8' });
        if (r.status === 0) {
          log(`"${name}" のレガシーpane ${id} をkillしました。`);
          if (!handled) results.killed.push(name);
        } else {
          warn(`"${name}" のレガシーpane ${id} のkillに失敗しました: ${(r.stderr || '').trim()}`);
          if (!handled) results.skipped.push(name);
        }
      }
      handled = true;
    }

    if (!handled) {
      warn(`"${name}" に終了対象のプロセスが記録されていません。スキップ。`);
      results.skipped.push(name);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. worktrees配下のプロセスをWMIで直接終了（Windows）
  //    プロセスツリーのkillを取りこぼした場合への最終手段
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
    worktreePrune(workspace);
    log('git worktree prune 完了。');
  } catch (e) {
    warn(`git worktree prune 失敗: ${e.message.split('\n')[0]}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. poll-state-* / poll-sha-* ゴミファイルを削除
  // ═══════════════════════════════════════════════════════════════════

  log('poll-* ファイルを削除します...');
  const ghMaestroDir = resolve(workspace, '.gh-maestro');
  if (existsSync(ghMaestroDir)) {
    let pollFiles = [];
    try { pollFiles = readdirSync(ghMaestroDir).filter(f => f.startsWith('poll-')); } catch (_) {}
    for (const f of pollFiles) {
      try {
        unlinkSync(resolve(ghMaestroDir, f));
        log(`削除: ${f}`);
      } catch (e) {
        warn(`poll ファイル削除失敗: ${f} — ${e.message}`);
      }
    }
    if (pollFiles.length === 0) log('poll-* ファイルなし。スキップ。');
  }

  // Phase 4 で .gh-maestro/messages/ は廃止（queue/inbox/ に移行）。
  // 既存セッションの残骸を掃除するため、存在すれば削除する（レガシークリーンアップ）。
  log('.gh-maestro/messages/ のレガシー残骸を掃除します...');
  const messagesDir = resolve(workspace, '.gh-maestro', 'messages');
  if (existsSync(messagesDir)) {
    try {
      rmSync(messagesDir, { recursive: true, force: true });
      log('messages/（レガシー）を削除しました。');
    } catch (e) {
      warn(`messages/（レガシー）削除失敗: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. msg-state の掃除
  // ═══════════════════════════════════════════════════════════════════

  log('msg-state を掃除します...');
  const msgStateDir = resolve(workspace, '.gh-maestro', 'msg-state');
  if (existsSync(msgStateDir)) {
    try {
      rmSync(msgStateDir, { recursive: true, force: true });
      log('msg-state/ を削除しました。');
    } catch (e) {
      warn(`msg-state/ 削除失敗: ${e.message}`);
    }
  } else {
    log('msg-state/ なし。スキップ。');
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. queue 状態の掃除（後方互換: 旧FSキューセッションの残骸を掃除）
  //    queue.js / queue-poller.js は削除済みのため fs 直叩きのみで行う。
  // ═══════════════════════════════════════════════════════════════════

  // ── 後方互換: レガシー queue-poller（detached 常駐プロセス）を kill ──────
  // Phase 2 以前に起動されたセッションの .gh-maestro/queue/poller.json には
  // detached queue-poller の pid が残っている可能性がある。poller.json を読んで
  // heartbeat が新鮮なら best-effort で kill する（PID 再利用レース対策）。
  // poller.json 本体は後続の queue ディレクトリ削除で一緒に消える。
  {
    const pollerJsonPath = resolve(workspace, '.gh-maestro', 'queue', 'poller.json');
    if (existsSync(pollerJsonPath)) {
      try {
        const pollerState = JSON.parse(readFileSync(pollerJsonPath, 'utf8'));
        const elapsed = Date.now() - (pollerState.heartbeat || 0);
        if (elapsed > 15000) {
          log(`poller.json の heartbeat が ${Math.floor(elapsed / 1000)}s 前で stale のため kill をスキップします。`);
        } else if (pollerState.pid && pollerState.pid > 0) {
          try {
            process.kill(pollerState.pid, 0); // 生存確認（死んでいれば ESRCH）
            killProcessTree(pollerState.pid); // detached → 子プロセスごと kill
            log(`レガシー poller (pid ${pollerState.pid}) を終了しました。`);
            results.killed.push(`legacy-poller(${pollerState.pid})`);
          } catch (e) {
            if (e.code === 'ESRCH') {
              log(`レガシー poller (pid ${pollerState.pid}) は既に終了しています。`);
            } else {
              warn(`レガシー poller (pid ${pollerState.pid}) の kill に失敗しました: ${e.message}`);
            }
          }
        }
      } catch (e) {
        warn(`poller.json の読み取りに失敗しました（queue 削除は続行します）: ${e.message}`);
      }
    }
  }

  log('キュー状態を掃除します...');
  const queueDir = resolve(workspace, '.gh-maestro', 'queue');
  if (existsSync(queueDir)) {
    // 1. junction を先に除去（共有 junction を辿って中身を削除しないため）
    try {
      unlinkJunctions(queueDir, warn);
    } catch (e) {
      warn(`queue/ の junction 除去に失敗しました（後続処理は続行します）: ${e.message}`);
    }

    // 2. EBUSY/EPERM リトライ付きで削除
    let removed = false;
    for (let attempt = 0; attempt <= 5 && !removed; attempt++) {
      try {
        rmSync(queueDir, { recursive: true, force: true });
        removed = true;
      } catch (e) {
        if (e.code === 'ENOENT') {
          // TOCTOU: 別プロセスが先に削除した → 成功扱い
          removed = true;
        } else if (e.code === 'EBUSY' || e.code === 'EPERM') {
          if (attempt < 5) {
            sleep(20);
          } else {
            warn(`queue/ 削除失敗（リトライ超過）: ${e.message}`);
          }
        } else {
          warn(`queue/ 削除失敗: ${e.message}`);
          break;
        }
      }
    }
    if (removed) {
      log('queue/ を削除しました。');
    }
  } else {
    log('queue/ なし。スキップ。');
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8. PID registry sweep（全エントリを同一性確認の上で掃除）
  //    req.10: registry 全体を読み取り、全エントリを同一性確認の上でkill
  // ═══════════════════════════════════════════════════════════════════

  log('PID registry を sweep します...');
  {
    const sweepResults = sweepRegistry(workspace);
    if (sweepResults.killed.length > 0) {
      log(`PID registry: ${sweepResults.killed.length} 件のプロセスを終了しました`);
      for (const k of sweepResults.killed) {
        log(`  pid=${k.pid} worker=${k.workerName || '-'} script=${k.script || '-'}`);
      }
      results.killed.push(...sweepResults.killed.map(k => `pid-registry-${k.pid}`));
    }
    if (sweepResults.cleaned.length > 0) {
      log(`PID registry: ${sweepResults.cleaned.length} 件のstaleエントリを掃除しました`);
    }
    for (const e of sweepResults.errors) {
      warn(`PID registry error: ${e}`);
      results.errors.push(`pid-registry: ${e}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 9. workers.json をリセット
  // ═══════════════════════════════════════════════════════════════════

  log('workers.json をリセットします...');
  // orchestrator エントリはワーカー走査時に一律スキップされる予約キー。
  // WezTerm脱却によりペインIDを持たなくなったため、存在だけを保持する。
  const fresh = { orchestrator: { agentId: null } };
  try {
    writeFileSync(workersJson, JSON.stringify(fresh, null, 2), 'utf8');
    log('workers.json をリセットしました。');
  } catch (e) {
    warn(`workers.json の書き込みに失敗しました: ${e.message}`);
    results.errors.push(`workers.json write: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. サマリー
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
}
