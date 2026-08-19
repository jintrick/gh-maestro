'use strict';

// restart-residents.js — 常駐プロセスの停止・再起動・稼働確認を共有する。
//
// restart-residents.js (CLI) と reset-session.js の両方が、常駐を停止したあとに
// 同じ検証済み registry 情報から現行スクリプトを立ち上げるために使う。PID registry
// の生存確認だけでkill対象を決めず、停止直前にも起動時刻の同一性を確認する。
//
// poll-pr.js は poll-reviews.js を子プロセスとして起動するため、両方が登録されて
// いた場合は poll-reviews.js を単独で二重起動しない。msg-poll.js と poll-pr.js は
// stdout が呼び出し元の Monitor へ届く契約を持つため、detached CLI で入れ替えた
// あとは Monitor の張り直しが必要になる。このモジュールはプロセスを再起動する
// ところまでを担当し、Monitor の作成は orchestrator に返す。

const fs = require('fs');
const path = require('path');
const { spawn } = require('../child-process');
const { killProcessTree } = require('../kill-tree');
const {
  findRunningInstances,
  unregisterProcess,
  verifyProcessIdentity,
  isProcessAlive,
  findSessionRootPid,
} = require('../process-lifecycle');

const RESIDENT_SPECS = Object.freeze([
  Object.freeze({ script: 'inbox-supervisor.js', workerName: null, monitorRequired: false }),
  Object.freeze({ script: 'msg-poll.js', workerName: null, monitorRequired: true }),
  Object.freeze({ script: 'poll-pr.js', workerName: null, monitorRequired: true }),
  Object.freeze({ script: 'poll-reviews.js', workerName: null, monitorRequired: true }),
]);

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_WAIT_MS = 100;

