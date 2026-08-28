'use strict';
// running-review-managers.js
// Review Manager の manager.running を読み取り、PID とプロセス起動時刻の
// 同一性まで確認する共有ヘルパー。
//
// collect-housekeeping-exclusions.js（安全側）と worker-status.js（tolerant）だけで
// なく、start-review-manager.js の二重起動判定・assistant-watch.js の読み取り専用
// 判定も同じ経路を使う。manager.running は旧バージョンが PID だけを書いたファイルを
// 残している可能性があるため、旧形式を「稼働中」と断定することはしない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { normalizePid } = require('./worker-entry');
const { reviewArtifactPath } = require('./review-manager-paths');

let _injectedIsProcessAlive = null;
let _injectedVerifyProcessIdentity = null;
let _injectedGetProcessStartTime = null;

function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('../process-lifecycle').isProcessAlive;
  return fn(pid);
}

function _verifyProcessIdentity(pid, identity, opts) {
  const fn = _injectedVerifyProcessIdentity ?? require('../process-lifecycle').verifyProcessIdentity;
  return fn(pid, identity, opts);
}

function _getProcessStartTime(pid) {
  const fn = _injectedGetProcessStartTime ?? require('../process-lifecycle').getProcessStartTime;
  return fn(pid);
}

function _startTimesMatch(a, b) {
  return require('../process-lifecycle').startTimesMatch(a, b);
}

/**
 * manager.running の内容を解析する。
 *
 * 旧形式は、ファイル全体が正の整数PIDだけのテキストである。新形式は
 * {pid, startTime} のJSONオブジェクトで、startTime=null は「記録はできたが
 * 同一性確認に必要な時刻を取得できなかった」未確認レコードとして扱う。
 *
 * @param {string} raw
 * @param {string} [runningPath]
 * @returns {{pid: number, startTime: string|null, legacy: boolean, raw: string}}
 * @throws {Error} 形式またはPIDが不正な場合
 */
