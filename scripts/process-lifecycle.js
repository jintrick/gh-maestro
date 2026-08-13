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
const { parseFlags, hasGenuineHelpRequest } = require('./shared/workspace');
const storageLayout = require('./shared/storage-layout');

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
  // pid引数の検証（コマンド実行・パストラバーサル対策）
  const n = parseInt(pid, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  if (IS_WIN) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${n}').ParentProcessId"`,
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
      );
      const val = parseInt(out.trim(), 10);
      return Number.isFinite(val) && val > 0 ? val : null;
    } catch {
      return null;
    }
  } else {
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
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
  // pid引数の検証（コマンド実行・パストラバーサル対策）
  const n = parseInt(pid, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  if (IS_WIN) {
    try {
      // Get-CimInstance の CreationDate は既に [DateTime] オブジェクトなので、
      // [System.DateTime]::Parse で文字列パースし直してはならない。DateTime→文字列の
      // 暗黙変換は現在カルチャ依存で、日本語ロケール等では Parse が失敗し null を返して
      // しまう（プロセス同一性確認＝重複検出・sweepが全て機能しなくなる実バグだった）。
      // DateTime オブジェクトに直接 ToUniversalTime().ToString('o') を適用する。
      const out = execSync(
        `powershell -NoProfile -Command "$d=(Get-CimInstance Win32_Process -Filter 'ProcessId=${n}').CreationDate; if($d){$d.ToUniversalTime().ToString('o')}else{''}"`,
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
      );
      const val = out.trim();
      return val || null;
    } catch {
      return null;
    }
  } else {
    try {
      // /proc/<pid>/stat の starttime (フィールド22) を boot_time からのオフセットとして計算
      const statOut = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      const commEnd = statOut.lastIndexOf(')');
      const afterComm = statOut.slice(commEnd + 2);
      const parts = afterComm.split(' ');
      // フィールド22（0-indexed: 19 after comm）: starttime
      const startTimeTicks = parseInt(parts[19], 10);
      if (Number.isFinite(startTimeTicks)) {
        // 起動時刻 ≈ boot_time + starttime / sysconf(_SC_CLK_TCK)
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
      // フォールバック: /proc/<pid> の mtime（birthtime は procfs でサポートされず 1970-01-01 を返す）
      const stat = fs.statSync(`/proc/${n}`);
      return stat.mtime.toISOString();
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
//
// Issue #214: PID registry は本来 workspace 固有の runtime 状態であり、
// install.js が権威的に prune する managed root（~/.gh-maestro/）とは
// 物理的に別の runtime root（storage-layout.js の runtimeRoot()）に置く。
// workspace が誤ってホームディレクトリ（＝managed root の親）に解決された
// 場合は pidsDir()/legacyPidsDir() の入口で assertValidWorkspace が throw し、
// 以後のあらゆる pids 操作（作成・sweep・lock）を一括で遮断する（fail-closed）。
//
// 移行期間中は旧ロケーション（<workspace>/.gh-maestro/pids/）も bridge として
// dual-write / union-read / dual-delete する。これにより、まだ再起動していない
// 旧プロセス（旧コードのまま legacy のみ読み書きする）との生存判定・二重起動
// 防止が移行の前後で分断されない。

/**
 * PID registry のディレクトリパスを返す（新ロケーション: OS runtime root 配下）。
 * workspace がホームディレクトリ等 managed root と衝突する場合は throw する。
 * 併せて、runtime root 自体が managed root と衝突していないか（例: 誤設定された
 * GH_MAESTRO_RUNTIME_DIR が ~/.gh-maestro を指している）も自己検査する。
 * pidsDir() は全 pids 操作のチョークポイントであるため、ここで検査すれば
 * registerProcess/sweepRegistry/lock 系すべてに一括で効く。
 * @param {string} workspace
 * @returns {string}
 */
function pidsDir(workspace) {
  storageLayout.assertValidWorkspace(workspace);
  storageLayout.assertDisjointRoots();
  return path.join(storageLayout.workspaceRuntimeDir(workspace), 'pids');
}

/**
 * PID registry の旧ロケーション（<workspace>/.gh-maestro/pids）を返す。
 * bridge 期間中の dual-write/union-read/dual-delete 専用。
 * @param {string} workspace
 * @returns {string}
 */
function legacyPidsDir(workspace) {
  storageLayout.assertValidWorkspace(workspace);
  return path.join(workspace, '.gh-maestro', 'pids');
}

/**
 * 特定PIDの registry ファイルパスを返す（新ロケーション）。
 * @param {string} workspace
 * @param {number} pid
 * @returns {string}
 */
function pidFilePath(workspace, pid) {
  return path.join(pidsDir(workspace), `${pid}.json`);
}

/**
 * 特定PIDの registry ファイルパスを返す（旧ロケーション）。
 * @param {string} workspace
 * @param {number} pid
 * @returns {string}
 */
function legacyPidFilePath(workspace, pid) {
  return path.join(legacyPidsDir(workspace), `${pid}.json`);
}

/**
 * 自プロセスを PID registry に登録する。新ロケーションへ書き込み、
 * bridge として旧ロケーションへも best-effort で dual-write する。
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
  // pidsDir() が assertValidWorkspace を呼ぶため、無効な workspace は
  // 以下のいかなる書き込みよりも先に throw する（fail-closed）。
  const dir = pidsDir(workspace);
  storageLayout.ensureWorkspaceRuntimeDir(workspace);
  fs.mkdirSync(dir, { recursive: true });

  // 起動時刻は実際のプロセス開始時刻を使用する。
  // Node起動レイテンシが1秒を超えるとverifyProcessIdentityの閾値(1秒)で
  // 誤動作するため、new Date()（登録時の現在時刻）では不十分。
  // 取得失敗時のみ現在時刻をフォールバックとする。
  const actualStartTime = meta.startTime || getProcessStartTime(process.pid) || new Date().toISOString();

  const entry = {
    pid: process.pid,
    script: meta.script || path.basename(process.argv[1] || 'unknown'),
    args: meta.args || process.argv.slice(2),
    workerName: meta.workerName || null,
    workspace: workspace,
    startTime: actualStartTime,
    registeredAt: new Date().toISOString(),
  };

  const filePath = pidFilePath(workspace, process.pid);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');

  // bridge: 旧ロケーションへの dual-write（best-effort）。
  // まだ再起動していない旧コードの読み手がこのプロセスを認識できるようにする。
  try {
    const legacyDir = legacyPidsDir(workspace);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPidFilePath(workspace, process.pid), JSON.stringify(entry, null, 2), 'utf8');
  } catch {}

  return entry;
}

/**
 * 自プロセス（または指定PID）を PID registry から解除する。
 * 新旧両ロケーションから削除する（旧ロケーションは best-effort）。
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

  // bridge: 旧ロケーションの解除は best-effort（存在しない/読めない等は無視）。
  try {
    const legacyFilePath = legacyPidFilePath(workspace, targetPid);
    if (fs.existsSync(legacyFilePath)) fs.unlinkSync(legacyFilePath);
  } catch {}
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
    // 不正な日付文字列の場合 getTime() が NaN を返す。
    // NaN > 1000 は false のため誤って一致判定（match:true）に倒れてしまう。
    // 明示的に NaN チェックを入れ、不正値は不一致扱いとする（PID再利用の誤kill防止）。
    if (Number.isNaN(regTime) || Number.isNaN(actualTime)) {
      return { match: false, reason: `invalid date: registered=${registeredMeta.startTime}, actual=${actualStartTime}` };
    }
    // 1秒の許容範囲（WMI と JS Date の精度差を吸収）
    if (Math.abs(regTime - actualTime) > 1000) {
      return { match: false, reason: `start time mismatch: registered=${registeredMeta.startTime}, actual=${actualStartTime}` };
    }
  }

  return { match: true };
}

/**
 * 同一の inbox（script + workerName + workspace）を既に監視している
 * 生存プロセスを registry から探す（非破壊・読み取り専用）。
 *
 * msg-poll.js 等の継続ポーリングスクリプトが、起動前に同じ監視対象の
 * 多重起動を検知するために使う。sweepRegistry と異なり kill もファイル削除も行わない。
 *
 * @param {string} workspace
 * @param {object} opts
 * @param {string} opts.script       スクリプト名（例: "msg-poll.js"）
 * @param {string|null} opts.workerName  worker名。orchestrator モードは null を渡す
 * @returns {object|null} 一致する生存エントリ（最初の1件）、無ければ null
 */
function findRunningInstance(workspace, opts = {}) {
  // bridge: 新旧両ロケーションを union して読む（旧コードのプロセスは
  // legacy にしか登録されていない可能性があるため）。
  const dirs = [pidsDir(workspace), legacyPidsDir(workspace)];
  const seenPids = new Set();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (opts.script && entry.script !== opts.script) continue;
      if ((entry.workerName ?? null) !== (opts.workerName ?? null)) continue;
      if (entry.workspace !== workspace) continue;

      const entryPid = entry.pid;
      if (!entryPid || !Number.isFinite(entryPid)) continue;
      if (entryPid === process.pid) continue;
      // dual-write により同一pidが新旧両方に存在しうる。既に判定済みならスキップ。
      if (seenPids.has(entryPid)) continue;
      seenPids.add(entryPid);
      if (!isProcessAlive(entryPid)) continue;

      // PID再利用対策: 生存はしているが、起動時刻が registry の記録と一致しない場合は
      // OSが同じPIDを無関係な別プロセスに再割り当てしただけであり、重複起動ではない。
      // ここで「重複」と誤判定すると、以後の起動が永久にブロックされてしまう
      // （sweepRegistry と同じ verifyProcessIdentity を用いる）。
      const identity = verifyProcessIdentity(entryPid, entry);
      if (!identity.match) continue;

      return entry;
    }
  }

  return null;
}

// ── 単一起動ロック（check-then-register のTOCTOU対策） ─────────────────

/**
 * 単一起動ロックファイルのパスを返す（新ロケーション）。
 * @param {string} workspace
 * @param {string} script
 * @param {string|null} workerName
 * @returns {string}
 */
function startupLockPath(workspace, script, workerName) {
  const key = `${script}__${workerName ?? 'orchestrator'}`;
  return path.join(pidsDir(workspace), `.startup-lock-${key}`);
}

/**
 * 単一起動ロックファイルのパスを返す（旧ロケーション）。bridge専用。
 * @param {string} workspace
 * @param {string} script
 * @param {string|null} workerName
 * @returns {string}
 */
function legacyStartupLockPath(workspace, script, workerName) {
  const key = `${script}__${workerName ?? 'orchestrator'}`;
  return path.join(legacyPidsDir(workspace), `.startup-lock-${key}`);
}

/**
 * 単一のロックファイルに対する取得処理（stale奪取込み）。
 * acquireStartupLock の新旧両ロケーションで共通利用する内部ヘルパー。
 *
 * @param {string} dir mkdir 対象ディレクトリ（lockPath の親）
 * @param {string} lockPath
 * @param {number} maxRetries
 * @param {{pid: number, startTime: string}} selfEntry 呼び出し元で1回だけ計算した自分自身のエントリ。
 *   getProcessStartTime は Windows では PowerShell/WMI 呼び出しを伴い高コストなため、
 *   新旧2ロケーションの取得で毎回計算し直さない（bridge化で2倍の呼び出しコストが
 *   掛かるのを避ける）。
 * @returns {boolean}
 */
function acquireLockAt(dir, lockPath, maxRetries, selfEntry) {
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(selfEntry), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      holder = null;
    }

    const holderAlive = holder && Number.isFinite(holder.pid) && isProcessAlive(holder.pid);
    const holderMatches = holderAlive && verifyProcessIdentity(holder.pid, holder).match;

    if (holderMatches) {
      // 正当な保持者がいる → 取得失敗
      return false;
    }

    // stale ロック（保持者が非生存、または壊れている、またはPID再利用）→ 奪取して再試行
    try { fs.unlinkSync(lockPath); } catch {}
  }

  // リトライ上限に達した（継続的な競合）→ フェイルクローズで失敗扱い
  return false;
}

/**
 * 保持しているロックを解放する（自分が保持者の場合のみ）。
 * @param {string} lockPath
 */
function releaseLockAt(lockPath) {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (holder && holder.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // 読めない・存在しない → 何もしない
  }
}

/**
 * 同一 (workspace, script, workerName) の起動処理を排他制御するロックを取得する。
 *
 * findRunningInstance（チェック）→ registerProcess（登録）の2段階が非アトミックだと、
 * ほぼ同時に2プロセスが起動した場合に両方がチェックを通過してしまう（TOCTOU）。
 * このロックで「チェック開始〜登録完了」の区間を排他化する。
 *
 * 保持者が非生存、または同一性不一致（PID再利用）の場合は stale とみなし
 * 自動的に奪取する。
 *
 * bridge期間中は旧ロケーションを第一ゲート、新ロケーションを第二ゲートとし、
 * 両方取得できた場合のみ成功とする（取得順は常に legacy → new に固定）。
 * 新ロケーションの取得に失敗した場合は、既に取得した旧ロケーションのロックを
 * 解放してから失敗を返す。
 *
 * @param {string} workspace
 * @param {string} script
 * @param {string|null} workerName
 * @param {object} [opts]
 * @param {number} [opts.maxRetries] stale ロック奪取の最大リトライ回数（既定: 5）
 * @returns {boolean} 取得できれば true
 */
function acquireStartupLock(workspace, script, workerName, opts = {}) {
  const maxRetries = opts.maxRetries ?? 5;

  // 新旧2ロケーション分の getProcessStartTime（Windowsでは WMI 呼び出し）を
  // 1回にまとめる。
  const selfEntry = {
    pid: process.pid,
    startTime: getProcessStartTime(process.pid) || new Date().toISOString(),
  };

  const legacyDir = legacyPidsDir(workspace);
  const legacyLock = legacyStartupLockPath(workspace, script, workerName);
  const gotLegacy = acquireLockAt(legacyDir, legacyLock, maxRetries, selfEntry);
  if (!gotLegacy) return false;

  const newDir = pidsDir(workspace);
  const newLock = startupLockPath(workspace, script, workerName);
  const gotNew = acquireLockAt(newDir, newLock, maxRetries, selfEntry);
  if (!gotNew) {
    releaseLockAt(legacyLock);
    return false;
  }

  return true;
}

/**
 * 自プロセスが保持している起動ロックを解放する（新旧両ロケーション）。
 * 自分が保持者でない場合は何もしない（他プロセスのロックを誤って消さない）。
 *
 * @param {string} workspace
 * @param {string} script
 * @param {string|null} workerName
 */
function releaseStartupLock(workspace, script, workerName) {
  releaseLockAt(legacyStartupLockPath(workspace, script, workerName));
  releaseLockAt(startupLockPath(workspace, script, workerName));
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
 * bridge期間中は新旧両ロケーションを union して走査する。同一PIDのエントリが
 * 両方に存在する場合（dual-write の結果）は1つのエントリとして判定し、
 * kill/削除の対象ファイルは両ロケーション分をまとめて扱う。
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {(entry: object) => boolean} [opts.match] エントリのフィルタ関数
 * @param {boolean} [opts.dryRun] true なら実際の kill/削除を行わない
 * @returns {{ killed: object[], cleaned: object[], errors: string[] }}
 */
function sweepRegistry(workspace, opts = {}) {
  const dirs = [pidsDir(workspace), legacyPidsDir(workspace)];
  const results = { killed: [], cleaned: [], errors: [] };

  const hasRegistry = dirs.some(d => fs.existsSync(d));

  // entryPid -> { entry, filePaths: string[] }（新旧に跨るエントリを集約する）
  const byPid = new Map();

  for (const dir of dirs) {
    if (!hasRegistry) break;
    if (!fs.existsSync(dir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (e) {
      results.errors.push(`readdir failed (${dir}): ${e.message}`);
      continue;
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

      // JSON.parse が null や非オブジェクト（文字列・数値等）を返した場合は不正データとして扱う
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        try { if (!opts.dryRun) fs.unlinkSync(filePath); } catch {}
        results.cleaned.push({ file, reason: `invalid entry type: ${entry === null ? 'null' : typeof entry}` });
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

      if (!byPid.has(entryPid)) byPid.set(entryPid, { entry, filePaths: [] });
      byPid.get(entryPid).filePaths.push(filePath);
    }
  }

  const removeFiles = (filePaths) => {
    if (opts.dryRun) return;
    for (const fp of filePaths) {
      try { fs.unlinkSync(fp); } catch {}
    }
  };

  const excludedWorkerNames = new Set();
  const excludedReviewPrs = new Set();

  // 後段の housekeeping（ログ整理・一時ファイル削除）から除外する稼働中ワーカーを先に
  // 組み立てる。失敗時は fail-closed: kill ループも housekeeping も実行せず中断し、
  // 終了コードに反映させる（除外リストを組み立てられないまま破壊的処理を進めない。
  // Issue #267）。workerName 指定の部分 sweep では他ワーカーを誤って対象にしないため
  // ここでは何もしない。
  if (!opts.match) {
    try {
      const { collectHousekeepingExclusions } = require('./shared/collect-housekeeping-exclusions');
      const { workerNames, reviewPrs } = collectHousekeepingExclusions(workspace);
      for (const name of workerNames) excludedWorkerNames.add(name);
      for (const pr of reviewPrs) excludedReviewPrs.add(pr);
    } catch (e) {
      results.errors.push(`sweep: 稼働中ワーカー除外リストの構築に失敗したため掃除を中断します: ${e.message}`);
      return results;
    }
  }

  for (const { entry, filePaths } of byPid.values()) {
    const entryPid = entry.pid;

    if (!isProcessAlive(entryPid)) {
      removeFiles(filePaths);
      results.cleaned.push({ pid: entryPid, reason: 'process not alive' });
      continue;
    }

    // プロセス生存 → 同一性確認
    const identity = verifyProcessIdentity(entryPid, entry);
    if (!identity.match) {
      // PID再利用 → ファイル削除のみ（無関係なプロセスを kill しない）
      removeFiles(filePaths);
      results.cleaned.push({ pid: entryPid, reason: `identity mismatch: ${identity.reason}` });
      continue;
    }

    // 同一性一致 → kill（stale プロセス）
    // この sweep が処理を決めた時点では対象ログが開いている可能性があるため、
    // housekeeping のログ整理から除外する対象として workerName を渡す。
    if (entry.workerName && !opts.dryRun) {
      excludedWorkerNames.add(entry.workerName);
    }
    if (!opts.dryRun) {
      const { killProcessTree } = require('./kill-tree');
      killProcessTree(entryPid);
      removeFiles(filePaths);
    }
    results.killed.push({
      pid: entryPid,
      workerName: entry.workerName,
      script: entry.script,
    });
  }

  // 既存の stale sweep を workspace housekeeping の単一の権威にする。
  if (!opts.match) {
    // この sweep 自身が確認した生存ワーカー（PID registry 由来）を除外対象に加える。
    // kill を決めたワーカーはログが開いたままの可能性があるため、共有部品が収集した
    // workers.json / lease / .running 由来の除外対象に加えて housekeeping へ渡す。
    for (const { entry } of byPid.values()) {
      if (!entry.workerName || results.killed.some(k => k.workerName === entry.workerName)) continue;
      if (isProcessAlive(entry.pid) && verifyProcessIdentity(entry.pid, entry).match) {
        excludedWorkerNames.add(entry.workerName);
      }
    }
    const { sweepWorkspaceFiles } = require('./shared/workspace-housekeeping');
    const housekeeping = sweepWorkspaceFiles(workspace, { excludedWorkerNames, excludedReviewPrs, dryRun: opts.dryRun });
    results.errors.push(...housekeeping.errors);
    Object.defineProperty(results, 'housekeeping', { value: housekeeping, enumerable: false });
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
  PID再利用が検出されたエントリはファイル削除のみ行う（無関係なプロセスを保護）。

  終了コード: 0（成功）/ 1（エラー）。エラーには fail-closed も含まれる——
  稼働中ワーカーの除外リストを組み立てられない場合は、kill も housekeeping も
  実行せずに中断して 1 を返す（Issue #267）。`;

// ── エクスポート ──────────────────────────────────────────────────────
//
// module.exports は CLI ブロック（if (require.main === module)）より先に代入する。
// CLI 実行時は sweepRegistry が collect-housekeeping-exclusions を require し、そこから
// worker-liveness / worker-lease がこのモジュールへ循環 require する。この代入が後にあると、
// それらが require した process-lifecycle の exports が空のまま循環参照し、ロード時捕捉が
// undefined を掴む（Issue #267）。各 shared モジュール側も呼び出し時点で解決する防衛を入れる。

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
  legacyPidsDir,
  legacyPidFilePath,
  registerProcess,
  unregisterProcess,
  findRunningInstance,
  // 単一起動ロック
  startupLockPath,
  legacyStartupLockPath,
  acquireStartupLock,
  releaseStartupLock,
  // 同一性確認
  verifyProcessIdentity,
  // sweep
  sweepRegistry,
  // 統合
  cleanup,
  CLI_USAGE,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {}, '--worker-name': {} },
      booleans: ['--dry-run', '--help', '-h'],
      // サブコマンドはちょうど1つ（sweep）。未知フラグ・余剰位置引数はパーサ側で拒否。
      positionals: { min: 1, max: 1 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (hasGenuineHelpRequest(argv, err.errors)) {
      console.log(CLI_USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`process-lifecycle: ${e.message}`);
    console.error(CLI_USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
    console.log(CLI_USAGE);
    process.exit(0);
  }

  const workspace = values['--workspace'];
  const workerName = values['--worker-name'];
  const dryRun = values['--dry-run'] === true;

  const sub = rest[0];
  if (sub !== 'sweep') {
    console.error(CLI_USAGE);
    process.exit(1);
  }

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