function isValidPid(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

function createResidentRestartHooks() {
  return {
    findRunningInstances,
    unregisterProcess,
    verifyProcessIdentity,
    isProcessAlive,
    findSessionRootPid,
    killProcessTree,
    spawn,
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

function specForScript(script) {
  return RESIDENT_SPECS.find((spec) => spec.script === script) || null;
}

function isResidentEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const spec = specForScript(entry.script);
  if (!spec) return false;
  return (entry.workerName ?? null) === spec.workerName;
}

/**
 * 常駐4種のうち、現在生存している registry エントリを捕捉する。
 * 読み取りに失敗した場合は空集合にせず例外を伝播し、kill/startを行わない。
 *
 * @param {string} workspace
 * @param {object} [hooks]
 * @returns {object[]}
 */
function captureResidentEntries(workspace, hooks = createResidentRestartHooks()) {
  return hooks.findRunningInstances(workspace, { failOnReadError: true })
    .filter(isResidentEntry);
}

function parseSessionPid(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--session-pid') continue;
    const pid = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * registryの引数から --session-pid だけを差し替える。引数はshellへ渡さず、
 * child_process.spawnへ配列のまま渡すため、値にシェル構文が含まれていても解釈されない。
 */
function replaceSessionPid(args, sessionPid) {
  const source = Array.isArray(args) ? args : [];
  const result = [];
  let hadSessionPid = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '--session-pid') {
      hadSessionPid = true;
      i += 1;
      continue;
    }
    result.push(source[i]);
  }
  if (isValidPid(sessionPid)) {
    result.push('--session-pid', String(sessionPid));
  } else if (hadSessionPid) {
    // 呼び出し元が無効なPIDを渡した場合に、古い値を黙って残さない。
    throw new Error('--session-pid が正の整数ではありません');
  }
  return result;
}

function fallbackArgs(spec, workspace) {
  if (spec.script === 'inbox-supervisor.js') return ['--workspace', workspace];
  if (spec.script === 'msg-poll.js') return ['orchestrator', '--workspace', workspace];
  return null;
}

/**
 * 起動対象の引数を構築する。
 *
 * 既存プロセスの --session-pid は、restart CLIの親チェーンではなく、対象プロセスが
 * 実際に使っていた値を引き継ぐ。使い捨てCLIから Monitor のPIDを再解決すると、
 * msg-poll等がCLIを起動したシェルに紐づき、Monitorの寿命契約を壊すためである。
 * inbox-supervisorだけは旧引数が無い場合に限り、既存のCLI自動起動と同じ親チェーン
 * フォールバックを使う。
 */
function buildRestartArgs(spec, entry, workspace, hooks, opts = {}) {
  const recordedArgs = Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string')
    ? entry.args
    : null;
  const sourceArgs = recordedArgs && recordedArgs.length > 0
    ? recordedArgs
    : fallbackArgs(spec, workspace);

  if (!sourceArgs) {
    throw new Error(`${spec.script} のregistry引数が無いため、Monitorから起動してください`);
  }

  const recordedSessionPid = parseSessionPid(sourceArgs);
  let sessionPid = recordedSessionPid;
  let sessionPidSource = recordedSessionPid ? 'registry-args' : null;

  if (!sessionPid && spec.script === 'inbox-supervisor.js') {
    const fallback = opts.fallbackSessionPid ?? hooks.findSessionRootPid();
    if (!isValidPid(fallback)) {
      throw new Error('inbox-supervisor.js の --session-pid を親セッションから解決できません');
    }
    sessionPid = fallback;
    sessionPidSource = 'restart-cli-parent-chain';
  }

  if (!sessionPid) {
    throw new Error(`${spec.script} の --session-pid をregistryから引き継げないため、Monitorから起動してください`);
  }
  if (!hooks.isProcessAlive(sessionPid)) {
    throw new Error(`${spec.script} の記録済みセッションPID ${sessionPid} が生存していません。Monitorから起動してください`);
  }

  return {
    args: replaceSessionPid(sourceArgs, sessionPid),
    sessionPid,
    sessionPidSource,
  };
}

function residentLogPath(workspace, script) {
  const dir = path.join(workspace, '.gh-maestro', 'resident-restart-logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${script}-${Date.now()}-${process.pid}.log`);
}

function formatCommand(scriptPath, args) {
  return [process.execPath, scriptPath, ...args].map((part) => JSON.stringify(String(part))).join(' ');
}

function waitUntilStopped(pid, hooks, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!hooks.isProcessAlive(pid)) return true;
    hooks.sleep(waitMs);
  }
  return !hooks.isProcessAlive(pid);
}

function stopEntry(workspace, entry, hooks, opts = {}) {
  if (!isValidPid(entry.pid)) return { ok: false, error: 'registryのPIDが正の整数ではありません' };

  if (hooks.isProcessAlive(entry.pid)) {
    const identity = hooks.verifyProcessIdentity(entry.pid, entry);
    if (!identity.match) {
      return { ok: false, error: `PID ${entry.pid} の同一性を確認できません: ${identity.reason || 'mismatch'}` };
    }
    try {
      hooks.killProcessTree(entry.pid);
    } catch (e) {
      return { ok: false, error: `PID ${entry.pid} の停止に失敗しました: ${e.message}` };
    }
    if (!waitUntilStopped(entry.pid, hooks, opts)) {
      return { ok: false, error: `PID ${entry.pid} が停止確認の期限内に終了しませんでした` };
    }
  }

  try {
    hooks.unregisterProcess(workspace, entry.pid);
  } catch (e) {
    return { ok: false, error: `PID ${entry.pid} のregistry解除に失敗しました: ${e.message}` };
  }
  return { ok: true };
}

function ensureCapturedEntriesStopped(entries, hooks, opts = {}) {
  for (const entry of entries) {
    if (!hooks.isProcessAlive(entry.pid)) continue;
    const identity = hooks.verifyProcessIdentity(entry.pid, entry);
    if (identity.match) {
      return `旧PID ${entry.pid} がまだ生存しているため、重複起動を防止して中断しました`;
    }
    return `旧PID ${entry.pid} の停止後確認に失敗しました: ${identity.reason || 'mismatch'}`;
  }
  return null;
}

