'use strict';
// stop-worker-process.js — ワーカープロセスの同一性確認と停止を行う共通ヘルパー
//
// 提供する機能:
//   - workers.json から workerName のエントリを取得
//   - プロセスの生存確認
//   - プロセスツリーの終了（killProcessTree）
//   - レガシー WezTerm pane / notifier の終了
//   - 関連する PID registry の sweep
//
// stop-worker.js / remove-worker.js のプロセス停止段で共通利用する。

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('./child-process');
const { killPane, getAlivePaneIds } = require('./pane-launch');
const { normalizeWorkerEntry } = require('./worker-entry');
const { killProcessTree } = require('./kill-tree');
const { sweepRegistry } = require('../process-lifecycle');
const processLiveness = require('./process-liveness');
const { deriveRoleFromSkill } = require('./worker-factory');
const { recordCycleEvent } = require('./cycle-metrics');
const { readWorkersRaw } = require('./workers-registry');
const { atomicWriteJson } = require('./atomic-write');

const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stopLegacyPane(paneId, options = {}) {
  const killPaneFn = options.killPaneFn || killPane;
  const result = killPaneFn(String(paneId));
  if (!result || result.ok !== true) {
    throw new Error(`レガシーpane ${paneId} のkill-pane 失敗: ${(result && result.stderr) || '(empty)'}`);
  }
  (options.sleepFn || defaultSleep)(options.sleepMs ?? 500);
  return result;
}

function normalizeLegacyPaneId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function validLegacyPaneId(value) {
  return normalizeLegacyPaneId(value) !== null;
}

/**
 * ワーカーのプロセスを同一性確認の上で停止する。
 *
 * @param {string} workspace ワークスペースのルートパス
 * @param {string} workerName 停止対象のワーカー名
 * @param {object} [opts]
 * @param {boolean} [opts.isRemoveMode=false] ログのコマンド名をremove-workerとして表示する
 * @param {(msg: string) => void} [opts.logWarn=console.warn] 警告・情報ログ出力関数
 * @param {(ms: number) => void} [opts.sleepFn=defaultSleep] pane解放待ちにも使うスリープ関数
 * @param {number} [opts.stopTimeoutMs=5000] プロセス停止確認の上限ミリ秒
 * @param {number} [opts.pollIntervalMs=50] プロセス停止確認の間隔ミリ秒
 * @param {number} [opts.sleepMs=500] レガシーpaneの解放待ちミリ秒
 * @param {Function} [opts.killProcessTreeFn] プロセス停止関数（テスト用）
 * @param {object} [opts.liveness] 生存確認モジュール（テスト用）
 * @param {object} [opts._injectedWorkers] テスト用 workers オブジェクト注入
 * @returns {{ success: boolean, stoppedPid: number|null, workerEntry: object }}
 */
