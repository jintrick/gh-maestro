'use strict';
// kill-tree.js
// pid とその子孫プロセスをまとめて終了する。
// Windows は親子関係を辿らない SIGTERM 相当（process.kill）では子孫が孤児化するため
// taskkill /T を使う。Unix は detached spawn によるプロセスグループを前提に
// 負のpidでグループ全体へ送る。

const { spawnSync } = require('./child-process');

const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 50;

const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    return true;
  }
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function processTreePidsWindows(rootPid, spawnSyncFn = spawnSync) {
  const command = [
    `$root = ${rootPid}`,
    '$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
    '$pending = [System.Collections.Generic.Queue[int]]::new()',
    '$seen = [System.Collections.Generic.HashSet[int]]::new()',
    '$pending.Enqueue($root)',
    'while ($pending.Count -gt 0) {',
    '  $current = $pending.Dequeue()',
    '  if (-not $seen.Add($current)) { continue }',
    '  foreach ($item in $processes) {',
    '    if ([int]$item.ParentProcessId -eq $current) { $pending.Enqueue([int]$item.ProcessId) }',
    '  }',
    '}',
    '$seen | ConvertTo-Json -Compress',
  ].join('; ');

  let result;
  try {
    result = spawnSyncFn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
  } catch (error) {
    throw new Error(`Windowsプロセスツリーの列挙に失敗しました: ${error.message}`, { cause: error });
  }

  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status}`;
    throw new Error(`Windowsプロセスツリーの列挙に失敗しました: ${detail}`);
  }

  let parsed;
  try {
    const output = String(result.stdout || '').trim();
    parsed = output ? JSON.parse(output) : [];
  } catch (error) {
    throw new Error(`Windowsプロセスツリーの列挙結果を解析できません: ${error.message}`, { cause: error });
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  const pids = [...new Set(values.map((value) => Number(value)).filter(validPid))];
  if (!pids.includes(rootPid)) pids.unshift(rootPid);
  return pids;
}

/**
 * 指定されたPIDが全て停止するまで、上限付きで確認する。
 *
 * @param {number[]} pids
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.pollIntervalMs=50]
 * @param {(pid:number) => boolean} [options.isProcessAliveFn]
 * @param {(ms:number) => void} [options.sleepFn]
 * @returns {{ok:boolean, alivePids:number[]}}
 */
function waitForPidsToExit(pids, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const isAlive = options.isProcessAliveFn || isProcessAlive;
  const sleep = options.sleepFn || defaultSleep;
  const targets = [...new Set(pids.filter(validPid))];
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const alivePids = targets.filter((pid) => isAlive(pid));
    if (alivePids.length === 0) return { ok: true, alivePids: [] };
    if (Date.now() >= deadline) return { ok: false, alivePids };
    sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * pid とその子孫プロセスを終了し、終了完了を確認してから返す。
 *
 * Windows の taskkill はコマンド自体の終了と、子孫プロセスの終了反映が別のため、
 * taskkill の status だけを成功根拠にしない。kill 前に取得したツリー全体を bounded
 * polling し、親または子孫が残っている場合は例外として成功扱いしない。
 *
 * @param {number} pid
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.pollIntervalMs=50]
 * @param {(ms:number) => void} [options.sleepFn]
 * @param {(pid:number) => boolean} [options.isProcessAliveFn]
 * @param {(cmd:string,args:string[],options:object) => object} [options.spawnSyncFn]
 * @returns {{ok:boolean, pids:number[]}}
 */
function killProcessTree(pid, options = {}) {
  const rootPid = Number(pid);
  if (!validPid(rootPid)) return { ok: true, pids: [] };

  if (process.platform === 'win32') {
    const treePids = processTreePidsWindows(rootPid, options.spawnSyncFn || spawnSync);
    const result = (options.spawnSyncFn || spawnSync)('taskkill', [
      '/F', '/T', '/PID', String(rootPid),
    ], { stdio: 'pipe', encoding: 'utf8' });
    if (!result || result.error || result.status !== 0) {
      const detail = result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status}`;
      throw new Error(`プロセスツリーの終了に失敗しました (pid ${rootPid}): ${detail}`);
    }

    const stopped = waitForPidsToExit(treePids, options);
    if (!stopped.ok) {
      throw new Error(
        `プロセスツリーの停止確認が期限内に完了しませんでした `
        + `(pid ${rootPid}, 残存PID: ${stopped.alivePids.join(',')})`,
      );
    }
    return { ok: true, pids: treePids };
  }

  try { process.kill(-rootPid, 'SIGTERM'); } catch { /* プロセスグループ無し等 */ }
  try { process.kill(rootPid, 'SIGTERM'); } catch { /* 既に終了済み */ }
  return { ok: true, pids: [rootPid] };
}

module.exports = {
  DEFAULT_STOP_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  killProcessTree,
  waitForPidsToExit,
};
