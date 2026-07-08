#!/usr/bin/env node
// process-lifecycle.js — ポーリングプロセスのライフサイクル管理（共通モジュール）
//
// 提供する機能:
//   - 親セッション監視（dead-man's switch）: ポーリングループの毎周回で親の生存を確認
//   - PID registry（1プロセス1ファイル）: 登録・解除・sweep
//   - プロセス同一性確認（PID再利用対策）
//
// Usage (module):
//   const plc = require('./process-lifecycle');
//
//   // Dead-man's switch
//   const sessionPid = plc.resolveSessionPid(cliFlagValue);
//   const checkParent = plc.createDeadManSwitch(sessionPid);
//
//   // PID registry
//   plc.registerProcess(workspace, { workerName, script: 'msg-poll.js' });
//   // ... polling loop with checkParent() ...
//   plc.cleanup(workspace);
//
// Usage (CLI — sweep only):
//   node process-lifecycle.js sweep --workspace <path> [--worker-name <name>] [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('./child-process');

const IS_WIN = process.platform === 'win32';

// ── 親セッション監視（dead-man's switch） ──────────────────────────────

/**
 * 親プロセスの PID を取得する。
 * Windows: Get-CimInstance Win32_Process の ParentProcessId
 * Linux:   /proc/<pid>/stat の第4フィールド
 *
 * @param {number} pid
 * @returns {number|null}
 */
function getParentPid(pid) {
  if (IS_WIN) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`,
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
      );
      const val = parseInt(out.trim(), 10);
      return Number.isFinite(val) && val > 0 ? val : null;
    } catch {
      return null;
    }
  } else {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // フィールド4（0-indexed: 3）が ppid
      // 注意: comm フィールド（2番目）は括弧で囲まれ、スペースを含む可能性がある
      const commEnd = stat.lastIndexOf(')');
      const afterComm = stat.slice(commEnd + 2); // ") " の後
      const parts = afterComm.split(' ');
      const ppid = parseInt(parts[1], 10); // state(0), ppid(1)
      return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
    } catch {
      return null;
    }
  }
}

/**
 * セッションルートPIDを親チェーンを遡って特定する。
 *
 * process.ppid が中間シェル（bash/cmd/powershell）を指している場合、
 * さらに1〜2階層遡ってエージェントセッション本体のPIDを探す。
 * 最大5階層まで遡り、init/systemプロセス（pid<=4）の直前で停止する。
 *
 * @param {number} [startPid] 起点PID（省略時は process.pid）
 * @returns {number} セッションルートPID（特定不能時は process.ppid）
 */
function findSessionRootPid(startPid) {
  let pid = startPid || process.pid;
  let found = process.ppid; // フォールバック
  const maxDepth = 5;

  for (let i = 0; i < maxDepth; i++) {
    const ppid = getParentPid(pid);
    if (!ppid || ppid <= 4) break; // init/system に到達
    found = ppid;
    pid = ppid;
  }
  return found;
}

/**
 * 監視対象PIDを解決する。
 *
 * 優先順位:
 *   1. --session-pid CLIフラグの値
 *   2. 親チェーンを遡ったセッションルート（findSessionRootPid）
 *   3. process.ppid（フォールバック）
 *
 * @param {string|number|null} cliSessionPid  --session-pid フラグの値
 * @returns {number}
 */
function resolveSessionPid(cliSessionPid) {
  if (cliSessionPid != null && cliSessionPid !== '') {
    const n = parseInt(cliSessionPid, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 親チェーンを遡ってセッションルートを特定（中間シェルをスキップ）
  try {
    return findSessionRootPid();
  } catch {
    return process.ppid;
  }
}

/**
 * プロセスが生存しているかを確認する。
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    // process.kill(pid, 0) はシグナルを送らず生存確認だけ行う
    // ESRCH: プロセス不在, EPERM: 存在するが権限なし（生存とみなす）
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    return true; // EPERM 等 → 存在する
  }
}

/**
 * プロセスの起動時刻をISO文字列で取得する。
 *
 * @param {number} pid
 * @returns {string|null} ISO 8601 形式の起動時刻、または null（取得失敗時）
 */
function getProcessStartTime(pid) {
  if (!pid || pid <= 0) return null;
  if (IS_WIN) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "$d=(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate; if($d){[System.DateTime]::Parse($d).ToUniversalTime().ToString('o')}else{''}"`,
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
      );
      const val = out.trim();
      return val || null;
    } catch {
      return null;
    }
  } else {
    try {
      const stat = fs.statSync(`/proc/${pid}`);
      // birthtime は Linux では作成時刻ではない場合がある（statx 非対応カーネル）
      // その場合は /proc/<pid>/stat の starttime (フィールド22) を使う
      const statOut = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commEnd = statOut.lastIndexOf(')');
      const afterComm = statOut.slice(commEnd + 2);
      const parts = afterComm.split(' ');
      // フィールド22（0-indexed: 19 after comm）: starttime
      const startTimeTicks = parseInt(parts[19], 10);
      if (Number.isFinite(startTimeTicks)) {
        // 起動時刻 ≈ boot_time + starttime / sysconf(_SC_CLK_TCK)
        // 簡易: /proc/stat から btime を取得
        const procStat = fs.readFileSync('/proc/stat', 'utf8');
        const btimeMatch = procStat.match(/btime\s+(\d+)/);
        if (btimeMatch) {
          const bootTime = parseInt(btimeMatch[1], 10);
          // sysconf(_SC_CLK_TCK) は通常 100
          const clkTick = 100;
          const startSec = bootTime + startTimeTicks / clkTick;
          return new Date(startSec * 1000).toISOString();
        }
      }
      return stat.birthtime.toISOString();
    } catch {
      return null;
    }
  }
}