function stopWorkerProcess(workspace, workerName, opts = {}) {
  const isRemoveMode = opts.isRemoveMode ?? false;
  const logWarn = opts.logWarn ?? console.warn;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const paneWaitMs = opts.sleepMs ?? 500;
  const recordCycleEventFn = opts.recordCycleEventFn || recordCycleEvent;
  const killProcessTreeFn = opts.killProcessTreeFn || killProcessTree;
  const liveness = opts.liveness || processLiveness;

  const killAndConfirm = (pid) => {
    const killResult = killProcessTreeFn(pid, {
      timeoutMs: stopTimeoutMs,
      pollIntervalMs,
      sleepFn,
    });
    return killResult;
  };

  let workers = opts._injectedWorkers;
  if (!workers) {
    const workersJson = path.resolve(workspace, '.gh-maestro', 'workers.json');
    if (!fs.existsSync(workersJson)) {
      throw new Error(`workers.json が見つかりません: ${workersJson}`);
    }
    try {
      workers = JSON.parse(fs.readFileSync(workersJson, 'utf8'));
    } catch (e) {
      throw new Error(`workers.json のパースに失敗しました: ${e.message}`);
    }
  }

  if (!workers || typeof workers !== 'object' || !(workerName in workers)) {
    throw new Error(`ワーカー "${workerName}" のエントリが workers.json に見つかりません`);
  }

  const rawWorkerEntry = workers[workerName];
  const workerEntry = normalizeWorkerEntry(rawWorkerEntry);
  const hasRawPid = rawWorkerEntry && typeof rawWorkerEntry === 'object' && !Array.isArray(rawWorkerEntry)
    && rawWorkerEntry.pid !== undefined && rawWorkerEntry.pid !== null;
  if (hasRawPid && !workerEntry.pid) {
    throw new Error(`ワーカー "${workerName}" のPID記録が不正です`);
  }
  if (!workerEntry.pid && rawWorkerEntry && typeof rawWorkerEntry === 'object'
      && !Array.isArray(rawWorkerEntry) && rawWorkerEntry.startTime != null && rawWorkerEntry.startTime !== '') {
    throw new Error(`ワーカー "${workerName}" の起動時刻記録に対応するPIDがありません`);
  }
  let stoppedPid = null;

  // Legacy notifier records contain no identity, so they cannot authorize a kill.
  const rawNotifierPid = rawWorkerEntry && typeof rawWorkerEntry === 'object' && !Array.isArray(rawWorkerEntry)
    ? rawWorkerEntry.notifierPid
    : undefined;
  if (rawNotifierPid !== undefined && rawNotifierPid !== null && rawNotifierPid !== '') {
    if ((typeof rawNotifierPid !== 'number' && typeof rawNotifierPid !== 'string')
        || !Number.isInteger(Number(rawNotifierPid)) || Number(rawNotifierPid) <= 0) {
      throw new Error(`レガシー notifier (pid ${rawNotifierPid}) のPID記録が不正です`);
    }
    const notifierPid = Number(rawNotifierPid);
    const notifierStartTime = rawWorkerEntry.notifierStartTime ?? null;
    const state = liveness.observe(liveness.readRef({ pid: notifierPid, startTime: notifierStartTime }));
    if (state === 'unknown') {
      throw new Error(`レガシー notifier (pid ${notifierPid}) の生死を判定できません`);
    }
    if (state === 'alive') killAndConfirm(notifierPid);
  }

  if (workerEntry.pid) {
    const state = liveness.observe(liveness.readRef(rawWorkerEntry));
    if (state === 'unknown') {
      throw new Error(`ワーカー "${workerName}" の生死を判定できません (PID ${workerEntry.pid})`);
    } else if (state === 'alive') {
      killAndConfirm(workerEntry.pid);
      stoppedPid = workerEntry.pid;
      const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
      logWarn(`${prefix}: ワーカープロセス (pid ${workerEntry.pid}) を終了しました`);
    } else {
      const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
      logWarn(`${prefix}: ワーカープロセス (pid ${workerEntry.pid}) は既に停止しています`);
    }
  }

  // ── 後方互換: 移行前セッションが残した WezTerm ペインを kill ──────────────
  if (workerEntry.paneId) {
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    try {
      stopLegacyPane(workerEntry.paneId, { sleepFn, sleepMs: paneWaitMs });
      logWarn(`${prefix}: レガシーpane ${workerEntry.paneId} を終了しました`);
    } catch (error) {
      logWarn(`${prefix}: レガシーpane ${workerEntry.paneId} のkill-pane 失敗: ${error.message}`);
    }
  }

  if (!workerEntry.pid && !workerEntry.paneId) {
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    logWarn(`${prefix}: ワーカー "${workerName}" に終了対象のプロセスが記録されていません`);
  }

  if (stoppedPid) {
    const issueMatch = /^issue-(\d+)-/.exec(workerName);
    const issue = workerEntry.issue || (issueMatch && issueMatch[1]);
    if (issue) {
      try {
        recordCycleEventFn(workspace, issue, 'worker-stopped', {
          workerName,
          role: workerEntry.skill ? deriveRoleFromSkill(workerEntry.skill) : undefined,
          skill: workerEntry.skill,
          agentId: workerEntry.agentId,
          pid: stoppedPid,
          startTime: workerEntry.startTime,
          abnormal: true,
        });
      } catch { /* best-effort */ }
    }
  }

  // ── PID registry sweep: ワーカーの登録PIDを同一性確認の上で kill ─────
  {
    const sweepResults = sweepRegistry(workspace, {
      match: (entry) => entry.workerName === workerName,
    });
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    if (sweepResults.killed.length > 0) {
      logWarn(`${prefix}: PID registry: ${sweepResults.killed.length} 件のプロセスを終了しました`);
      for (const k of sweepResults.killed) {
        logWarn(`${prefix}:   pid=${k.pid} script=${k.script || '-'}`);
      }
    }
    if (sweepResults.cleaned.length > 0) {
      logWarn(`${prefix}: PID registry: ${sweepResults.cleaned.length} 件のstaleエントリを掃除しました`);
    }
    for (const e of sweepResults.errors) {
      logWarn(`${prefix}: PID registry error: ${e}`);
    }
  }

  return {
    success: true,
    stoppedPid,
    workerEntry,
  };
}

