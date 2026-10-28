#!/usr/bin/env node
// process-lifecycle.js — ポーリングプロセスのライフサイクル管理（共通モジュール）
//
// 提供する機能:
//   - 親プロセスの解決
//   - PID registry（1プロセス1ファイル）: 登録・解除・sweep
//
// Usage (module):
//   const plc = require('./process-lifecycle');
//
//   // Parent monitoring
//   const sessionPid = plc.resolveSessionPid(cliFlagValue);
//   const liveness = require('./shared/process-liveness');
//   const checkParent = liveness.watchParent(liveness.captureProcess(sessionPid));
//
//   // PID registry
//   plc.registerProcess(workspace, { workerName, script: 'msg-poll.js' });
//   // ... polling loop with checkParent() ...
//   plc.cleanup(workspace);
//
// Usage (CLI):
//   node process-lifecycle.js sweep --workspace <path> [--worker-name <name>] [--dry-run]
//   node process-lifecycle.js status --workspace <path> --script <name> [--worker-name <name>]

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('./shared/child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const storageLayout = require('./shared/storage-layout');

const IS_WIN = process.platform === 'win32';
let injectedLiveness = null;
function getLiveness(candidate) {
  return candidate || injectedLiveness || require('./shared/process-liveness');
}

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
 * @returns {number|null} セッションルートPID（特定不能時は、起点省略なら process.ppid、
 *   明示起点なら null）
 */
function findSessionRootPid(startPid) {
  let pid = startPid || process.pid;
  let found = startPid ? null : process.ppid; // 明示起点では別プロセスのppidを流用しない
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

// ── PID Registry（1プロセス1ファイル） ─────────────────────────────────
//
// Issue #214: PID registry は本来 workspace 固有の runtime 状態であり、
// install.js が権威的に prune する managed root（~/.gh-maestro/）とは
// 物理的に別の runtime root（storage-layout.js の runtimeRoot()）に置く。
// workspace が誤ってホームディレクトリ（＝managed root の親）に解決された
// 場合は pidsDir()/legacyPidsDir() の入口で assertValidWorkspace が throw し、
// 以後のあらゆる pids 操作（作成・sweep・lock）を一括で遮断する（fail-closed）。
//
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
 * 旧遺物の検査・整理専用。
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
 * 自プロセスを runtime の PID registry に登録する。
 *
 * @param {string} workspace
 * @param {object} meta
 * @param {number} [meta.pid] 対象プロセスのPID（省略時は現在のプロセス）
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
  storageLayout.ensureWorkspaceRuntimeDir(workspace, {
    register: !storageLayout.isNodeTestContext(),
  });
  fs.mkdirSync(dir, { recursive: true });

  const targetPid = (meta && meta.pid != null) ? parseInt(meta.pid, 10) : process.pid;
  if (!Number.isFinite(targetPid) || targetPid <= 0) {
    throw new Error(`registerProcess: 不正な PID です: ${meta && meta.pid}`);
  }

  const checker = getLiveness(meta.liveness);
  const { processRef, ...recordMeta } = meta;
  delete recordMeta.liveness;
  const ref = processRef || (meta.startTime
    ? checker.readRef({ pid: targetPid, startTime: meta.startTime })
    : targetPid === process.pid
      ? checker.captureSelf()
      : checker.captureProcess(targetPid));
  if (checker.observe(ref) !== 'alive') {
    throw new Error(`registerProcess: PID ${targetPid} の生存と同一性を確認できません`);
  }
  const entry = checker.writeRef({
    ...recordMeta,
    script: meta.script || path.basename(process.argv[1] || 'unknown'),
    args: meta.args || process.argv.slice(2),
    workerName: meta.workerName || null,
    workspace,
    registeredAt: new Date().toISOString(),
  }, ref);

  const filePath = pidFilePath(workspace, entry.pid);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');

  return entry;
}

/**
 * 自プロセス（または指定PID）を PID registry から解除する。
 * runtime のレジストリから削除する。
 *
 * @param {string} workspace
 * @param {number} [pid] 省略時は process.pid
 * @param {{startTime?: string, script?: string, workerName?: string|null}} [expected]
 *   指定時は同じ起動主体の registry だけを削除する。停止後のPID再利用で
 *   新しいプロセスの登録を消さないため、停止側から渡す。
 */
function unregisterProcess(workspace, pid, expected) {
  const targetPid = pid || process.pid;

  const belongsToExpectedProcess = (filePath) => {
    if (!expected) return true;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // 読めないregistryは所有者を確認できないため、停止側からの削除を拒否する。
      return false;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (entry.pid !== targetPid) return false;
    if (expected.startTime !== undefined && entry.startTime !== expected.startTime) return false;
    if (expected.script !== undefined && entry.script !== expected.script) return false;
    if (expected.workerName !== undefined
      && (entry.workerName ?? null) !== (expected.workerName ?? null)) return false;
    return true;
  };

  const removeIfOwned = (filePath, bestEffort = false) => {
    if (!fs.existsSync(filePath) || !belongsToExpectedProcess(filePath)) return;
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (!bestEffort && e.code !== 'ENOENT') throw e;
    }
  };

  const filePath = pidFilePath(workspace, targetPid);
  removeIfOwned(filePath);


}