/**
 * dead-man's switch のチェック関数を作成する。
 *
 * 返された関数をポーリングループの毎周回で呼び出す。
 * 親が死んだことを検出したら false を返す（呼び出し側は cleanup して exit）。
 * PID再利用の誤判定を緩和するため、3回連続で死を確認するまで false を返さない。
 *
 * @param {number} monitorPid 監視対象PID
 * @param {object} [opts]
 * @param {string} [opts.expectedStartTime] 監視対象の期待起動時刻（PID再利用検知用）
 * @returns {() => boolean} 親が生きていれば true、死んでいれば false
 */
function createDeadManSwitch(monitorPid, opts = {}) {
  const expectedStartTime = opts.expectedStartTime || null;
  let consecutiveDead = 0;
  const REQUIRED_CONSECUTIVE_DEAD = 3;

  return function checkParent() {
    const alive = isProcessAlive(monitorPid);

    if (!alive) {
      consecutiveDead++;
      if (consecutiveDead >= REQUIRED_CONSECUTIVE_DEAD) return false;
      return true; // 猶予期間中
    }
    consecutiveDead = 0;

    // PID再利用チェック: 期待起動時刻と実起動時刻を比較
    // 実装メモ: getProcessStartTime の WMI 呼び出しは高コストのため、
    // 毎回ではなく 10 周回に 1 回だけ確認する（PID 再利用は頻繁ではない）。
    if (expectedStartTime && consecutiveDead === 0) {
      // PID再利用検知は best-effort。取得失敗時は registry sweep を保険とする。
      try {
        const actualStart = getProcessStartTime(monitorPid);
        if (actualStart && actualStart !== expectedStartTime) {
          // 同じPIDだが別プロセス → 元の親は死んだとみなす
          return false;
        }
      } catch {
        // 起動時刻取得失敗 → registry sweep に任せる
      }
    }

    return true;
  };
}

// ── PID Registry（1プロセス1ファイル） ─────────────────────────────────

/**
 * PID registry のディレクトリパスを返す。
 * @param {string} workspace
 * @returns {string}
 */
function pidsDir(workspace) {
  return path.join(workspace, '.gh-maestro', 'pids');
}

/**
 * 特定PIDの registry ファイルパスを返す。
 * @param {string} workspace
 * @param {number} pid
 * @returns {string}
 */
function pidFilePath(workspace, pid) {
  return path.join(pidsDir(workspace), `${pid}.json`);
}

/**
 * 自プロセスを PID registry に登録する。
 * .gh-maestro/pids/<pid>.json を作成する。
 *
 * @param {string} workspace
 * @param {object} meta
 * @param {string} [meta.script]     スクリプト名（例: "msg-poll.js"）
 * @param {string[]} [meta.args]     CLI引数（process.argv.slice(2)）
 * @param {string} [meta.workerName] ワーカー名（該当時）
 * @param {string} [meta.startTime]  プロセス起動時刻（省略時は現在時刻）
 * @returns {object} 登録されたエントリ
 */