function findReplacementEntry(workspace, spec, oldPids, hooks) {
  const entries = hooks.findRunningInstances(workspace, {
    script: spec.script,
    workerName: spec.workerName,
    failOnReadError: true,
  });
  return entries.find((entry) => !oldPids.has(entry.pid)) || null;
}

function startEntry(workspace, scriptsPath, spec, entry, oldPids, hooks, opts = {}) {
  let built;
  try {
    built = buildRestartArgs(spec, entry, workspace, hooks, opts);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const scriptPath = path.join(scriptsPath, spec.script);
  let logFd;
  let child;
  try {
    const logPath = residentLogPath(workspace, spec.script);
    logFd = fs.openSync(logPath, 'a');
    child = hooks.spawn(process.execPath, [scriptPath, ...built.args], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    if (!child || !isValidPid(child.pid)) {
      return { ok: false, error: `${spec.script} のspawn結果から有効なPIDを取得できません` };
    }
    if (typeof child.unref === 'function') child.unref();
  } catch (e) {
    return { ok: false, error: `${spec.script} の起動に失敗しました: ${e.message}` };
  } finally {
    if (logFd !== undefined) {
      try { fs.closeSync(logFd); } catch {}
    }
  }

  let replacement;
  try {
    replacement = findReplacementEntry(workspace, spec, oldPids, hooks);
  } catch (e) {
    return { ok: false, error: `${spec.script} の起動後registry確認に失敗しました: ${e.message}` };
  }

  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  for (let attempt = 0; !replacement && attempt < maxAttempts; attempt++) {
    if (!hooks.isProcessAlive(child.pid)) break;
    hooks.sleep(waitMs);
    try {
      replacement = findReplacementEntry(workspace, spec, oldPids, hooks);
    } catch (e) {
      return { ok: false, error: `${spec.script} の起動後registry確認に失敗しました: ${e.message}` };
    }
  }

  if (!replacement) {
    return { ok: false, error: `${spec.script} の新しいregistry登録を確認できませんでした（起動ログを確認してください）` };
  }
  return {
    ok: true,
    pid: replacement.pid,
    args: built.args,
    sessionPid: built.sessionPid,
    sessionPidSource: built.sessionPidSource,
    command: formatCommand(scriptPath, built.args),
  };
}

function monitorCommandForEntry(scriptsPath, spec, entry) {
  const args = Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === 'string') : [];
  return formatCommand(path.join(scriptsPath, spec.script), args);
}

/**
 * 常駐4種を入れ替える。
 *
 * @param {string} workspace
 * @param {object} opts
 * @param {string} opts.scriptsPath 現行スクリプトのディレクトリ
 * @param {object[]} [opts.preCapturedEntries] reset-sessionが停止前に捕捉したエントリ
 * @param {boolean} [opts.skipStop=false] preCapturedEntriesが既に停止済みの場合にtrue
 * @param {object} [opts.hooks] テスト用依存注入
 * @returns {{results: object[], errors: string[], entries: object[]}}
 */
function restartResidents(workspace, opts = {}) {
  if (!opts.scriptsPath) throw new Error('restartResidents: scriptsPath が必要です');
  const hooks = opts.hooks || createResidentRestartHooks();
  let entries;
  try {
    entries = opts.preCapturedEntries
      ? opts.preCapturedEntries.filter(isResidentEntry)
      : captureResidentEntries(workspace, hooks);
  } catch (e) {
    const reason = `常駐registryの読み取りに失敗したため入れ替えを中断しました: ${e.message}`;
    return {
      entries: [],
      errors: [reason],
      results: RESIDENT_SPECS.map((spec) => ({ script: spec.script, status: 'failed', reason })),
    };
  }

  const entriesByScript = new Map();
  for (const entry of entries) {
    if (!entriesByScript.has(entry.script)) entriesByScript.set(entry.script, []);
    entriesByScript.get(entry.script).push(entry);
  }
  const results = RESIDENT_SPECS.map((spec) => {
    const oldEntries = entriesByScript.get(spec.script) || [];
    return {
      script: spec.script,
      status: oldEntries.length === 0 ? 'not-running' : 'pending',
      oldPids: oldEntries.map((entry) => entry.pid),
      monitorRequired: false,
    };
  });
  const resultByScript = new Map(results.map((result) => [result.script, result]));
  const errors = [];

  if (opts.skipStop) {
    const stopError = ensureCapturedEntriesStopped(entries, hooks, opts);
    if (stopError) {
      for (const result of results) {
        if (result.status === 'pending') {
          result.status = 'failed';
          result.reason = stopError;
        }
      }
      errors.push(stopError);
      return { entries, results, errors };
    }
  } else {
    for (const entry of entries) {
      const stopResult = stopEntry(workspace, entry, hooks, opts);
      if (!stopResult.ok) {
        const result = resultByScript.get(entry.script);
        result.status = 'failed';
        result.reason = stopResult.error;
        errors.push(`${entry.script}: ${stopResult.error}`);
      }
    }
  }

  const pollPrWasRestarted = () => resultByScript.get('poll-pr.js').status === 'replaced';
  for (const spec of RESIDENT_SPECS) {
    const result = resultByScript.get(spec.script);
    const oldEntries = entriesByScript.get(spec.script) || [];
    if (result.status !== 'pending') continue;

    // poll-pr が新しい poll-reviews を子として起動するため、旧構成に両方が
    // 登録されていた場合は、poll-reviewsを単独spawnして二重監視を作らない。
    if (spec.script === 'poll-reviews.js' && entriesByScript.has('poll-pr.js') && pollPrWasRestarted()) {
      result.status = 'delegated';
      result.verified = true;
      result.monitorRequired = true;
      result.monitorScript = 'poll-pr.js';
      result.reason = 'poll-pr.js が現行コードで子プロセスとして起動する';
      result.command = monitorCommandForEntry(opts.scriptsPath, specForScript('poll-pr.js'), entriesByScript.get('poll-pr.js')[0]);
      continue;
    }

    const oldPids = new Set(entries.flatMap((entry) => entry.script === spec.script ? [entry.pid] : []));
    const started = startEntry(workspace, opts.scriptsPath, spec, oldEntries[0], oldPids, hooks, opts);
    if (!started.ok) {
      result.status = 'failed';
      result.reason = started.error;
      errors.push(`${spec.script}: ${started.error}`);
      continue;
    }
    result.status = 'replaced';
    result.verified = true;
    result.newPid = started.pid;
    result.monitorRequired = spec.monitorRequired;
    result.monitorScript = spec.script;
    result.command = started.command;
    result.sessionPid = started.sessionPid;
    result.sessionPidSource = started.sessionPidSource;
  }

  return { entries, results, errors };
}

function formatResidentResult(result) {
  const fields = [`RESIDENT`, `script=${result.script}`, `status=${result.status}`];
  if (result.oldPids && result.oldPids.length) fields.push(`oldPid=${result.oldPids.join(',')}`);
  if (result.newPid) fields.push(`newPid=${result.newPid}`);
  if (result.verified !== undefined) fields.push(`verified=${result.verified}`);
  if (result.reason) fields.push(`reason=${JSON.stringify(result.reason)}`);
  return fields.join(' ');
}

module.exports = {
  RESIDENT_SPECS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WAIT_MS,
  createResidentRestartHooks,
  captureResidentEntries,
  parseSessionPid,
  replaceSessionPid,
  buildRestartArgs,
  isResidentEntry,
  restartResidents,
  formatCommand,
  formatResidentResult,
  monitorCommandForEntry,
};