// ── プロセス同一性確認（PID再利用対策） ──────────────────────────────

/**
 * 同一の inbox（script + workerName + workspace）を既に監視している
 * 生存プロセスを registry から全件探す（非破壊・読み取り専用）。
 *
 * msg-poll.js 等の継続ポーリングスクリプトが、起動前に同じ監視対象の
 * 多重起動を検知するために使う。sweepRegistry と異なり kill もファイル削除も行わない。
 *
 * @param {string} workspace
 * @param {object} opts
 * @param {string} opts.script       スクリプト名（例: "msg-poll.js"）
 * @param {string|null} opts.workerName  worker名。orchestrator モードは null を渡す
 * @param {boolean} [opts.failOnReadError=false] true の場合、registry ディレクトリ・個別
 *   エントリの読み取りまたはJSON解析に失敗したら throw する。ディレクトリ自体が無い場合は
 *   「エントリなし」として空配列を返す。
 * @returns {object[]} 一致する生存エントリ（PID重複は除外済み）
 */
function findRunningInstances(workspace, opts = {}) {
  const dirs = [pidsDir(workspace)];
  const seenPids = new Set();
  const matches = [];
  const checker = getLiveness(opts.liveness);

  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (e) {
      // registry がまだ作られていない状態は「対象なし」であり、読み取り失敗ではない。
      if (e.code === 'ENOENT') continue;
      if (opts.failOnReadError) {
        throw new Error(`PID registry ディレクトリを読み取れません: ${dir}: ${e.message}`, { cause: e });
      }
      continue;
    }

    for (const file of files) {
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (e) {
        if (opts.failOnReadError) {
          throw new Error(`PID registry エントリを読み取れません: ${path.join(dir, file)}: ${e.message}`, { cause: e });
        }
        continue;
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        if (opts.failOnReadError) {
          throw new Error(`PID registry エントリの形式が不正です: ${path.join(dir, file)}`);
        }
        continue;
      }
      if (opts.script && typeof entry.script !== 'string') {
        if (opts.failOnReadError) {
          throw new Error(`PID registry エントリにscriptがありません: ${path.join(dir, file)}`);
        }
        continue;
      }
      if (opts.script && entry.script !== opts.script) continue;
      // findRunningInstances で workerName が省略された場合は全workerを返す。
      // 従来の findRunningInstance は省略時を orchestrator(null) と解釈するため、
      // ラッパー側で明示的に null を補う。
      if (opts.workerName !== undefined) {
        if (entry.workerName != null && typeof entry.workerName !== 'string') {
          if (opts.failOnReadError) {
            throw new Error(`PID registry エントリのworkerNameが不正です: ${path.join(dir, file)}`);
          }
          continue;
        }
        if ((entry.workerName ?? null) !== opts.workerName) continue;
      }
      // registryには登録時の表記が保存される一方、検索側はruntime registryの列挙結果など
      // から正規化済みのworkspaceを受け取ることがある。registryの配置キーと同じ正規化を
      // フィールド比較にも適用し、表記差だけで稼働中プロセスを除外しない。
      if (typeof entry.workspace !== 'string') {
        if (opts.failOnReadError) {
          throw new Error(`PID registry エントリにworkspaceがありません: ${path.join(dir, file)}`);
        }
        continue;
      }
      if (storageLayout.canonicalWorkspace(entry.workspace) !== storageLayout.canonicalWorkspace(workspace)) {
        continue;
      }

      const entryPid = entry.pid;
      if (!Number.isInteger(entryPid) || entryPid <= 0) {
        if (opts.failOnReadError) {
          throw new Error(`PID registry エントリのPIDが不正です: ${path.join(dir, file)}`);
        }
        continue;
      }
      if (opts.allowSelf !== true && entryPid === process.pid) continue;
      // 同一 PID の重複レコードは一度だけ判定する。
      if (seenPids.has(entryPid)) continue;
      seenPids.add(entryPid);
      const state = checker.observe(checker.readRef(entry));
      if (state === 'unknown') {
        throw new Error(`PID registry の生死を判定できません: ${entryPid}`);
      }
      if (state !== 'alive') continue;

      matches.push(entry);
    }
  }

  return matches;
}

