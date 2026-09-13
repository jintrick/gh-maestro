#!/usr/bin/env node
// reset-session.js
// gh-maestroセッションを強制リセットする。
// workers.jsonの破損・pane消滅・worktree残骸など、どんな状態からでも
// できる限りクリーンアップしてから終了する（途中エラーで止まらない）。
//
// Usage:
//   node reset-session.js [--workspace <path>]

const {
  spawnSync,
  execSync,
  REAL_SPAWN_DISABLED_ERROR_CODE,
} = require('./shared/child-process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolve } = path;
const { existsSync, readFileSync, rmSync,
        readdirSync, statSync, renameSync, unlinkSync } = require('fs');
const { unlinkJunctions } = require('./shared/unlink-junctions');
const { normalizeWorkerEntry } = require('./shared/worker-entry');
const { killProcessTree } = require('./shared/kill-tree');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { worktreeRemove, worktreePrune } = require('./shared/git-worktree');
const { sweepRegistry, isProcessAlive } = require('./process-lifecycle');
const { getAlivePaneIds, killPane } = require('./shared/pane-launch');
const { loadStatusPane, removeStatusPane } = require('./shared/status-pane-registry');
const { readWorkersRaw } = require('./shared/workers-registry');
const { atomicWriteJson } = require('./shared/atomic-write');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const {
  captureResidentEntries,
  restartResidents,
  formatResidentResult,
} = require('./shared/restart-residents');
const readStateLib = require('./shared/read-state');

/**
 * 全体リセットのPID registry sweep後に、停止前に捕捉した常駐だけを立て直す。
 * sweep前のエントリを受け取ることで、reset-sessionが削除したregistry情報を
 * 再発見しようとして別プロセスを推測することを防ぐ。sweepは稼働中の常駐を
 * kill対象から除外するため、既定ではここで既存プロセスを停止してから現行コードを
 * 起動する。既に別経路で停止済みの場合だけ、呼び出し元が skipStop を明示できる。
 */
function restartCapturedResidents(workspace, entries, scriptsPath, opts = {}) {
  return restartResidents(workspace, {
    ...opts,
    scriptsPath,
    preCapturedEntries: entries,
    skipStop: opts.skipStop ?? false,
  });
}

function validCleanupPid(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isInteger(Number(value)) && Number(value) > 0;
}

function validCleanupPaneId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

function readCleanupWorkers(workspace, readWorkersFn = readWorkersRaw) {
  if (readWorkersFn === readWorkersRaw) {
    const workersPath = path.resolve(workspace, '.gh-maestro', 'workers.json');
    try {
      const stat = fs.lstatSync(workersPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('workers.json が通常ファイルではありません');
      }
    } catch (error) {
      if (!(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
    }
  }
  const workers = readWorkersFn(workspace);
  if (workers === null) return null;
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) {
    throw new Error('workers.json はオブジェクトである必要があります');
  }
  return workers;
}

/**
 * workers.json に残った notifierPid / paneId を安全に整理する共通 primitive。
 * PID は生存確認後に必要なら停止し、全対象の観測が済んでから registry を原子的に更新する。
 * @param {string} workspace
 * @param {'notifierPid'|'paneId'} field
 * @param {object} [options]
 */
function cleanupLegacyWorkerField(workspace, field, options = {}) {
  if (!['notifierPid', 'paneId'].includes(field)) throw new Error(`未知のlegacy worker fieldです: ${field}`);
  const readWorkersFn = options.readWorkersFn || readWorkersRaw;
  const workers = readCleanupWorkers(workspace, readWorkersFn);
  const workersPath = path.resolve(workspace, '.gh-maestro', 'workers.json');
  if (workers === null) return { status: 'absent', path: workersPath, field };

  const isProcessAliveFn = options.isProcessAliveFn || isProcessAlive;
  const killProcessTreeFn = options.killProcessTreeFn || killProcessTree;
  const atomicWriteFn = options.atomicWriteFn || atomicWriteJson;
  const getAlivePaneIdsFn = options.getAlivePaneIdsFn || getAlivePaneIds;
  const killPaneFn = options.killPaneFn || killPane;
  const sleepFn = options.sleepFn || (() => {});
  const persist = options.persist !== false;
  const targetNames = options.targetNames ? new Set(options.targetNames) : null;
  const nextWorkers = { ...workers };
  const targets = [];
  const killedPids = [];
  const skippedPids = [];
  const skippedPanes = [];
  const paneResults = [];
  const notifierResults = [];

  for (const [name, rawEntry] of Object.entries(workers)) {
    if (name === 'orchestrator' || (targetNames && !targetNames.has(name))) continue;
    const isObject = rawEntry !== null && typeof rawEntry === 'object' && !Array.isArray(rawEntry);
    const rawValue = isObject ? rawEntry[field] : field === 'paneId' ? rawEntry : undefined;
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    if (field === 'notifierPid') {
      if (!validCleanupPid(rawValue)) throw new Error(`workers.json の ${name}.${field} は正の整数PIDではありません`);
      const pid = Number(rawValue);
      const alive = isProcessAliveFn(pid);
      if (typeof alive !== 'boolean') throw new Error(`PID ${pid} の生存確認がbooleanを返しませんでした`);
      if (alive) {
        killProcessTreeFn(pid);
        const remaining = isProcessAliveFn(pid);
        if (remaining !== false) throw new Error(`レガシー notifier (pid ${pid}) の停止を確認できませんでした`);
        killedPids.push(pid);
        notifierResults.push({ name, pid, status: 'killed' });
      } else {
        skippedPids.push(pid);
        notifierResults.push({ name, pid, status: 'absent' });
      }
    } else {
      if (!validCleanupPaneId(rawValue)) {
        throw new Error(`workers.json の ${name}.${field} は正の整数paneIdではありません`);
      }
      const paneId = String(rawValue);
      if (!paneId) throw new Error(`workers.json の ${name}.${field} が空です`);
      let alivePanes = options.alivePanes;
      if (alivePanes === undefined) alivePanes = getAlivePaneIdsFn(options.warnFn || (() => {}));
      if (!(alivePanes instanceof Set)) throw new Error('legacy paneの生存一覧を確認できませんでした');
      if (alivePanes.has(paneId) || alivePanes.has(rawValue)) {
        let result;
        try {
          result = killPaneFn(paneId);
        } catch (error) {
          if (options.strictPane === false) {
            paneResults.push({ name, paneId, status: 'unknown', reason: error.message });
            targets.push({ name, rawEntry, isObject });
            continue;
          }
          throw error;
        }
        if (!result || result.ok !== true) {
          if (options.strictPane === false) {
            paneResults.push({ name, paneId, status: 'unknown', reason: result?.stderr || '(empty)' });
            targets.push({ name, rawEntry, isObject });
            continue;
          }
          throw new Error(`レガシーpane ${paneId} のkillに失敗しました: ${result?.stderr || '(empty)'}`);
        }
        sleepFn(options.paneWaitMs ?? 0);
        paneResults.push({ name, paneId, status: 'killed' });
      } else {
        skippedPanes.push(paneId);
        paneResults.push({ name, paneId, status: 'absent' });
      }
    }
    targets.push({ name, rawEntry, isObject });
  }

  if (targets.length === 0) return { status: 'absent', path: workersPath, field };
  for (const { name, rawEntry, isObject } of targets) {
    nextWorkers[name] = isObject ? { ...rawEntry, [field]: null } : { [field]: null };
  }
  if (persist) atomicWriteFn(workersPath, nextWorkers);
  return {
    status: 'removed',
    path: workersPath,
    field,
    workers: targets.map(({ name }) => name),
    killedPids,
    skippedPids,
    skippedPanes,
    notifierResults,
    paneResults,
  };
}

function cleanupLegacyMessages(workspace, options = {}) {
  const target = path.resolve(workspace, '.gh-maestro', 'messages');
  const lstatFn = options.lstatFn || fs.lstatSync;
  let stat;
  try {
    stat = lstatFn(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { status: 'absent', path: target };
    return { status: 'unknown', path: target, reason: error.message };
  }
  try {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      (options.unlinkFn || unlinkSync)(target);
    } else {
      (options.rmFn || ((p) => rmSync(p, { recursive: true, force: false })))(target);
    }
  } catch (error) {
    return { status: 'unknown', path: target, reason: `messagesの削除に失敗しました: ${error.message}` };
  }
  return { status: 'removed', path: target };
}

function cleanupLegacyQueue(workspace, options = {}) {
  const queueDir = path.resolve(workspace, '.gh-maestro', 'queue');
  const pollerPath = path.join(queueDir, options.pollerFile || 'poller.json');
  const lstatFn = options.lstatFn || fs.lstatSync;
  let queueStat;
  try {
    queueStat = lstatFn(queueDir);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { status: 'absent', path: queueDir };
    return { status: 'unknown', path: queueDir, reason: error.message };
  }
  if (queueStat.isSymbolicLink()) {
    try { (options.unlinkFn || unlinkSync)(queueDir); } catch (error) {
      return { status: 'unknown', path: queueDir, reason: `queueのjunction削除に失敗しました: ${error.message}` };
    }
    return { status: 'removed', path: queueDir };
  }

  const existsFn = options.existsFn || fs.existsSync;
  const killedPids = [];
  if (existsFn(pollerPath)) {
    let poller;
    try {
      const stat = lstatFn(pollerPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('poller.jsonが通常ファイルではありません');
      poller = JSON.parse((options.readFileFn || fs.readFileSync)(pollerPath, 'utf8'));
    } catch (error) {
      return { status: 'unknown', path: queueDir, reason: `poller.jsonの読み取りに失敗しました: ${error.message}` };
    }
    if (!poller || typeof poller !== 'object' || Array.isArray(poller)) {
      return { status: 'unknown', path: queueDir, reason: 'poller.jsonはオブジェクトである必要があります' };
    }
    if (poller.pid !== undefined && !validCleanupPid(poller.pid)) {
      return { status: 'unknown', path: queueDir, reason: 'poller.jsonのpidが不正です' };
    }
    if (poller.heartbeat !== undefined
      && (typeof poller.heartbeat !== 'number' || !Number.isFinite(poller.heartbeat))) {
      return { status: 'unknown', path: queueDir, reason: 'poller.jsonのheartbeatが不正です' };
    }
    if (poller.pid !== undefined) {
      const pid = Number(poller.pid);
      const alive = (options.isProcessAliveFn || isProcessAlive)(pid);
      if (typeof alive !== 'boolean') return { status: 'unknown', path: queueDir, reason: 'pollerの生存確認がbooleanを返しませんでした' };
      if (alive) {
        if (options.legacyResetMode === true) {
          const heartbeat = poller.heartbeat;
          const elapsed = typeof heartbeat === 'number' ? Date.now() - heartbeat : Infinity;
          if (elapsed <= 15000) {
            try {
              (options.killProcessTreeFn || killProcessTree)(pid);
              const remaining = (options.isProcessAliveFn || isProcessAlive)(pid);
              if (remaining !== false) throw new Error('停止を確認できませんでした');
              killedPids.push(pid);
            } catch (error) {
              return { status: 'unknown', path: queueDir, reason: `レガシー poller (pid ${pid}) の停止に失敗しました: ${error.message}` };
            }
          }
        } else {
          return { status: 'skipped', path: queueDir, reason: `レガシー poller (pid ${pid}) が稼働中です` };
        }
      }
    }
  }

  try {
      (options.unlinkJunctionsFn || unlinkJunctions)(queueDir, options.warnFn || (() => {}));
  } catch (error) {
    return { status: 'unknown', path: queueDir, reason: `queueのjunction除去に失敗しました: ${error.message}` };
  }
  const sleepFn = options.sleepFn || (() => {});
  const rmFn = options.rmFn || ((p) => rmSync(p, { recursive: true, force: false }));
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      rmFn(queueDir);
      return { status: 'removed', path: queueDir, killedPids };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { status: 'absent', path: queueDir };
      if (error && (error.code === 'EBUSY' || error.code === 'EPERM') && attempt < 5) {
        sleepFn(20);
        continue;
      }
      return { status: 'unknown', path: queueDir, reason: `queueの削除に失敗しました: ${error.message}` };
    }
  }
  return { status: 'unknown', path: queueDir, reason: 'queueの削除リトライが上限に達しました' };
}

const USAGE = `reset-session.js — gh-maestro セッションを強制リセットする

Usage: node reset-session.js [--workspace <path>] [--quiet]

Options:
  --workspace <path>  ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または
                      CWDからの .gh-maestro/ 上方探索で解決）
  --quiet             進捗ログを抑制する

workers.json の破損・pane 消滅・worktree 残骸など、どんな状態からでもできる限り
クリーンアップしてから終了する（途中エラーで止まらない）。
msg-state は単純削除せず、管理対象 Issue の既読ベースラインを再構築する（Issue #207）。
取得・保存の一部が失敗した場合は新状態を書き込まず、空状態でポーラーを再開しない。`;

/**
 * orchestrator の msg-state を「既読ベースライン再構築」する（Issue #207）。
 *
 * 単純削除はやめ、wipe 前の workers.json から管理対象 Issue 集合を確定し、
 * 各 Issue の既存コメントIDを取得して initialized 状態（sessionId 付き）を原子的に
 * 再構築する。スナップショットに含まれなかった（取得中に投稿された）コメントは
 * 未読として通知される。
 *
 * 取得・保存の一部が失敗した場合は新状態を書き込まない（既存状態を保持 or 欠落のまま）。
 * 空状態でポーラーを再開しない — msg-poll.js 側の「未初期化なら停止」が安全網になる。
 *
 * @param {string} workspace
 * @param {{ workers?: object, repo: string, listCommentsFn?: Function }} params
 *   workers: リセット時点（wipe前）の workers.json オブジェクト
 *   repo:    対象リポジトリ（owner/repo）
 * @returns {{ ok: boolean, sessionId?: string, issues?: string[], counts?: object, error?: string }}
 */
function rebuildOrchestratorBaseline(workspace, { workers = {}, repo, listCommentsFn = listComments }) {
  // 管理対象 Issue 集合 = wipe 前の workers.json の全ワーカー Issue（Q1: orchestrator 確定）
  const issues = [];
  for (const [name, entry] of Object.entries(workers)) {
    if (name === 'orchestrator') continue;
    const normalized = normalizeWorkerEntry(entry);
    if (normalized.issue) issues.push(String(normalized.issue));
  }

  const byIssue = {};
  const sinceByIssue = {};
  const counts = {};
  for (const issue of issues) {
    const r = listCommentsFn(repo, issue, { cwd: workspace });
    if (r.status !== 0) {
      return {
        ok: false,
        error: `ベースライン取得失敗 (issue ${issue}): ${r.stderr || r.error?.message || '(empty)'}`,
      };
    }
    let comments;
    try {
      comments = parseCommentsResponse(r.stdout);
    } catch (e) {
      return { ok: false, error: `ベースライン取得のJSONパース失敗 (issue ${issue}): ${e.message}` };
    }
    if (comments === null) {
      return { ok: false, error: `ベースライン取得の応答が配列ではない (issue ${issue})` };
    }
    const ids = comments
      .map((c) => c.id)
      .filter((x) => typeof x === 'number' && Number.isFinite(x));
    // 直近 created_at を取得最適化カーソルとして設定（既読判定には使わない。Issue #207）
    let maxCreated = null;
    for (const c of comments) {
      if (typeof c.created_at === 'string' && (!maxCreated || c.created_at > maxCreated)) {
        maxCreated = c.created_at;
      }
    }
    byIssue[issue] = ids;
    if (maxCreated) sinceByIssue[issue] = maxCreated;
    counts[issue] = ids.length;
  }

  const sessionId = crypto.randomUUID();
  const initResult = readStateLib.initializeState(workspace, 'orchestrator', { byIssue, sinceByIssue, sessionId });
  if (!initResult.ok) {
    return { ok: false, error: `msg-state 再構築に失敗: ${initResult.error}` };
  }

  return { ok: true, sessionId, issues, counts };
}

module.exports = {
  rebuildOrchestratorBaseline,
  restartCapturedResidents,
  cleanupLegacyWorkerField,
  cleanupLegacyMessages,
  cleanupLegacyQueue,
  USAGE,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {} },
      booleans: ['--quiet', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`reset-session: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }
  // 他スクリプト（poll-pr.js等）と同じ workspace 解決順（--workspace >
  // GH_MAESTRO_WORKSPACE env > CWD探索）に統一する。素の process.cwd() フォールバックだと、CWD が
  // ホームディレクトリ配下等に誤解決される余地が残るため使わない（Issue #214）。
  const workspace = resolveWorkspace(values['--workspace']);
  const quiet = values['--quiet'] === true;
  if (!workspace) {
    console.error('reset-session: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    process.exit(1);
  }

  const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
  const worktreesDir = resolve(workspace, '.gh-maestro', 'worktrees');
  const IS_WIN = process.platform === 'win32';

  const results = { killed: [], skipped: [], worktrees: [], errors: [] };
  let stateReadFailed = false;

  const log  = (msg) => { if (!quiet) console.log(`[reset] ${msg}`); };
  const warn = (msg) => console.warn(`[reset] ⚠ ${msg}`);

  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  // PID registryの全体sweepは稼働中の常駐を保護するため、後で現行コードへ入れ替え
  // られるよう argsを含む同一性確認済みのエントリを先に捕捉する。読み取り不能な
  // 場合は、不確かなPIDを起動情報として使わず、リセット後の自動再起動を行わない。
  let residentEntries = [];
  let residentCaptureError = null;
  try {
    residentEntries = captureResidentEntries(workspace);
    log(`常駐プロセスの再起動情報を ${residentEntries.length} 件捕捉しました。`);
  } catch (e) {
    residentCaptureError = e;
    warn(`常駐プロセスの再起動情報を捕捉できませんでした: ${e.message}`);
    results.errors.push(`resident capture: ${e.message}`);
  }

  // ── workers.json を安全に読む ─────────────────────────────────────

  const loadWorkers = () => {
    const workers = readWorkersRaw(workspace);
    return workers || {};
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
  let workers = null;
  try {
    workers = loadWorkers();
  } catch (e) {
    stateReadFailed = true;
    warn(`workers.json の読み取りを中止しました: ${e.message}`);
    results.errors.push(`workers.json read: ${e.message}`);
  }
  let alivePanes;
  try {
    alivePanes = getAlivePaneIds(warn);
  } catch (e) {
    if (e?.code !== REAL_SPAWN_DISABLED_ERROR_CODE || !process.env.NODE_TEST_CONTEXT) throw e;
    // node --test 配下では child-process の共有ガードが WezTerm の実呼び出しを拒否する。
    // このプロセスから作成されたペインは存在しないため、テスト用の stale registry を
    // 生存中と誤認しないよう空の一覧として扱う。実行時のコマンド失敗や、テスト外で
    // 明示的に設定された抑止環境はここで握り潰さず、従来どおり呼び出し元へ返す。
    warn(`WezTermのpane一覧取得をテスト中のため拒否しました: ${e.message}`);
    alivePanes = new Set();
  }

  let legacyNotifierCleanup = { notifierResults: [] };
  let legacyPaneCleanup = { paneResults: [] };
  if (workers !== null) {
    try {
      legacyNotifierCleanup = cleanupLegacyWorkerField(workspace, 'notifierPid', {
        readWorkersFn: () => workers,
        persist: false,
        isProcessAliveFn: isProcessAlive,
        killProcessTreeFn: killProcessTree,
      });
      for (const result of legacyNotifierCleanup.notifierResults || []) {
        if (result.status === 'killed') {
          log(`"${result.name}" のレガシー notifier (pid ${result.pid}) を終了しました。`);
        } else {
          log(`"${result.name}" のレガシー notifier (pid ${result.pid}) は既に終了しています。`);
        }
      }
    } catch (error) {
      warn(`レガシー notifier の掃除に失敗しました: ${error.message}`);
      results.errors.push(`legacy notifier: ${error.message}`);
    }
    try {
      legacyPaneCleanup = cleanupLegacyWorkerField(workspace, 'paneId', {
        readWorkersFn: () => workers,
        persist: false,
        alivePanes,
        killPaneFn: killPane,
        sleepFn: sleep,
        paneWaitMs: 500,
        strictPane: false,
      });
      for (const result of legacyPaneCleanup.paneResults || []) {
        if (result.status === 'killed') {
          log(`"${result.name}" のレガシーpane ${result.paneId} をkillしました。`);
        } else if (result.status === 'absent') {
          log(`"${result.name}" のレガシーpane ${result.paneId} は既に存在しません。スキップ。`);
        } else {
          warn(`"${result.name}" のレガシーpane ${result.paneId} のkillに失敗しました: ${result.reason}`);
        }
      }
    } catch (error) {
      warn(`レガシーpane の掃除に失敗しました: ${error.message}`);
      results.errors.push(`legacy pane: ${error.message}`);
    }

    const paneByWorker = new Map((legacyPaneCleanup.paneResults || []).map((result) => [result.name, result]));
    for (const [name, entry] of Object.entries(workers)) {
      if (name === 'orchestrator') continue;
      const normalized = normalizeWorkerEntry(entry);

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

      // 後方互換のpane処理は上の共通primitiveで済ませる。ここでは古い
      // workers.jsonの対象だったかだけを参照し、ワーカー本体の判定と結果集計を続ける。
      const paneResult = paneByWorker.get(name);
      if (paneResult) {
        if (!handled && paneResult.status === 'killed') results.killed.push(name);
        if (!handled && paneResult.status !== 'killed') results.skipped.push(name);
        handled = true;
      }

      if (!handled) {
        warn(`"${name}" に終了対象のプロセスが記録されていません。スキップ。`);
        results.skipped.push(name);
      }
    }
  }

  // ── 監視ペイン（status-pane.json）を終了・削除 ────────────────────────
  let statusPane = null;
  try {
    statusPane = loadStatusPane(workspace);
  } catch (e) {
    stateReadFailed = true;
    warn(`監視ペイン状態の読み取りを中止しました: ${e.message}`);
    results.errors.push(`status-pane read: ${e.message}`);
  }
  if (statusPane && statusPane.paneId) {
    let statusAlivePanes = null;
    try {
      // status-pane は保存時の mux/server へ照会する。別接続の一覧を使うと
      // 同じ数値paneIdを無関係なペインとしてkillし得るため、現在接続の
      // alivePanes は流用しない。
      statusAlivePanes = getAlivePaneIds(warn, statusPane);
    } catch (error) {
      if (error?.code === REAL_SPAWN_DISABLED_ERROR_CODE && process.env.NODE_TEST_CONTEXT) {
        warn(`WezTermのpane一覧取得をテスト中のため拒否しました: ${error.message}`);
        statusAlivePanes = new Set();
      } else {
        warn(`監視pane ${statusPane.paneId} の接続先照会に失敗しました: ${error.message}`);
      }
    }
    if (statusAlivePanes === null) {
      warn(`監視pane ${statusPane.paneId} の生存を確認できないため、状態記録を保持します。`);
    } else if (!statusAlivePanes.has(statusPane.paneId)) {
      log(`監視pane ${statusPane.paneId} は記録された接続先の一覧にありません。状態記録を保持します。`);
    } else {
      const r = killPane(statusPane.paneId, statusPane);
      if (r.ok) {
        log(`監視pane ${statusPane.paneId} を終了しました。`);
        results.killed.push(`status-pane-${statusPane.paneId}`);
        removeStatusPane(workspace);
      } else {
        warn(`監視pane ${statusPane.paneId} のkillに失敗しました: ${r.stderr}`);
      }
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
  const messagesResult = cleanupLegacyMessages(workspace, {
    rmFn: (target) => rmSync(target, { recursive: true, force: true }),
  });
  if (messagesResult.status === 'removed') {
      log('messages/（レガシー）を削除しました。');
  } else if (messagesResult.status === 'unknown') {
    warn(`messages/（レガシー）削除失敗: ${messagesResult.reason}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. msg-state の既読ベースライン再構築（Issue #207）
  //     単純削除はやめ、orchestrator の既読状態を「管理対象 Issue の既存コメントID
  //     スナップショット」で再構築する。取得・保存の一部が失敗した場合は新状態を
  //     書き込まず（既存状態を保持 or 欠落のまま）、空状態でポーラーを再開しない。
  // ═══════════════════════════════════════════════════════════════════

  log('msg-state の既読ベースラインを再構築します...');
  const repoResult = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { cwd: workspace, encoding: 'utf8' });
  const resetRepo = repoResult.status === 0 ? repoResult.stdout.trim() : '';

  if (workers === null) {
    warn('workers.json が判定不能なため msg-state のベースライン再構築をスキップします（破損からの自動回復は行いません）。');
    results.errors.push('msg-state baseline: workers.json が判定不能のため再構築しませんでした');
  } else if (!resetRepo) {
    warn('リポジトリを解決できないため msg-state のベースライン再構築をスキップします（既存状態は変更しません）。');
    warn('msg-state が欠落・未初期化のままなら、msg-poll は走査を停止して「明示初期化が必要」と報告します。');
    // 既読状態（readByIssue / sinceByIssue）を保ったまま、古い sessionId だけを無効化する
    const current = readStateLib.readState(workspace, 'orchestrator');
    if (current.status === 'ok') {
      current.state.sessionId = '';
      readStateLib.writeState(workspace, 'orchestrator', current.state);
    }
    results.errors.push('msg-state baseline: リポジトリ未解決のため再構築しませんでした');
  } else {
    const baselineResult = rebuildOrchestratorBaseline(workspace, { workers, repo: resetRepo });
    if (baselineResult.ok) {
      log(`msg-state を再構築しました（sessionId=${baselineResult.sessionId}, Issues=${(baselineResult.issues || []).join(',') || '(なし)'}）`);
      for (const [issue, count] of Object.entries(baselineResult.counts || {})) {
        log(`  Issue ${issue}: ${count} 件を既読ベースラインに含めました`);
      }
    } else {
      warn(`msg-state のベースライン再構築に失敗: ${baselineResult.error}`);
      warn('新状態は書き込まれていません（既存状態を保持 or 欠落のまま）。空状態でポーラーを再開しません。');
      // 既読状態（readByIssue / sinceByIssue）を保ったまま、古い sessionId だけを無効化する
      const current = readStateLib.readState(workspace, 'orchestrator');
      if (current.status === 'ok') {
        current.state.sessionId = '';
        readStateLib.writeState(workspace, 'orchestrator', current.state);
      }
      results.errors.push(`msg-state baseline: ${baselineResult.error}`);
    }
  }

  // クラッシュによる tmp 書き込み残骸（<self>.json.<rand>）があれば掃除する。
  // 正規の状態ファイルは <self>.json のみなので、*.json.* は安全に削除できる。
  const msgStateDir = resolve(workspace, '.gh-maestro', 'msg-state');
  if (existsSync(msgStateDir)) {
    try {
      const tmpLeftovers = readdirSync(msgStateDir).filter((f) => f.includes('.json.'));
      for (const f of tmpLeftovers) {
        try {
          unlinkSync(resolve(msgStateDir, f));
          log(`tmp残骸を削除: ${f}`);
        } catch (e) {
          warn(`tmp残骸の削除失敗: ${f} — ${e.message}`);
        }
      }
    } catch (e) {
      warn(`msg-state の tmp残骸掃除に失敗: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. queue 状態の掃除（後方互換: 旧FSキューセッションの残骸を掃除）
  //    queue.js / queue-poller.js は削除済みのため fs 直叩きのみで行う。
  // ═══════════════════════════════════════════════════════════════════

  log('キュー状態を掃除します...');
  const queueResult = cleanupLegacyQueue(workspace, {
    legacyResetMode: true,
    killProcessTreeFn: killProcessTree,
    isProcessAliveFn: isProcessAlive,
    sleepFn: sleep,
    rmFn: (target) => rmSync(target, { recursive: true, force: true }),
    warnFn: warn,
  });
  if (queueResult.status === 'removed') {
    for (const pid of queueResult.killedPids || []) {
      log(`レガシー poller (pid ${pid}) を終了しました。`);
      results.killed.push(`legacy-poller(${pid})`);
    }
    log('queue/ を削除しました。');
  } else if (queueResult.status === 'absent') {
    log('queue/ なし。スキップ。');
  } else if (queueResult.status === 'unknown') {
    warn(`queue/ の掃除に失敗しました: ${queueResult.reason}`);
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
  if (workers === null) {
    warn('workers.json が判定不能なためリセットせず、ファイルを保持します。破損からの自動回復は行いません。');
  } else {
    try {
      // 並行書き込み競合でも破損JSONを作らないようアトミック書き込みに統一する
      // （Issue #248 項目11）。
      atomicWriteJson(workersJson, fresh);
      log('workers.json をリセットしました。');
    } catch (e) {
      warn(`workers.json の書き込みに失敗しました: ${e.message}`);
      results.errors.push(`workers.json write: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. 常駐プロセスを現行コードで立て直す
  //     PID registry sweepが保護した常駐について、捕捉済みargsを引き継いで
  //     既存プロセスを停止し、現行コードで再起動する。Monitorの張り直しはCLIの
  //     責務外なので、必要なものを明示する。
  // ═══════════════════════════════════════════════════════════════════

  let residentRestartFailed = false;
  if (residentCaptureError) {
    warn('常駐プロセスは再起動情報を確認できなかったため、立て直しを実行しませんでした。');
    residentRestartFailed = true;
  } else if (residentEntries.length > 0) {
    log('常駐プロセスを現行コードで立て直します...');
    const residentRestart = restartCapturedResidents(workspace, residentEntries, __dirname);
    for (const resident of residentRestart.results) {
      log(formatResidentResult(resident));
      const monitorCommands = resident.commands || [];
      if (resident.monitorRequired) {
        for (const command of monitorCommands) {
          log(`MONITOR_REATTACH_REQUIRED script=${resident.monitorScript || resident.script} command=${command}`);
        }
      }
    }
    for (const error of residentRestart.errors) {
      warn(`常駐プロセスの立て直しに失敗しました: ${error}`);
      results.errors.push(`resident restart: ${error}`);
    }
    residentRestartFailed = residentRestart.errors.length > 0;
  } else {
    log('稼働中の常駐プロセスはありません。立て直しをスキップします。');
  }

  // ═══════════════════════════════════════════════════════════════════
  // 11. サマリー
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
  if (residentRestartFailed || stateReadFailed) process.exitCode = 1;
}