function registerProcess(workspace, meta = {}) {
  const dir = pidsDir(workspace);
  fs.mkdirSync(dir, { recursive: true });

  const entry = {
    pid: process.pid,
    script: meta.script || path.basename(process.argv[1] || 'unknown'),
    args: meta.args || process.argv.slice(2),
    workerName: meta.workerName || null,
    workspace: workspace,
    startTime: meta.startTime || new Date().toISOString(),
    registeredAt: new Date().toISOString(),
  };

  const filePath = pidFilePath(workspace, process.pid);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');
  return entry;
}

/**
 * 自プロセス（または指定PID）を PID registry から解除する。
 * .gh-maestro/pids/<pid>.json を削除する。
 *
 * @param {string} workspace
 * @param {number} [pid] 省略時は process.pid
 */
function unregisterProcess(workspace, pid) {
  const targetPid = pid || process.pid;
  const filePath = pidFilePath(workspace, targetPid);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// ── プロセス同一性確認（PID再利用対策） ──────────────────────────────

/**
 * 実行中のプロセスが registry エントリと同一か検証する。
 *
 * PID再利用事故を防ぐため、起動時刻を比較する。
 * Windows: Get-CimInstance Win32_Process の CreationDate
 * Linux:   /proc/<pid>/stat の starttime
 *
 * @param {number} pid
 * @param {object} registeredMeta  registry エントリ（registerProcess の戻り値）
 * @returns {{ match: boolean, reason?: string }}
 */
function verifyProcessIdentity(pid, registeredMeta) {
  if (!isProcessAlive(pid)) {
    return { match: false, reason: 'process not alive' };
  }

  const actualStartTime = getProcessStartTime(pid);
  if (!actualStartTime) {
    // 起動時刻が取得できない → 同一性確認不能
    // 安全のため「一致しない」と判定（無関係なプロセスを kill しない）
    return { match: false, reason: 'cannot get process start time' };
  }

  if (registeredMeta.startTime) {
    const regTime = new Date(registeredMeta.startTime).getTime();
    const actualTime = new Date(actualStartTime).getTime();
    // 1秒の許容範囲（WMI と JS Date の精度差を吸収）
    if (Math.abs(regTime - actualTime) > 1000) {
      return { match: false, reason: `start time mismatch: registered=${registeredMeta.startTime}, actual=${actualStartTime}` };
    }
  }

  return { match: true };
}

// ── Registry sweep ────────────────────────────────────────────────────

/**
 * PID registry を sweep する。
 *
 * 各エントリに対して:
 *   1. PID非生存 → ファイル削除のみ（プロセスは既に死んでいる）
 *   2. PID生存・同一性不一致 → ファイル削除のみ（PID再利用、無関係なプロセス）
 *   3. PID生存・同一性一致 → kill + ファイル削除（stale だが生き残っている）
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {(entry: object) => boolean} [opts.match] エントリのフィルタ関数
 * @param {boolean} [opts.dryRun] true なら実際の kill/削除を行わない
 * @returns {{ killed: object[], cleaned: object[], errors: string[] }}
 */
function sweepRegistry(workspace, opts = {}) {
  const dir = pidsDir(workspace);
  const results = { killed: [], cleaned: [], errors: [] };

  if (!fs.existsSync(dir)) return results;

  let entries;
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (e) {
    results.errors.push(`readdir failed: ${e.message}`);
    return results;
  }

  for (const file of entries) {
    const filePath = path.join(dir, file);
    let entry;

    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      try { if (!opts.dryRun) fs.unlinkSync(filePath); } catch {}
      results.cleaned.push({ file, reason: 'corrupt JSON' });
      continue;
    }

    const entryPid = entry.pid;
    if (!entryPid || !Number.isFinite(entryPid)) {
      try { if (!opts.dryRun) fs.unlinkSync(filePath); } catch {}
      results.cleaned.push({ file, reason: 'missing/invalid pid' });
      continue;
    }

    // フィルタ
    if (opts.match && !opts.match(entry)) continue;

    if (!isProcessAlive(entryPid)) {
      try { if (!opts.dryRun) fs.unlinkSync(filePath); } catch {}
      results.cleaned.push({ pid: entryPid, reason: 'process not alive' });
      continue;
    }

    // プロセス生存 → 同一性確認
    const identity = verifyProcessIdentity(entryPid, entry);
    if (!identity.match) {
      // PID再利用 → ファイル削除のみ（無関係なプロセスを kill しない）
      try { if (!opts.dryRun) fs.unlinkSync(filePath); } catch {}
      results.cleaned.push({ pid: entryPid, reason: `identity mismatch: ${identity.reason}` });
      continue;
    }

    // 同一性一致 → kill（stale プロセス）
    if (!opts.dryRun) {
      const { killProcessTree } = require('./kill-tree');
      killProcessTree(entryPid);
      try { fs.unlinkSync(filePath); } catch {}
    }
    results.killed.push({
      pid: entryPid,
      workerName: entry.workerName,
      script: entry.script,
    });
  }

  return results;
}