function parseRunningReviewManagerRecord(raw, runningPath = 'manager.running') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`manager.running の PID が不正です（PID/JSON解析不能）: ${runningPath}`);
  }

  const trimmed = raw.trim();
  // 旧形式は「PIDのみ」に限定する。Number('1e3') のような表記を旧形式として
  // 誤認すると、想定外の内容をプロセス識別子として扱うことになる。
  if (/^[1-9]\d*$/.test(trimmed)) {
    const pid = normalizePid(trimmed);
    if (pid !== null) return { pid, startTime: null, legacy: true, raw };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`manager.running の PID が不正です（PID/JSON解析不能）: ${runningPath}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`manager.running のレコード形式が不正です: ${runningPath}`);
  }

  const pid = normalizePid(parsed.pid);
  if (pid === null) {
    throw new Error(`manager.running の PID が不正です（解析不能）: ${runningPath}`);
  }

  const startTime = typeof parsed.startTime === 'string' && parsed.startTime.trim() !== ''
    ? parsed.startTime
    : null;
  return { pid, startTime, legacy: false, raw };
}

/**
 * stale と判断したファイルを、判定時に読んだ内容と変わっていない場合だけ削除する。
 *
 * @returns {{removed: boolean, disappeared?: boolean, changed?: boolean}}
 * @throws {Error} 再読込または削除に失敗した場合
 */
function removeIfUnchanged(runningPath, raw) {
  let current;
  try {
    current = fs.readFileSync(runningPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { removed: false, disappeared: true };
    throw new Error(`manager.running の再読み取りに失敗しました: ${runningPath}: ${e.message}`);
  }

  if (current !== raw) return { removed: false, changed: true };

  try {
    fs.unlinkSync(runningPath);
    return { removed: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { removed: false, disappeared: true };
    throw new Error(`manager.running のstaleファイル削除に失敗しました: ${runningPath}: ${e.message}`);
  }
}

function errorResult(message, onError) {
  const error = message instanceof Error ? message : new Error(message);
  if (onError === 'throw') throw error;
  return { status: 'error', error };
}

function finishStale({ runningPath, raw, record, pr, cleanupStale, onError, reason }) {
  if (cleanupStale) {
    let cleanup;
    try {
      cleanup = removeIfUnchanged(runningPath, raw);
    } catch (e) {
      return errorResult(e, onError);
    }
    if (cleanup.changed) {
      return errorResult(
        `manager.running が判定中に置き換えられました（削除を中止）: ${runningPath}`,
        onError
      );
    }
  }

  return {
    status: 'stale',
    pr,
    pid: record.pid,
    startTime: record.startTime,
    legacy: record.legacy,
    reason,
  };
}

/**
 * 1つの manager.running を解析・生存確認・同一性確認する。
 *
 * @param {string} runningPath
 * @param {object} [opts]
 * @param {string|number} [opts.pr] PR番号。旧形式コールバックへ渡す値
 * @param {'throw'|'skip'} [opts.onError='throw'] エラー時の動作
 * @param {boolean} [opts.cleanupStale=false] staleファイルを内容比較後に削除するか
 * @param {(pid:number)=>boolean} [opts.isProcessAliveFn]
 * @param {(pid:number,meta:object,opts?:object)=>{match:boolean,reason?:string}} [opts.verifyProcessIdentityFn]
 * @param {(pid:number,expectedStartTime:string)=>string|null} [opts.getProcessStartTimeFn]
 * @param {(info:{pr:string|null,pid:number,path:string,legacy:true})=>void} [opts.onLegacyLive]
 * @returns {{status:'missing'|'live'|'legacy-live'|'stale'|'error', pr:string|null, pid?:number, startTime?:string|null, legacy?:boolean, reason?:string, error?:Error}}
 */
function inspectRunningReviewManager(runningPath, opts = {}) {
  const onError = opts.onError || 'throw';
  const pr = opts.pr == null ? null : String(opts.pr);
  const isAlive = opts.isProcessAliveFn || _isProcessAlive;
  const verifyIdentity = opts.verifyProcessIdentityFn || _verifyProcessIdentity;
  const getStartTime = opts.getProcessStartTimeFn || _injectedGetProcessStartTime;
  const cleanupStale = opts.cleanupStale === true;

  let raw;
  try {
    raw = fs.readFileSync(runningPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing', pr };
    return errorResult(`manager.running の読み取りに失敗しました: ${runningPath}: ${e.message}`, onError);
  }

  let record;
  try {
    record = parseRunningReviewManagerRecord(raw, runningPath);
  } catch (e) {
    return errorResult(e, onError);
  }

  let alive;
  try {
    alive = Boolean(isAlive(record.pid));
  } catch (e) {
    return errorResult(`manager.running のPID生存確認に失敗しました: ${runningPath}: ${e.message}`, onError);
  }

  if (record.legacy) {
    if (!alive) {
      return finishStale({
        runningPath, raw, record, pr, cleanupStale, onError,
        reason: 'legacy PID process not alive',
      });
    }

    // 旧PID-onlyは同一性を検証できないため live とは返さない。ただしアップグレード
    // 直後にまだ旧RMが動いている間は、そのPRのログを掃除から守る必要がある。
    // ここは「稼働中と断定」する経路ではなく、当該PRだけを保守的に保護する経路である。
    if (typeof opts.onLegacyLive === 'function') {
      try {
        opts.onLegacyLive({ pr, pid: record.pid, path: runningPath, legacy: true });
      } catch (e) {
        return errorResult(`旧形式manager.runningの保護通知に失敗しました: ${runningPath}: ${e.message}`, onError);
      }
    }
    return {
      status: 'legacy-live',
      pr,
      pid: record.pid,
      startTime: null,
      legacy: true,
      reason: 'legacy PID-only record cannot verify process identity',
    };
  }

  if (!alive) {
    return finishStale({
      runningPath, raw, record, pr, cleanupStale, onError,
      reason: 'process not alive',
    });
  }

  if (!record.startTime) {
    return errorResult(
      `manager.running の起動時刻が不正です（同一性確認不能）: ${runningPath}`,
      onError
    );
  }

  let identity;
  try {
    const verifyOpts = getStartTime
      ? { actualStartTime: getStartTime(record.pid, record.startTime) }
      : undefined;
    identity = verifyIdentity(record.pid, { startTime: record.startTime }, verifyOpts);
  } catch (e) {
    return errorResult(`manager.running の同一性確認に失敗しました: ${runningPath}: ${e.message}`, onError);
  }

  if (identity === true || (identity && identity.match === true)) {
    return {
      status: 'live',
      pr,
      pid: record.pid,
      startTime: record.startTime,
      legacy: false,
    };
  }

  const reason = identity && identity.reason ? String(identity.reason) : 'identity could not be verified';
  // canonical verifyProcessIdentity が返す「process not alive」と「start time mismatch」は
  // stale と確定できる。それ以外（起動時刻の取得不能・不正日付等）は、稼働中プロセスを
  // 消す根拠にならないためファイルを保持してエラー/skipにする。
  if (reason === 'process not alive' || /^start time mismatch:/.test(reason)) {
    return finishStale({ runningPath, raw, record, pr, cleanupStale, onError, reason });
  }

  return errorResult(
    `manager.running の同一性を確認できません: ${runningPath}: ${reason}`,
    onError
  );
}

/**
 * manager.running を新形式で原子的に書き出す。
 * startTime=null はOSから起動時刻を取得できなかった場合の未確認値であり、
 * 呼び出し側で現在時刻を捏造しない。
 *
 * @param {string} runningPath
 * @param {{pid:number|string,startTime?:string|null}} record
 * @returns {string}
 */
function writeRunningReviewManager(runningPath, record) {
  const pid = normalizePid(record && record.pid);
  if (pid === null) throw new Error(`manager.running のPIDが不正です: ${runningPath}`);
  const startTime = record && record.startTime != null ? record.startTime : null;
  if (startTime !== null && (typeof startTime !== 'string' || startTime.trim() === '')) {
    throw new Error(`manager.running の起動時刻が不正です: ${runningPath}`);
  }
  atomicWriteJson(runningPath, { pid, startTime });
  return runningPath;
}

/**
 * 指定した所有者の manager.running だけを、内容比較後に削除する。
 *
 * @param {string} runningPath
 * @param {{pid:number|string,startTime?:string|null}} owner
 * @returns {{released:boolean,missing?:boolean,changed?:boolean,reason?:string}}
 */
function removeRunningReviewManagerIfOwned(runningPath, owner) {
  const ownerPid = normalizePid(owner && owner.pid);
  if (ownerPid === null) return { released: false, reason: 'owner pid unavailable' };

  let raw;
  try {
    raw = fs.readFileSync(runningPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { released: true, missing: true };
    return { released: false, reason: `read failed: ${e.message}` };
  }

  let record;
  try {
    record = parseRunningReviewManagerRecord(raw, runningPath);
  } catch (e) {
    return { released: false, reason: e.message };
  }
  if (record.pid !== ownerPid) {
    return { released: false, reason: 'different owner' };
  }

  const ownerStartTime = owner && owner.startTime != null ? owner.startTime : null;
  // 旧形式は同一性を検証できないが、現在プロセスが自分で書いた起動マーカーを
  // 解放する既存の終了経路との互換性のため、PID一致時だけ解放を許可する。
  // 新形式同士は起動時刻も一致しなければ別周回のレコードとみなす。
  if (!record.legacy) {
    if (!ownerStartTime || !record.startTime || !_startTimesMatch(ownerStartTime, record.startTime)) {
      return { released: false, reason: 'different process identity' };
    }
  }

  try {
    const cleanup = removeIfUnchanged(runningPath, raw);
    if (cleanup.changed) return { released: false, changed: true, reason: 'record changed' };
    return { released: true, missing: cleanup.disappeared };
  } catch (e) {
    return { released: false, reason: e.message };
  }
}

/**
 * records/pr/<PR>/review/manager.running を走査し、同一性確認済みの Review Manager を列挙する。
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {'throw'|'skip'} [opts.onError='throw'] 不正値・読み取り不能時の挙動
 * @param {boolean} [opts.cleanupStale=false] staleファイルを回収するか
 * @param {(pid:number)=>boolean} [opts.isProcessAliveFn]
 * @param {(pid:number,meta:object,opts?:object)=>{match:boolean,reason?:string}} [opts.verifyProcessIdentityFn]
 * @param {(pid:number,expectedStartTime:string)=>string|null} [opts.getProcessStartTimeFn]
 * @param {(info:object)=>void} [opts.onLegacyLive] 旧形式の生存PIDを当該PRの保護対象として通知
 * @returns {Array<{pr:string,pid:number,startTime:string}>}
 */
function listRunningReviewManagers(workspace, opts = {}) {
  const onError = opts.onError || 'throw';
  const ghDir = path.join(workspace, '.gh-maestro');
  const prDir = path.join(ghDir, 'records', 'pr');
  if (!fs.existsSync(prDir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(prDir, { withFileTypes: true });
  } catch (e) {
    if (onError === 'throw') {
      throw new Error(`records/pr の走査に失敗しました: ${prDir}: ${e.message}`);
    }
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const runningPath = reviewArtifactPath(ghDir, entry.name, '.running');
    const inspection = inspectRunningReviewManager(runningPath, {
      ...opts,
      pr: entry.name,
      onError,
    });
    if (inspection.status === 'live') {
      results.push({ pr: entry.name, pid: inspection.pid, startTime: inspection.startTime });
    }
  }

  return results;
}

module.exports = {
  parseRunningReviewManagerRecord,
  inspectRunningReviewManager,
  listRunningReviewManagers,
  writeRunningReviewManager,
  removeRunningReviewManagerIfOwned,
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _injectedVerifyProcessIdentity = fn; },
  _setGetProcessStartTime: (fn) => { _injectedGetProcessStartTime = fn; },
};
