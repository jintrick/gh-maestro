'use strict';

const fs = require('fs');
const { execSync } = require('./child-process');
const IS_WIN = process.platform === 'win32';

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
 * プロセスのPIDと起動時刻を一つのidentityとして捕捉する。
 *
 * leaseとPID registryのように同じプロセスidentityを複数の状態へ保存する呼び出し元は、
 * 起動時刻の取得をこの関数で一度だけ行い、戻り値を各保存先へ渡す。WindowsのCIM取得が
 * 失敗した場合は起動時刻を未知値（null）のまま返し、現在時刻などをプロセスidentityの
 * 代替値として保存しない。
 *
 * @param {number|string} [pid] 対象プロセスのPID
 * @param {(pid: number) => (string|null)} [getProcessStartTimeFn] テスト用の取得関数
 * @returns {{pid: number, startTime: string|null}}
 * @throws {Error} PIDが正の整数でない場合
 */
function captureProcessIdentity(pid = process.pid, getProcessStartTimeFn = getProcessStartTime) {
  const targetPid = parseInt(pid, 10);
  if (!Number.isFinite(targetPid) || targetPid <= 0) {
    throw new Error(`captureProcessIdentity: 不正な PID です: ${pid}`);
  }

  let startTime = null;
  try {
    startTime = getProcessStartTimeFn(targetPid);
  } catch {
    // getProcessStartTime() 自体は失敗をnullへ縮退する。注入関数でも同じbest-effort契約に揃える。
    startTime = null;
  }
  return {
    pid: targetPid,
    startTime: typeof startTime === 'string' && startTime !== '' ? startTime : null,
  };
}

/**
 * 2つのプロセス起動時刻（ISO 文字列）が同一プロセスのものであるかを判定する。
 *
 * 1秒の許容範囲（WMI と JS Date の精度差を吸収）。不正な日付文字列は getTime() が
 * NaN を返すため、明示的に不一致扱いとする（NaN を無視すると常に一致に倒れて
 * PID再利用の誤判定が静かに復活する）。verifyProcessIdentity と createDeadManSwitch の
 * 両方がこの比較意味論を共有する。
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

/**
 * dead-man's switch のチェック関数を作成する。
 *
 * 返された関数をポーリングループの毎周回で呼び出す。
 * 親が死んだことを検出したら false を返す（呼び出し側は cleanup して exit）。
 *
 * 判定は2段:
 * - PID が存在しない: isProcessAlive の一過性の誤検出を緩和するため、3回連続で
 *   確認するまで false を返さない。
 * - PID は存在するが起動時刻が期待値と不一致（同じ PID に別プロセスが再利用された）:
 *   起動時刻の不一致は確定事実（同一プロセスは起動時刻を変えない）のため、初回検出で
 *   即 false を返す。居座りを最大1ポーリング間隔で検出できる。
 *   起動時刻の取得失敗（null / throw）は一過性の読取失敗が疑われるため生存扱いとし、
 *   誤自滅しない（fail-open は誤自滅防止側に倒す。基本の isProcessAlive チェックは残る）。
 *
 * @param {number} monitorPid 監視対象PID
 * @param {object} [opts]
 * @param {string} [opts.expectedStartTime] 監視対象の起動時刻（PID再利用検知用。
 *   呼び出し元が起動時に getProcessStartTime で捕捉して渡す。未指定なら従来の
 *   isProcessAlive のみの判定にフォールバックする）
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

    // PID再利用チェック: 期待起動時刻と実起動時刻を比較
    if (expectedStartTime) {
      let actualStart = null;
      try {
        actualStart = getProcessStartTime(monitorPid);
      } catch {
        actualStart = null;
      }
      if (actualStart && !startTimesMatch(expectedStartTime, actualStart)) {
        // 同じPIDに別プロセスが居る → 元の親は死んだとみなす
        return false;
      }
      // 取得失敗（null）→ 読取失敗の可能性があるため生存扱い（誤自滅しない）
    }

    consecutiveDead = 0;
    return true;
  };
}

/**
 * 実行中のプロセスが registry エントリと同一か検証する。
 *
 * PID再利用事故を防ぐため、起動時刻を比較する。
 * Windows: Get-CimInstance Win32_Process の CreationDate
 * Linux:   /proc/<pid>/stat の starttime
 *
 * @param {number} pid
 * @param {object} registeredMeta  registry エントリ（registerProcess の戻り値）
 * @param {object} [opts]
 * @param {string|null} [opts.actualStartTime] 今回の判定用に呼び出し側が観測した実起動時刻。
 *   指定時は `getProcessStartTime(pid)` を呼ばず、この値を登録値と比較する。
 * @returns {{ match: boolean, reason?: string }}
 */
