'use strict';

const fs = require('fs');
const { execSync } = require('./child-process');
const IS_WIN = process.platform === 'win32';

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
 * 2つのプロセス起動時刻（ISO 文字列）が同一プロセスのものであるかを判定する。
 *
 * 1秒の許容範囲（WMI と JS Date の精度差を吸収）。不正な日付文字列は getTime() が
 * NaN を返すため、明示的に不一致扱いとする（NaN を無視すると常に一致に倒れて
 * PID再利用の誤判定が静かに復活する）。
 *
 * @param {string} a 起動時刻（ISO 文字列）
 * @param {string} b 起動時刻（ISO 文字列）
 * @returns {boolean} 同一プロセスの起動時刻なら true
 */
function startTimesMatch(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= 1000;
}

// The reference is an opaque, versioned serialized value. Only this module
// interprets it; callers may persist it or pass it back to this API.
function createLiveness(deps = {}) {
  const probe = deps.probePid || ((pid) => {
    try { process.kill(pid, 0); return 'alive'; }
    catch (error) {
      if (error && error.code === 'ESRCH') return 'dead';
      if (error && error.code === 'EPERM') return 'alive';
      return 'unknown';
    }
  });
  const readStartTime = deps.readStartTime || getProcessStartTime;
  const startTimeCacheMs = deps.startTimeCacheMs ?? 0;
  const now = deps.now || Date.now;
  const startTimeCache = new Map();
  let capturedSelfRef = null;
  function observeStartTime(pid, expectedStartTime) {
    if (!(startTimeCacheMs > 0)) return readStartTime(pid, expectedStartTime);
    const observedAt = now();
    const cached = startTimeCache.get(pid);
    const age = cached ? observedAt - cached.observedAt : Infinity;
    const fresh = cached && Number.isFinite(observedAt) && Number.isFinite(cached.observedAt)
      && age >= 0 && age < startTimeCacheMs;
    const expectedMatches = !expectedStartTime || (cached && (
      cached.startTime
        ? startTimesMatch(expectedStartTime, cached.startTime)
        : cached.expectedStartTime && startTimesMatch(expectedStartTime, cached.expectedStartTime)
    ));
    if (fresh && expectedMatches) return cached.startTime;
    const startTime = readStartTime(pid, expectedStartTime) || null;
    startTimeCache.set(pid, { startTime, expectedStartTime: expectedStartTime || null, observedAt });
    return startTime;
  }
  const encode = (pid, startTime) => Buffer.from(JSON.stringify({ v: 1, pid, startTime })).toString('base64url');
  const decode = (ref) => {
    try {
      const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
      if (!value || value.v !== 1 || !Number.isInteger(value.pid) || value.pid <= 0
          || (value.startTime !== null && typeof value.startTime !== 'string')) return null;
      return value;
    } catch { return null; }
  };
  function captureProcess(pid) {
    if ((typeof pid !== 'number' && typeof pid !== 'string') || (typeof pid === 'string' && !pid.trim())) {
      throw new Error('invalid process identifier');
    }
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) throw new Error('invalid process identifier');
    let startTime = null;
    try { startTime = readStartTime(n) || null; } catch { /* unknown */ }
    if (startTimeCacheMs > 0) {
      const observedAt = now();
      startTimeCache.set(n, {
        startTime,
        expectedStartTime: startTime,
        observedAt,
      });
    }
    return encode(n, startTime);
  }
  function captureSelf() {
    if (capturedSelfRef) return capturedSelfRef;
    const ref = captureProcess(process.pid);
    const value = decode(ref);
    if (value && value.startTime && !Number.isNaN(new Date(value.startTime).getTime())) {
      capturedSelfRef = ref;
    }
    return ref;
  }
  function readRef(record, format = 'default') {
    if (!record || typeof record !== 'object') return null;
    if (format !== 'default' && format !== 'session') throw new Error('invalid process reference format');
    const pid = format === 'session' ? record.sessionPid : record.pid;
    const time = format === 'session' ? record.sessionStartTime : record.startTime;
    if ((typeof pid !== 'number' && typeof pid !== 'string') || (typeof pid === 'string' && !pid.trim())) return null;
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return null;
    return encode(n, typeof time === 'string' && time ? time : null);
  }
  function writeRef(record, ref, format = 'default') {
    const value = decode(ref);
    if (!value) throw new Error('invalid process reference');
    if (format === 'session') return { ...record, sessionPid: value.pid, sessionStartTime: value.startTime };
    if (format !== 'default') throw new Error('invalid process reference format');
    return { ...record, pid: value.pid, startTime: value.startTime };
  }
  function observe(ref) {
    const value = decode(ref);
    if (!value) return 'unknown';
    let state;
    try { state = probe(value.pid); } catch { return 'unknown'; }
    if (state === 'dead') {
      startTimeCache.delete(value.pid);
      return 'dead';
    }
    if (state !== 'alive') return 'unknown';
    if (!value.startTime || Number.isNaN(new Date(value.startTime).getTime())) return 'unknown';
    // A process cannot outlive itself. Reusing a valid captured self reference avoids
    // querying the OS for our own start time on every lock/lease check.
    if (value.pid === process.pid && capturedSelfRef && sameRef(ref, capturedSelfRef)) return 'alive';
    let actual;
    try { actual = observeStartTime(value.pid, value.startTime); } catch { return 'unknown'; }
    if (!actual || Number.isNaN(new Date(actual).getTime()) || Number.isNaN(new Date(value.startTime).getTime())) return 'unknown';
    if (startTimesMatch(value.startTime, actual)) return 'alive';
    startTimeCache.delete(value.pid);
    return 'dead';
  }
  function sameRef(a, b) {
    const left = decode(a); const right = decode(b);
    return Boolean(left && right && left.pid === right.pid && startTimesMatch(left.startTime, right.startTime));
  }
  function watchParent(ref) {
    const value = decode(ref);
    let consecutiveDead = 0;
    return () => {
      if (!value) return true;
      let status;
      try { status = probe(value.pid); } catch { return true; }
      if (status === 'dead') return ++consecutiveDead < 3;
      if (status !== 'alive') { consecutiveDead = 0; return true; }
      if (value.startTime) {
        let actual;
        try { actual = observeStartTime(value.pid, value.startTime); } catch { actual = null; }
        if (actual && !Number.isNaN(new Date(actual).getTime())
            && !Number.isNaN(new Date(value.startTime).getTime())
            && !startTimesMatch(value.startTime, actual)) return false;
      }
      consecutiveDead = 0;
      return true;
    };
  }
  return { captureSelf, captureProcess, readRef, writeRef, observe, sameRef, watchParent };
}
const liveness = createLiveness();

module.exports = { createLiveness, ...liveness };