/**
 * 同一の inbox（script + workerName + workspace）を既に監視している
 * 生存プロセスを registry から1件探す（非破壊・読み取り専用）。
 *
 * findRunningInstances と同じ同一性確認を使い、既存呼び出し元へは従来どおり
 * 最初の1件だけを返す。複数の常駐プロセスを入れ替えるCLIなど、registryに保存された
 * 引数を全件引き継ぐ必要がある呼び出し元は findRunningInstances を使う。
 *
 * @param {string} workspace
 * @param {object} opts
 * @returns {object|null} 一致する生存エントリ（無ければ null）
 */
function findRunningInstance(workspace, opts = {}) {
  return findRunningInstances(workspace, {
    ...opts,
    workerName: opts.workerName ?? null,
  })[0] || null;
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
 * 旧形式の単一起動ロックファイルのパスを返す。
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
 * acquireStartupLock の内部ヘルパー。
 *
 * @param {string} dir mkdir 対象ディレクトリ（lockPath の親）
 * @param {string} lockPath
 * @param {number} maxRetries
 * @param {{pid: number, startTime: string}} selfEntry 呼び出し元で1回だけ計算した自分自身のエントリ。
 *   getProcessStartTime は Windows では PowerShell/WMI 呼び出しを伴い高コストなため、
 * @returns {boolean}
 */
function acquireLockAt(dir, lockPath, maxRetries, selfEntry, checker) {
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(selfEntry), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    let holder;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (error) {
      throw new Error(`ロック ${lockPath} の保持者を読めません: ${error.message}`, { cause: error });
    }
    const state = checker.observe(checker.readRef(holder));
    if (state === 'unknown') {
      throw new Error(`ロック ${lockPath} の保持者 ${JSON.stringify(holder)} の生死を判定できません`);
    }
    const holderMatches = state === 'alive';
    if (holderMatches) {
      // 正当な保持者がいる → 取得失敗
      return false;
    }

    // stale ロック（保持者が非生存、またはPID再利用）→ 奪取して再試行
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
 * @param {string} workspace
 * @param {string} script
 * @param {string|null} workerName
 * @param {object} [opts]
 * @param {number} [opts.maxRetries] stale ロック奪取の最大リトライ回数（既定: 5）
 * @returns {boolean} 取得できれば true
 */
function acquireStartupLock(workspace, script, workerName, opts = {}) {
  const maxRetries = opts.maxRetries ?? 5;

  const checker = getLiveness(opts.liveness);
  const selfRef = checker.captureSelf();
  if (checker.observe(selfRef) !== 'alive') throw new Error('起動ロック保持者の生死を判定できません');
  const selfEntry = checker.writeRef({}, selfRef);

  const dir = pidsDir(workspace);
  return acquireLockAt(dir, startupLockPath(workspace, script, workerName), maxRetries, selfEntry, checker);
}

/**
 * 自プロセスが保持している起動ロックを解放する。
 * 自分が保持者でない場合は何もしない（他プロセスのロックを誤って消さない）。
 *
 * @param {string} workspace
 * @param {string} script
 * @param {string|null} workerName
 */
function releaseStartupLock(workspace, script, workerName) {
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
 * runtime のレジストリのみを走査する。旧配置は遺物整理で扱う。
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {(entry: object) => boolean} [opts.match] エントリのフィルタ関数
 * @param {boolean} [opts.dryRun] true なら実際の kill/削除を行わない
 * @returns {{ killed: object[], cleaned: object[], errors: string[] }}
 */
function sweepRegistry(workspace, opts = {}) {
  const dirs = [pidsDir(workspace)];
  const results = { killed: [], cleaned: [], errors: [] };

  const hasRegistry = dirs.some(d => fs.existsSync(d));

  // entryPid -> { entry, filePaths: string[] }（同じ PID のエントリを集約する）
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
      } catch (error) {
        results.errors.push(`PID registry ${filePath} を読めません: ${error.message}`);
        continue;
      }

      // JSON.parse が null や非オブジェクト（文字列・数値等）を返した場合は不正データとして扱う
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        results.errors.push(`PID registry ${filePath}: invalid entry type: ${entry === null ? 'null' : typeof entry}`);
        continue;
      }

      const entryPid = entry.pid;
      if (!entryPid || !Number.isFinite(entryPid)) {
        results.errors.push(`PID registry ${filePath}: missing/invalid pid`);
        continue;
      }

      // フィルタ
      if (opts.match && !opts.match(entry)) continue;

      if (!byPid.has(entryPid)) byPid.set(entryPid, { entry, filePaths: [] });
      byPid.get(entryPid).filePaths.push(filePath);
    }
  }

  if (results.errors.length > 0) return results;

  const removeFiles = (filePaths) => {
    if (opts.dryRun) return;
    for (const fp of filePaths) {
      try { fs.unlinkSync(fp); } catch {}
    }
  };

  const excludedWorkerNames = new Set();
  const excludedReviewPrs = new Set();
  const excludedPids = new Set();

  // 前段の kill ループおよび後段の housekeeping（ログ整理・一時ファイル削除）から除外する
  // 稼働中ワーカー・常駐プロセスを先に組み立てる。失敗時は fail-closed: kill ループも
  // housekeeping も実行せず中断し、終了コードに反映させる（除外リストを組み立てられないまま
  // 破壊的処理を進めない。Issue #267）。workerName 指定の部分 sweep では他ワーカーを誤って
  // 対象にしないためここでは何もしない。
  if (!opts.match) {
    try {
      const { collectHousekeepingExclusions } = require('./shared/collect-housekeeping-exclusions');
      const { workerNames, reviewPrs, pids } = collectHousekeepingExclusions(workspace, {
        // --dry-run は manager.running の stale 回収も含めて書き込みを行わない。
        cleanupStale: !opts.dryRun,
      });
      for (const name of workerNames) excludedWorkerNames.add(name);
      for (const pr of reviewPrs) excludedReviewPrs.add(pr);
      if (pids) {
        for (const pid of pids) excludedPids.add(pid);
      }
    } catch (e) {
      results.errors.push(`sweep: 稼働中ワーカー除外リストの構築に失敗したため掃除を中断します: ${e.message}`);
      return results;
    }
  }

  const checker = getLiveness(opts.liveness);
  const states = new Map();
  for (const { entry } of byPid.values()) {
    const state = checker.observe(checker.readRef(entry));
    states.set(entry.pid, state);
    if (state === 'unknown') results.errors.push(`PID registry の生死を判定できません: ${entry.pid}`);
  }
  if (results.errors.length > 0) return results;

  for (const { entry, filePaths } of byPid.values()) {
    const entryPid = entry.pid;

    const state = states.get(entryPid);
    if (state === 'dead') {
      removeFiles(filePaths);
      results.cleaned.push({ pid: entryPid, reason: 'process not alive or identity mismatch' });
      continue;
    }

    // 除外対象（role lease 保持者、稼働中ワーカー、稼働中Review ManagerのPRなど）の PID、workerName、PRは kill しない
    if (excludedPids.has(entryPid)
      || (entry.workerName && excludedWorkerNames.has(entry.workerName))
      || (entry.pr != null && excludedReviewPrs.has(String(entry.pr)))) {
      continue;
    }

    // 同一性一致 → kill（stale プロセス）
    // この sweep が処理を決めた時点では対象ログが開いている可能性があるため、
    // housekeeping のログ整理から除外する対象として workerName を渡す。
    if (entry.workerName && !opts.dryRun) {
      excludedWorkerNames.add(entry.workerName);
    }
    if (!opts.dryRun) {
      const { killProcessTree } = require('./shared/kill-tree');
      killProcessTree(entryPid);
      removeFiles(filePaths);
    }
    results.killed.push({
      pid: entryPid,
      workerName: entry.workerName,
      script: entry.script,
    });
  }

  // A failed observation cannot safely establish housekeeping exclusions.
  if (results.errors.length > 0) return results;

  // 既存の stale sweep を workspace housekeeping の単一の権威にする。
  if (!opts.match) {
    // この sweep 自身が確認した生存ワーカー（PID registry 由来）を除外対象に加える。
    // kill を決めたワーカーはログが開いたままの可能性があるため、共有部品が収集した
    // workers.json / lease / .running 由来の除外対象に加えて housekeeping へ渡す。
    for (const { entry } of byPid.values()) {
      if (!entry.workerName || results.killed.some(k => k.workerName === entry.workerName)) continue;
      if (states.get(entry.pid) !== 'dead') {
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

// ── CLI エントリポイント ───────────────────────────────────────────────

const CLI_USAGE = `process-lifecycle.js — プロセスライフサイクル管理

Usage:
  node process-lifecycle.js sweep --workspace <path> [--worker-name <name>] [--dry-run]
  node process-lifecycle.js status --workspace <path> --script <name> [--worker-name <name>]

Options:
  --workspace <path>     ワークスペースパス（必須）
  --script <name>        status 対象のスクリプト名（例: msg-poll.js）
  --worker-name <name>   sweep/status 対象のworker名。status では省略時 null
  --dry-run              実際のkill/削除を行わず、対象のみ表示

Description:
  PID registry を走査し、stale エントリを掃除する。
  各エントリは同一性確認（起動時刻比較）を経て、一致する場合のみ kill される。
  PID再利用が検出されたエントリはファイル削除のみ行う（無関係なプロセスを保護）。

  status は指定した workspace・script・workerName の生存プロセスを読み取り専用で照会する。
  stdout には {"script":...,"workerName":...,"running":true|false,"pid":...} を出力する。
  running=false は照会成功（対象プロセスなし）を表し、終了コードは 0。

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
  _setLiveness: (value) => { injectedLiveness = value || null; },
  // 親セッション監視
  getParentPid,
  findSessionRootPid,
  resolveSessionPid,
  // PID registry
  pidsDir,
  pidFilePath,
  legacyPidsDir,
  legacyPidFilePath,
  registerProcess,
  unregisterProcess,
  findRunningInstances,
  findRunningInstance,
  // 単一起動ロック
  startupLockPath,
  legacyStartupLockPath,
  acquireStartupLock,
  releaseStartupLock,
  // sweep
  sweepRegistry,
  // 統合
  cleanup,
  // CLI
  main,
  CLI_USAGE,
};

/**
 * process-lifecycle CLI を実行する。
 *
 * status は PID registry の読み取りだけを行い、対象がいない場合も
 * running:false を返す。CLI の誤用や registry 読み取り失敗とは終了コードで区別する。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @returns {{ code: number, lines: string[], errLines: string[] }}
 */
function main(argv = process.argv.slice(2)) {
  const out = [];
  const err = [];
  const writeOut = (line) => out.push(line);
  const writeErr = (line) => err.push(line);

  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {}, '--script': {}, '--worker-name': {} },
      booleans: ['--dry-run', '--help', '-h'],
      // サブコマンドはちょうど1つ。未知フラグ・余剰位置引数はパーサ側で拒否。
      positionals: { min: 1, max: 1 },
    }));
  } catch (parseError) {
    if (parseError.name !== 'ArgsValidationError') throw parseError;
    if (parseError.helpRequested) {
      writeOut(CLI_USAGE);
      return { code: 0, lines: out, errLines: [] };
    }
    for (const e of parseError.errors) writeErr(`process-lifecycle: ${e.message}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(CLI_USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const sub = rest[0];
  if (sub !== 'sweep' && sub !== 'status') {
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (!values['--workspace']) {
    writeErr('process-lifecycle: --workspace が必要です');
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('process-lifecycle: ワークスペースを解決できません');
    return { code: 1, lines: out, errLines: err };
  }

  if (sub === 'status') {
    const script = values['--script'];
    if (!script) {
      writeErr('process-lifecycle: status には --script が必要です');
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }
    if (values['--dry-run'] === true) {
      writeErr('process-lifecycle: --dry-run は sweep でのみ使用できます');
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    const workerName = values['--worker-name'] ?? null;
    let entry;
    try {
      entry = findRunningInstance(workspace, { script, workerName, failOnReadError: true });
    } catch (e) {
      writeErr(`process-lifecycle: status の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    writeOut(JSON.stringify({
      script,
      workerName,
      running: Boolean(entry),
      pid: entry ? entry.pid : null,
    }));
    return { code: 0, lines: out, errLines: err };
  }

  if (values['--script'] !== undefined) {
    writeErr('process-lifecycle: --script は status でのみ使用できます');
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workerName = values['--worker-name'];
  const dryRun = values['--dry-run'] === true;
  const matchFilter = workerName
    ? (entry) => entry.workerName === workerName
    : undefined;

  let results;
  try {
    results = sweepRegistry(workspace, { match: matchFilter, dryRun });
  } catch (e) {
    writeErr(`process-lifecycle: sweep に失敗しました: ${e.message}`);
    return { code: 1, lines: out, errLines: err };
  }

  if (dryRun) writeOut('[dry-run] 実際のkill/削除は行いません');
  if (results.killed.length > 0) {
    writeOut(`Killed (${results.killed.length}):`);
    for (const k of results.killed) {
      writeOut(`  pid=${k.pid} worker=${k.workerName || '-'} script=${k.script || '-'}`);
    }
  }
  if (results.cleaned.length > 0) {
    writeOut(`Cleaned stale entries (${results.cleaned.length}):`);
    for (const c of results.cleaned) {
      writeOut(`  pid=${c.pid || c.file} reason=${c.reason}`);
    }
  }
  if (results.errors.length > 0) {
    writeErr(`Errors (${results.errors.length}):`);
    for (const e of results.errors) writeErr(`  ${e}`);
  }
  if (results.killed.length === 0 && results.cleaned.length === 0 && results.errors.length === 0) {
    writeOut('No stale entries found.');
  }

  return { code: results.errors.length > 0 ? 1 : 0, lines: out, errLines: err };
}

if (require.main === module) {
  const result = main();
  for (const line of result.errLines) process.stderr.write(line + '\n');
  for (const line of result.lines) process.stdout.write(line + '\n');
  process.exit(result.code);
}