function verifyProcessIdentity(pid, registeredMeta, opts = {}) {
  if (!isProcessAlive(pid)) {
    return { match: false, reason: 'process not alive' };
  }

  const actualStartTime = Object.prototype.hasOwnProperty.call(opts, 'actualStartTime')
    ? opts.actualStartTime
    : getProcessStartTime(pid);
  if (!actualStartTime) {
    // 起動時刻が取得できない → 同一性確認不能
    // 安全のため「一致しない」と判定（無関係なプロセスを kill しない）
    return { match: false, reason: 'cannot get process start time' };
  }

  if (registeredMeta.startTime && !startTimesMatch(registeredMeta.startTime, actualStartTime)) {
    const regTime = new Date(registeredMeta.startTime).getTime();
    const actualTime = new Date(actualStartTime).getTime();
    // 不正な日付文字列の場合 getTime() が NaN を返す。
    // NaN > 1000 は false のため誤って一致判定（match:true）に倒れてしまう。
    // startTimesMatch が NaN を不一致扱いにするため、ここでは reason を区別して返す。
    const reason = (Number.isNaN(regTime) || Number.isNaN(actualTime))
      ? `invalid date: registered=${registeredMeta.startTime}, actual=${actualStartTime}`
      : `start time mismatch: registered=${registeredMeta.startTime}, actual=${actualStartTime}`;
    return { match: false, reason };
  }

  return { match: true };
}


// The reference is an opaque, versioned serialized value. Only this module
// interprets it; callers may persist it or pass it back to this API.
function createLiveness(deps = {}) {
  const probe = deps.probePid || ((pid) => {
    try { process.kill(pid, 0); return 'alive'; }
    catch (error) { return error && error.code === 'ESRCH' ? 'dead' : 'unknown'; }
  });
  const readStartTime = deps.readStartTime || getProcessStartTime;
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
    return encode(n, startTime);
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
    if (!value.startTime) return 'unknown';
    if (state === 'dead') return 'dead';
    if (state !== 'alive') return 'unknown';
    let actual;
    try { actual = readStartTime(value.pid, value.startTime); } catch { return 'unknown'; }
    if (!actual || Number.isNaN(new Date(actual).getTime()) || Number.isNaN(new Date(value.startTime).getTime())) return 'unknown';
    return startTimesMatch(value.startTime, actual) ? 'alive' : 'dead';
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
        try { actual = readStartTime(value.pid, value.startTime); } catch { actual = null; }
        if (actual && !Number.isNaN(new Date(actual).getTime())
            && !Number.isNaN(new Date(value.startTime).getTime())
            && !startTimesMatch(value.startTime, actual)) return false;
      }
      consecutiveDead = 0;
      return true;
    };
  }
  return { captureSelf: () => captureProcess(process.pid), captureProcess, readRef, writeRef, observe, sameRef, watchParent };
}
const liveness = createLiveness();

module.exports = { createLiveness, ...liveness, isProcessAlive, getProcessStartTime, captureProcessIdentity, startTimesMatch, createDeadManSwitch, verifyProcessIdentity };

