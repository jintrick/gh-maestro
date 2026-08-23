'use strict';
// ensure-resident-daemon.js
//
// 常駐デーモン（worker-supervisor.js, msg-poll.js orchestrator 等）の自動起動共通基盤。
//
// 稼働中でなければ detached プロセスとして自動起動する。
// エージェントの記憶に頼らず、決定的なコード（spawn-worker.js / msg-send.js 等）から
// 呼び出すことで、必要な常駐プロセスの生存を保証する安全網。
//
// 共通で提供する機能（Issue #303 で一本化）:
// 1. ワークスペース / スクリプトパスのバリデーション
// 2. migrate-records.js の移行実行中（.migration-in-progress）の自動起動スキップ（Issue #256）
// 3. 稼働中判定（PID registry + role lease live）と二重起動防止
// 4. 生存観測時の失敗試行記録クリア
// 5. 自動復活の有界化と原子的予約（クールダウン判定。PR #302 / Issue #303）:
//    連続失敗時に呼び出しのたびに子プロセスとログが増え続けるのを防ぐため、
//    排他ロック下で最後に spawn を試みた時点（.gh-maestro/<attemptName>-autostart-attempt.json）を
//    原子的に予約更新し、クールダウン中（既定5分）の再試行をスキップする。
//    破損記録・未来時刻は fail-open で再試行を妨げない。
// 6. 親セッションPIDの同期解決（呼び出し元生存中の解決。Issue #256 実障害防止）
// 7. detached + windowsHide + unref + ログファイル管理
// 8. best-effort エラーハンドリング（例外を呼び出し元に伝播させない）
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('./child-process');
const { isResidentLeaseLive } = require('./worker-lease');
const { isMigrationInProgress } = require('./migration-marker');

// 直前の spawn 試行からこの時間内は再試行しない（PR #302 / Issue #303）。
const AUTOSTART_COOLDOWN_MS = 5 * 60 * 1000; // 5分

/**
 * 自動復活の試行記録ファイルのパス（.gh-maestro/ は install.js 管理外の per-workspace 領域）。
 */
function autostartAttemptPath(workspace, attemptName) {
  return path.join(workspace, '.gh-maestro', `${attemptName}-autostart-attempt.json`);
}

/**
 * 試行記録ロックファイルのパス。
 */
function autostartLockPath(workspace, attemptName) {
  return path.join(workspace, '.gh-maestro', `${attemptName}-autostart.lock`);
}

/**
 * 最後に spawn を試みた時点（エポックms）を返す。記録が無い・壊れている・未来時刻は null
 * （= クールダウンに掛からない）。比較に使うため型検証する（PR #100 準拠）。
 */
function readAutostartAttempt(workspace, attemptName) {
  try {
    const parsed = JSON.parse(fs.readFileSync(autostartAttemptPath(workspace, attemptName), 'utf8'));
    const lastAttemptAt = parsed && parsed.lastAttemptAt;
    if (typeof lastAttemptAt !== 'number' || !Number.isFinite(lastAttemptAt)) return null;
    if (lastAttemptAt > Date.now()) return null; // 未来時刻の記録は信頼しない
    return lastAttemptAt;
  } catch {
    return null;
  }
}

/**
 * spawn を試みた時点を記録する（best-effort）。spawn 自体が失敗しても記録は残り、
 * 次のトリガーで再試行を抑制する。記録に失敗した場合は fail-open。
 */