/**
 * workers.jsonに残る旧paneIdだけを整理する。ワーカー本体のPIDやworktreeには触れない。
 * paneの存在を確認できない場合は、IDを再利用した無関係なpaneをkillしないため中断する。
 * @param {string} workspace
 * @param {object} [options]
 */
function cleanupLegacyWorkerPanes(workspace, options = {}) {
  const workersPath = path.resolve(workspace, '.gh-maestro', 'workers.json');
  const readWorkersFn = options.readWorkersFn || ((target) => {
    let stat;
    try {
      stat = fs.lstatSync(path.resolve(target, '.gh-maestro', 'workers.json'));
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('workers.json が通常ファイルではありません');
    }
    return readWorkersRaw(target);
  });
  const workers = readWorkersFn(workspace);
  if (workers === null) return { status: 'absent', path: workersPath, field: 'paneId' };
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) {
    throw new Error('workers.json はオブジェクトである必要があります');
  }

  const targets = [];
  for (const [name, rawEntry] of Object.entries(workers)) {
    if (name === 'orchestrator') continue;
    const isObject = rawEntry !== null && typeof rawEntry === 'object' && !Array.isArray(rawEntry);
    const rawPaneId = isObject ? rawEntry.paneId : rawEntry;
    if (rawPaneId === undefined || rawPaneId === null || rawPaneId === '') continue;
    const paneId = normalizeLegacyPaneId(rawPaneId);
    if (paneId === null) {
      throw new Error(`workers.json の ${name}.paneId は非負整数ではありません`);
    }
    targets.push({ name, rawEntry, isObject, paneId });
  }
  if (targets.length === 0) return { status: 'absent', path: workersPath, field: 'paneId' };

  let alivePanes = options.alivePanes;
  if (alivePanes === undefined) alivePanes = (options.getAlivePaneIdsFn || getAlivePaneIds)(options.warnFn || (() => {}));
  if (!(alivePanes instanceof Set)) throw new Error('legacy paneの生存一覧を確認できませんでした');
  const killed = [];
  const skipped = [];
  for (const target of targets) {
    if (alivePanes.has(target.paneId)) {
      stopLegacyPane(target.paneId, {
        killPaneFn: options.killPaneFn,
        sleepFn: options.sleepFn,
        sleepMs: options.sleepMs ?? 0,
      });
      killed.push(target.paneId);
    } else {
      skipped.push(target.paneId);
    }
  }

  const nextWorkers = { ...workers };
  for (const { name, rawEntry, isObject } of targets) {
    nextWorkers[name] = isObject ? { ...rawEntry, paneId: null } : { paneId: null };
  }
  (options.atomicWriteFn || atomicWriteJson)(workersPath, nextWorkers);
  return {
    status: 'removed',
    path: workersPath,
    field: 'paneId',
    workers: targets.map(({ name }) => name),
    killedPanes: killed,
    skippedPanes: skipped,
  };
}

module.exports = {
  stopWorkerProcess,
  cleanupLegacyWorkerPanes,
  stopLegacyPane,
  normalizeLegacyPaneId,
  validLegacyPaneId,
};
