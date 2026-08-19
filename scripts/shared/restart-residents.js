'use strict';

// restart-residents.js — 常駐プロセスの停止・再起動・稼働確認を共有する。
//
// restart-residents.js (CLI) と reset-session.js の両方が、常駐を停止したあとに
// 同じ検証済み registry 情報から現行スクリプトを立ち上げるために使う。PID registry
// の生存確認だけでkill対象を決めず、停止直前にも起動時刻の同一性を確認する。
//
// poll-pr.js は poll-reviews.js を子プロセスとして起動するため、両方が登録されて
// いた場合は poll-reviews.js を単独で二重起動しない。msg-poll.js と poll-pr.js は
// stdout が呼び出し元の Monitor へ届く契約を持つため、Monitor常駐3種はdetached
// 起動せず、停止後にMonitorから同じ引数で張り直すコマンドを返す。Monitorを持たない
// inbox-supervisorだけはdetachedで直接入れ替える。

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
 * session-pidが引数に無い旧プロセスについては、停止前にそのPIDの親チェーンから
 * 解決した値をエントリへ保持する。
 *
 * @param {string} workspace
 * @param {object} [hooks]
 * @param {object} [opts]
 * @returns {object[]}
 */
function resolveResidentSessionPid(entry, spec, hooks, opts = {}) {
  const argsPid = parseSessionPid(entry.args);
  if (isValidPid(argsPid)) return { pid: argsPid, source: 'registry-args' };

  if (isValidPid(entry.sessionPid)) {
    return { pid: entry.sessionPid, source: 'registry-session-pid' };
  }

  // restart-residents自身の親ではなく、入れ替え対象だった常駐プロセスの
  // 親チェーンを起点に解決する。これなら通常のMonitor起動でargvへ
  // --session-pidが渡されていなくても、元プロセスと同じdead-man's switchの
  // 対象を引き継げる。停止後は親チェーンを辿れないため、capture時に解決する。
  if (isValidPid(entry.pid) && typeof hooks.findSessionRootPid === 'function') {
    try {
      const residentParentPid = hooks.findSessionRootPid(entry.pid);
      if (isValidPid(residentParentPid)) {
        return { pid: residentParentPid, source: 'resident-parent-chain' };
      }
    } catch {}
  }

  // inbox-supervisorの旧registryだけは、対象プロセスの親チェーンも解決できない
  // 場合に限り従来のCLI親チェーンへフォールバックする。Monitor出力を持つ3種は
  // 使い捨てCLIに紐づけると寿命契約を壊すため、ここでは推測起動しない。
  if (spec.script === 'inbox-supervisor.js') {
    const fallback = opts.fallbackSessionPid
      ?? (typeof hooks.findSessionRootPid === 'function' ? hooks.findSessionRootPid() : null);
    if (isValidPid(fallback)) return { pid: fallback, source: 'restart-cli-parent-chain' };
  }
  return null;
}

function prepareResidentEntry(entry, hooks, opts = {}) {
  const spec = specForScript(entry.script);
  if (!spec) return entry;
  if (parseSessionPid(entry.args) || isValidPid(entry.sessionPid) || isValidPid(entry.restartSessionPid)) {
    return entry;
  }
  const resolved = resolveResidentSessionPid(entry, spec, hooks, opts);
  if (!resolved) return entry;
  return {
    ...entry,
    restartSessionPid: resolved.pid,
    restartSessionPidSource: resolved.source,
  };
}