function recordAutostartAttempt(workspace, attemptName) {
  try {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(autostartAttemptPath(workspace, attemptName), JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * 試行記録を消す（生存を観測した時点で呼ぶ）。
 */
function clearAutostartAttempt(workspace, attemptName) {
  try { fs.unlinkSync(autostartAttemptPath(workspace, attemptName)); } catch {}
}

/**
 * 自動復活の試行を原子的に予約する（Issue #303 レビュー指摘 【1】）。
 * 排他ロックを取得した上で、既存記録がクールダウン中かを判定し、
 * クールダウン外であれば新しい時刻で記録を更新して true を返す。
 * 他プロセスが既に予約済み、またはクールダウン中であれば false を返す。
 */
function tryReserveAutostartAttempt(workspace, attemptName) {
  const ghDir = path.join(workspace, '.gh-maestro');
  try {
    fs.mkdirSync(ghDir, { recursive: true });
  } catch {
    // best-effort
  }

  const lockFile = autostartLockPath(workspace, attemptName);
  const attemptFile = autostartAttemptPath(workspace, attemptName);

  let lockFd;
  try {
    try {
      lockFd = fs.openSync(lockFile, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // stale lock 回収（10秒以上古いロックは回収）
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 10000) {
            try { fs.unlinkSync(lockFile); } catch {}
            lockFd = fs.openSync(lockFile, 'wx');
          } else {
            return false; // 他プロセスが予約処理中
          }
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }

    // 排他ロック下で既存試行時刻を検査
    const lastAttemptAt = readAutostartAttempt(workspace, attemptName);
    if (lastAttemptAt !== null && Date.now() - lastAttemptAt < AUTOSTART_COOLDOWN_MS) {
      return false; // クールダウン中
    }

    // クールダウン外（初回、期限切れ、破損、未来時刻） -> 原子的予約書き込み
    fs.writeFileSync(attemptFile, JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
}

/**
 * モジュールごとのテスト用フック入れ物を作成する。
 * process-lifecycle への依存は評価時ではなく呼び出し時まで遅延する（Issue #267）。
 */
function createDaemonHooks() {
  let _injectedFindSessionRootPid = null;
  let _injectedFindRunningInstance = null;
  let _spawn = (cmd, args, opts) => spawn(cmd, args, opts);
  let _isResidentLeaseLive = isResidentLeaseLive;
  let _isMigrationInProgress = isMigrationInProgress;

  return {
    getFindSessionRootPid: () => {
      const fn = _injectedFindSessionRootPid ?? require('../process-lifecycle').findSessionRootPid;
      return fn;
    },
    getFindRunningInstance: () => {
      const fn = _injectedFindRunningInstance ?? require('../process-lifecycle').findRunningInstance;
      return fn;
    },
    getSpawn: () => _spawn,
    getIsResidentLeaseLive: () => _isResidentLeaseLive,
    getIsMigrationInProgress: () => _isMigrationInProgress,
    setSpawn: (fn) => { _spawn = fn; },
    setFindSessionRootPid: (fn) => { _injectedFindSessionRootPid = fn; },
    setFindRunningInstance: (fn) => { _injectedFindRunningInstance = fn; },
    setIsResidentLeaseLive: (fn) => { _isResidentLeaseLive = fn; },
    setIsMigrationInProgress: (fn) => { _isMigrationInProgress = fn; },
  };
}

/**
 * 常駐プロセスの自動起動を行う。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - スクリプトが置かれているディレクトリ
 * @param {string} params.scriptName  - スクリプトファイル名（例: 'worker-supervisor.js'）
 * @param {string} [params.role]      - role lease名（指定時のみlease確認を行う）
 * @param {string} params.logFileName - ログファイル名（例: 'worker-supervisor-autostart.log'）
 * @param {string} params.attemptName - 試行記録識別名（例: 'worker-supervisor'）
 * @param {string[]} [params.legacyScriptNames] - 改名前の常駐script名（移行期間のみ検知）
 * @param {string[]} [params.legacyRoles] - 改名前のrole名（移行期間のみ検知）
 * @param {function} [params.buildArgs] - 引数構築関数 `({ workspace, sessionPid }) => string[]`
 * @param {object} [params.hooks]     - テスト用フックオブジェクト（createDaemonHooks 由来）
 */
function ensureResidentDaemon({
  workspace,
  scriptsPath,
  scriptName,
  role = null,
  logFileName,
  attemptName,
  legacyScriptNames = [],
  legacyRoles = [],
  buildArgs,
  hooks = null,
}) {
  if (!workspace || !scriptsPath || !scriptName || !logFileName || !attemptName) return;

  const checkMigration = hooks ? hooks.getIsMigrationInProgress() : isMigrationInProgress;
  if (checkMigration(workspace)) return;

  const findRunning = hooks ? hooks.getFindRunningInstance() : require('../process-lifecycle').findRunningInstance;
  const checkLease = hooks ? hooks.getIsResidentLeaseLive() : isResidentLeaseLive;

  try {
    const scriptNames = [scriptName, ...legacyScriptNames];
    if (scriptNames.some((script) => findRunning(workspace, { script, workerName: null }))) {
      clearAutostartAttempt(workspace, attemptName);
      return;
    }
    const roles = role ? [role, ...legacyRoles] : legacyRoles;
    if (roles.some((candidate) => checkLease({ workspace, role: candidate }))) {
      clearAutostartAttempt(workspace, attemptName);
      return;
    }
  } catch {
    // 判定失敗時は fail-open で spawn を試みる
  }

  // クールダウン予約を原子的に実行（排他制御下での判定＋記録書き込み。Issue #303）
  if (!tryReserveAutostartAttempt(workspace, attemptName)) {
    return;
  }

  let logFd;
  try {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    logFd = fs.openSync(path.join(ghDir, logFileName), 'a');

    let sessionPid = null;
    try {
      const resolvePid = hooks ? hooks.getFindSessionRootPid() : require('../process-lifecycle').findSessionRootPid;
      const pid = resolvePid();
      if (Number.isFinite(pid) && pid > 0) {
        sessionPid = pid;
      }
    } catch {
      // 解決失敗時はフォールバック
    }

    const scriptFullPath = path.join(scriptsPath, scriptName);
    const customArgs = typeof buildArgs === 'function'
      ? buildArgs({ workspace, sessionPid })
      : ['--workspace', workspace, ...(sessionPid ? ['--session-pid', String(sessionPid)] : [])];
    const args = [scriptFullPath, ...customArgs];

    const doSpawn = hooks ? hooks.getSpawn() : spawn;
    const child = doSpawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best-effort
  } finally {
    if (logFd !== undefined) {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

module.exports = {
  ensureResidentDaemon,
  createDaemonHooks,
  AUTOSTART_COOLDOWN_MS,
  autostartAttemptPath,
  autostartLockPath,
  readAutostartAttempt,
  recordAutostartAttempt,
  clearAutostartAttempt,
  tryReserveAutostartAttempt,
};