// ── 統合 cleanup ──────────────────────────────────────────────────────

/**
 * 統合 cleanup: PID registry 解除 + 追加クリーンアップ。
 * ポーリングスクリプトの正常終了・自壊時に呼ぶ。
 *
 * @param {string} workspace
 * @param {() => void} [extraCleanup] 追加のクリーンアップ処理（poll-reviews.js の state ファイル削除等）
 */
function cleanup(workspace, extraCleanup) {
  // registry 解除（best-effort）
  try { unregisterProcess(workspace, process.pid); } catch {}

  // 追加クリーンアップ（各スクリプト固有の後始末）
  if (extraCleanup) {
    try { extraCleanup(); } catch {}
  }
}

// ── CLI エントリポイント（sweep 操作） ─────────────────────────────────

const CLI_USAGE = `process-lifecycle.js — プロセスライフサイクル管理

Usage: node process-lifecycle.js sweep --workspace <path> [--worker-name <name>] [--dry-run]

Options:
  --workspace <path>     ワークスペースパス（必須）
  --worker-name <name>   特定ワーカーのPIDのみsweep（省略時は全エントリ）
  --dry-run              実際のkill/削除を行わず、対象のみ表示

Description:
  PID registry を走査し、stale エントリを掃除する。
  各エントリは同一性確認（起動時刻比較）を経て、一致する場合のみ kill される。
  PID再利用が検出されたエントリはファイル削除のみ行う（無関係なプロセスを保護）。`;

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(CLI_USAGE);
    process.exit(0);
  }

  const sub = argv[0];
  if (sub !== 'sweep') {
    console.error(CLI_USAGE);
    process.exit(1);
  }

  const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };
  const workspace = get('--workspace');
  const workerName = get('--worker-name');
  const dryRun = argv.includes('--dry-run');

  if (!workspace) {
    console.error('process-lifecycle: --workspace が必要です');
    console.error(CLI_USAGE);
    process.exit(1);
  }

  const matchFilter = workerName
    ? (entry) => entry.workerName === workerName
    : undefined;

  const results = sweepRegistry(workspace, { match: matchFilter, dryRun });

  if (dryRun) console.log('[dry-run] 実際のkill/削除は行いません');
  if (results.killed.length > 0) {
    console.log(`Killed (${results.killed.length}):`);
    for (const k of results.killed) {
      console.log(`  pid=${k.pid} worker=${k.workerName || '-'} script=${k.script || '-'}`);
    }
  }
  if (results.cleaned.length > 0) {
    console.log(`Cleaned stale entries (${results.cleaned.length}):`);
    for (const c of results.cleaned) {
      console.log(`  pid=${c.pid || c.file} reason=${c.reason}`);
    }
  }
  if (results.errors.length > 0) {
    console.error(`Errors (${results.errors.length}):`);
    for (const e of results.errors) console.error(`  ${e}`);
  }
  if (results.killed.length === 0 && results.cleaned.length === 0 && results.errors.length === 0) {
    console.log('No stale entries found.');
  }

  process.exit(results.errors.length > 0 ? 1 : 0);
}

// ── エクスポート ──────────────────────────────────────────────────────

module.exports = {
  // 親セッション監視
  getParentPid,
  findSessionRootPid,
  resolveSessionPid,
  isProcessAlive,
  getProcessStartTime,
  createDeadManSwitch,
  // PID registry
  pidsDir,
  pidFilePath,
  registerProcess,
  unregisterProcess,
  // 同一性確認
  verifyProcessIdentity,
  // sweep
  sweepRegistry,
  // 統合
  cleanup,
  CLI_USAGE,
};