function captureResidentEntries(workspace, hooks = createResidentRestartHooks(), opts = {}) {
  return hooks.findRunningInstances(workspace, { failOnReadError: true })
    .filter(isResidentEntry)
    .map((entry) => prepareResidentEntry(entry, hooks, opts));
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
 * 実際に使っていた値を引き継ぐ。引数に無い場合も、停止前に対象プロセス自身の
 * 親チェーンから解決した値を使う。使い捨てrestart CLIの親チェーンをmsg-poll等へ
 * 渡すことはしない。inbox-supervisorだけは対象の親チェーンも解決できない旧形式に
 * 限り、既存のCLI自動起動と同じ親チェーンをフォールバックに使う。
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

  if (!sessionPid && isValidPid(entry.sessionPid)) {
    sessionPid = entry.sessionPid;
    sessionPidSource = 'registry-session-pid';
  }
  if (!sessionPid && isValidPid(entry.restartSessionPid)) {
    sessionPid = entry.restartSessionPid;
    sessionPidSource = entry.restartSessionPidSource || 'resident-parent-chain';
  }

  if (!sessionPid && spec.script === 'inbox-supervisor.js') {
    const fallback = opts.fallbackSessionPid
      ?? (typeof hooks.findSessionRootPid === 'function' ? hooks.findSessionRootPid() : null);
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

function startEntry(workspace, scriptsPath, spec, entry, oldPids, hooks, opts = {}, prebuilt = null) {
  let built = prebuilt;
  if (!built) {
    try {
      built = buildRestartArgs(spec, entry, workspace, hooks, opts);
    } catch (e) {
      return { ok: false, error: e.message };
    }
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

function monitorCommandForEntry(scriptsPath, spec, entry, hooks = createResidentRestartHooks(), opts = {}) {
  const built = buildRestartArgs(spec, entry, opts.workspace || entry.workspace, hooks, opts);
  return formatCommand(path.join(scriptsPath, spec.script), built.args);
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
 *   Monitor常駐のstatusは `monitor-required` となり、commandsにMonitorで実行する
 *   コマンドを保持する。
 */
function restartResidents(workspace, opts = {}) {
  if (!opts.scriptsPath) throw new Error('restartResidents: scriptsPath が必要です');
  const hooks = opts.hooks || createResidentRestartHooks();
  let entries;
  try {
    entries = opts.preCapturedEntries
      ? opts.preCapturedEntries.filter(isResidentEntry)
      : captureResidentEntries(workspace, hooks, { fallbackSessionPid: opts.fallbackSessionPid });
  } catch (e) {
    const reason = `常駐registryの読み取りに失敗したため入れ替えを中断しました: ${e.message}`;
    return {
      entries: [],
      errors: [reason],
      results: RESIDENT_SPECS.map((spec) => ({ script: spec.script, status: 'failed', reason })),
    };
  }

  entries = entries.map((entry) => prepareResidentEntry(entry, hooks, {
    fallbackSessionPid: opts.fallbackSessionPid,
  }));

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

  // stop前に全対象の再起動引数を構築する。session-pidを解決できない対象を
  // 先に停止すると、再起動もMonitor再接続要求もできず常駐を失うためである。
  const plans = new Map();
  for (const entry of entries) {
    const spec = specForScript(entry.script);
    try {
      const built = buildRestartArgs(spec, entry, workspace, hooks, opts);
      plans.set(entry, {
        ok: true,
        ...built,
        command: formatCommand(path.join(opts.scriptsPath, spec.script), built.args),
      });
    } catch (e) {
      plans.set(entry, { ok: false, error: e.message });
      const result = resultByScript.get(entry.script);
      result.status = 'failed';
      result.reason = e.message;
      errors.push(`${entry.script}: ${e.message}`);
    }
  }

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
      const plan = plans.get(entry);
      if (!plan || !plan.ok) continue;
      const stopResult = stopEntry(workspace, entry, hooks, opts);
      if (!stopResult.ok) {
        const result = resultByScript.get(entry.script);
        result.status = 'failed';
        result.reason = stopResult.error;
        errors.push(`${entry.script}: ${stopResult.error}`);
      }
    }
  }

  const pollPrWasScheduled = () => ['replaced', 'monitor-required'].includes(resultByScript.get('poll-pr.js').status);
  for (const spec of RESIDENT_SPECS) {
    const result = resultByScript.get(spec.script);
    const oldEntries = entriesByScript.get(spec.script) || [];
    if (result.status !== 'pending') continue;

    // poll-pr が新しい poll-reviews を子として起動するため、旧構成に両方が
    // 登録されていた場合は、poll-reviewsを単独spawnして二重監視を作らない。
    const pollPrEntries = entriesByScript.get('poll-pr.js') || [];
    if (spec.script === 'poll-reviews.js'
      && pollPrEntries.length === oldEntries.length
      && pollPrEntries.length > 0
      && pollPrWasScheduled()) {
      result.status = 'delegated';
      result.monitorScript = 'poll-pr.js';
      result.reason = 'poll-pr.js が現行コードで子プロセスとして起動する';
      continue;
    }

    const oldPids = new Set(entries.flatMap((entry) => entry.script === spec.script ? [entry.pid] : []));
    const readyEntries = oldEntries.filter((entry) => plans.get(entry)?.ok);

    if (spec.monitorRequired) {
      const commands = readyEntries.map((entry) => plans.get(entry).command);
      if (commands.length !== oldEntries.length) {
        result.status = 'failed';
        result.reason = result.reason || `${spec.script} のMonitor再接続コマンドを構築できません`;
        continue;
      }
      result.status = 'monitor-required';
      result.monitorRequired = true;
      result.monitorScript = spec.script;
      result.commands = commands;
      result.command = commands[0];
      result.sessionPids = readyEntries.map((entry) => plans.get(entry).sessionPid);
      continue;
    }

    const startedEntries = [];
    const replacementPids = new Set(oldPids);
    for (const entry of readyEntries) {
      const started = startEntry(workspace, opts.scriptsPath, spec, entry, replacementPids, hooks, opts, plans.get(entry));
      if (!started.ok) {
        result.status = 'failed';
        result.reason = started.error;
        errors.push(`${spec.script}: ${started.error}`);
        break;
      }
      startedEntries.push(started);
      replacementPids.add(started.pid);
    }
    if (result.status === 'failed') continue;

    result.status = 'replaced';
    result.verified = true;
    result.newPids = startedEntries.map((started) => started.pid);
    result.newPid = result.newPids.length === 1 ? result.newPids[0] : undefined;
    result.commands = startedEntries.map((started) => started.command);
    result.command = result.commands[0];
    result.sessionPids = startedEntries.map((started) => started.sessionPid);
    result.sessionPidSources = startedEntries.map((started) => started.sessionPidSource);
  }

  return { entries, results, errors };
}

function formatResidentResult(result) {
  const fields = [`RESIDENT`, `script=${result.script}`, `status=${result.status}`];
  if (result.oldPids && result.oldPids.length) fields.push(`oldPid=${result.oldPids.join(',')}`);
  if (result.newPid) fields.push(`newPid=${result.newPid}`);
  if (result.newPids && result.newPids.length > 1) fields.push(`newPid=${result.newPids.join(',')}`);
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
  resolveResidentSessionPid,
};
