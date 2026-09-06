#!/usr/bin/env node
// worker-status.js — ワーカーの稼働状況・連続稼働時間の確認
//
// workers.json の指定エントリまたは全エントリを照会し、
// ワーカーの生死および実起動時刻に基づく連続稼働時間を返す。
// 一覧（list）ではサイクル行とワーカー行（または --json）を出力し、
// 常駐表示（watch / pane）では画面クリア・WezTermスプリットペインで自動更新する。

'use strict';

const { normalizeWorkerEntry } = require('./shared/worker-entry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { readWorkersRaw } = require('./shared/workers-registry');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { loadStatusPane, saveStatusPane, removeStatusPane } = require('./shared/status-pane-registry');
const { ensureStatusPane: ensureStatusPaneLib } = require('./shared/ensure-status-pane');
const { resolveSkillAgentMap } = require('./shared/resolve-config');
const { listRunningReviewManagers } = require('./shared/running-review-managers');
const { deriveRoleFromSkill } = require('./shared/worker-factory');
const { formatElapsedTime } = require('./shared/worker-report-check');
const {
  INTERVALS,
  readCycleEvents,
  projectCycleMetrics,
} = require('./shared/cycle-metrics');

const CLI_USAGE = `worker-status.js — ワーカーの稼働状況・連続稼働時間の確認

Usage:
  node worker-status.js status --workspace <path> --worker-name <name>
  node worker-status.js list --workspace <path> [--issue <N>] [--json]
  node worker-status.js watch --workspace <path> [--issue <N>] [--interval <sec>]
  node worker-status.js pane --workspace <path> [--issue <N>] [--interval <sec>] [--direction <dir>] [--percent <pct>]
  node worker-status.js close-pane --workspace <path> [--issue <N>]

Commands:
  status                 指定ワーカーの生死状態をJSONで照会する
  list                   6区間のサイクル行とワーカーの稼働状況を表示する
  watch                  サイクル行とワーカー行を画面クリアしながら定期更新する
  pane                   WezTermスプリットペインを下部に開き、watchモードを常駐表示する（既存ペインがあれば再利用）
  close-pane             開いているWezTerm監視ペインを終了する（--issue指定時は対象を検証）

Options:
  --workspace <path>     ワークスペースパス（必須）
  --issue <N>            表示対象Issue（省略時はworkers.jsonから推測）
  --worker-name <name>   照会するワーカー名（status で必須）
  --json                 list で機械可読な JSON 配列を出力する
  --interval <sec>       watch / pane の更新間隔（秒、既定: 3）
  --direction <dir>      pane の分割方向 (bottom|right|top|left、既定: bottom)
  --percent <pct>        pane の画面占有率 (%、既定: 15)
  --help, -h             このヘルプを表示する

Output (stdout):
  status:
    {"workerName":...,"running":true|false,"pid":...}
  list:
    6区間のサイクル行とワーカー行、または --json 指定時は [{"workerName":...,"pid":...,"running":...,"startTime":...,"elapsedSeconds":...}]
  pane:
    STATUS_PANE_LAUNCHED: pane=<paneId>
  close-pane:
    STATUS_PANE_CLOSED: pane=<paneId>

Description:
  workers.json とIssue単位のcycle metricsを読み取り、6区間を1行へ畳んで表示する。
  --json は既存のworkers.json由来の配列契約を維持する。
  pane サブコマンドは WezTerm の専用ペイン（既定: bottom 15%）を分割作成し、独立して自動更新し続ける。
  既存ペインが生存している場合は新しく作らず既存ペインを再利用する。
  close-pane サブコマンドは記録された監視ペインを終了して記録を削除する。
  --issue を指定した場合は、監視ペイン起動時の --issue と一致するときだけ実行する。`;

let _injectedGetProcessStartTime = null;
let _injectedIsWorkerAlive = null;
let _injectedIsProcessAlive = null;
let _injectedVerifyProcessIdentity = null;
let _injectedResolveSkillAgentMap = null;
let _injectedFindRunningInstances = null;
let _injectedNow = null;
let _injectedLaunchInSplitPane = null;
let _injectedIsPaneAlive = null;
let _injectedKillPane = null;
let _injectedSaveStatusPane = null;
let _injectedAcquireStatusPaneLock = null;
let _injectedReleaseStatusPaneLock = null;
let _injectedReadCycleEvents = null;

// Windows の起動時刻取得は PowerShell 子プロセスを起動するため、既定の3秒再描画より
// 長いが、PID再利用を長時間見逃さない間隔にする。watch ループ内だけで使い、他の
// process-lifecycle 呼び出しには影響させない。
const PROCESS_START_TIME_CACHE_MAX_AGE_MS = 6_000;

function _getProcessStartTime(pid) {
  const fn = _injectedGetProcessStartTime ?? require('./process-lifecycle').getProcessStartTime;
  return fn(pid);
}

function _findRunningInstances(workspace, opts) {
  const fn = _injectedFindRunningInstances ?? require('./process-lifecycle').findRunningInstances;
  return fn(workspace, opts);
}

function _isWorkerAlive(entry, opts) {
  const fn = _injectedIsWorkerAlive ?? require('./shared/worker-liveness').isWorkerAlive;
  if (opts === undefined) return fn(entry);
  return fn(entry, opts);
}

function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('./process-lifecycle').isProcessAlive;
  return fn(pid);
}

function _verifyProcessIdentity(pid, identity, opts) {
  const fn = _injectedVerifyProcessIdentity ?? require('./process-lifecycle').verifyProcessIdentity;
  return fn(pid, identity, opts);
}

function _resolveSkillAgentMap(opts) {
  const fn = _injectedResolveSkillAgentMap ?? require('./shared/resolve-config').resolveSkillAgentMap;
  return fn(opts);
}

function _now() {
  const fn = _injectedNow ?? Date.now;
  return fn();
}

function _launchInSplitPane(params) {
  const fn = _injectedLaunchInSplitPane ?? require('./shared/pane-launch').launchInSplitPane;
  return fn(params);
}

function _isPaneAlive(paneId) {
  const fn = _injectedIsPaneAlive ?? require('./shared/pane-launch').isPaneAlive;
  return fn(paneId);
}

function _killPane(paneId) {
  const fn = _injectedKillPane ?? require('./shared/pane-launch').killPane;
  return fn(paneId);
}

function _saveStatusPane(workspace, entry) {
  const fn = _injectedSaveStatusPane ?? require('./shared/status-pane-registry').saveStatusPane;
  return fn(workspace, entry);
}

/**
 * watchプロセス自身のPIDを、ensure-status-paneが作成した記録へ反映する。
 * 起動直後の記録失敗は表示プロセスの責務ではないため、watchの継続を優先する。
 *
 * @param {string} workspace
 * @param {string|number|null|undefined} issue
 */
function recordWatchProcess(workspace, issue) {
  let pane;
  try {
    pane = loadStatusPane(workspace);
  } catch {
    return;
  }
  if (!pane || pane.paneId == null) return;

  const entry = { ...pane, pid: process.pid };
  if (issue !== undefined && issue !== null && String(issue) !== '') {
    entry.issue = String(issue);
  }
  try {
    _saveStatusPane(workspace, entry);
  } catch {
    // WezTerm/表示処理の補助記録が壊れてもwatch自体は継続する。
  }
}

function _acquireStatusPaneLock(workspace) {
  const fn = _injectedAcquireStatusPaneLock
    ?? ((ws) => require('./process-lifecycle').acquireStartupLock(ws, 'status-pane', null));
  return fn(workspace);
}

function _releaseStatusPaneLock(workspace) {
  const fn = _injectedReleaseStatusPaneLock
    ?? ((ws) => require('./process-lifecycle').releaseStartupLock(ws, 'status-pane', null));
  return fn(workspace);
}

function _readCycleEvents(workspace, issue, opts = {}) {
  const fn = _injectedReadCycleEvents || readCycleEvents;
  return fn(workspace, issue, opts);
}

function _ensureStatusPane(params) {
  const deps = {
    loadStatusPaneFn: loadStatusPane,
    saveStatusPaneFn: _saveStatusPane,
    launchInSplitPaneFn: _launchInSplitPane,
    killPaneFn: _killPane,
    acquireLockFn: _acquireStatusPaneLock,
    releaseLockFn: _releaseStatusPaneLock,
    nowFn: _now,
  };
  // 実運用では共有ヘルパー自身の照会（list失敗時は起動せず失敗）が使われる。
  // 既存テストの生存判定注入がある場合だけ、注入値を明示的に優先する。
  if (_injectedIsPaneAlive) deps.isPaneAliveFn = _isPaneAlive;
  return ensureStatusPaneLib(params, deps);
}

/**
 * エポックミリ秒を日本時間 (UTC+9) の HH:mm:ss 形式にフォーマットする。
 *
 * @param {number} [ms]
 * @returns {string}
 */
function formatJstTime(ms = _now()) {
  const d = new Date(ms);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  const s = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * ワーカー名から先頭の "issue-<N>-" プレフィックスを取り除く。
 * パターンに合致しない場合は元の名前をそのまま返す。
 *
 * @param {string} workerName
 * @returns {string}
 */
function stripWorkerNamePrefix(workerName) {
  if (typeof workerName !== 'string') return '';
  return workerName.replace(/^issue-\d+-/, '');
}

/**
 * 秒数を読みやすい時間表記にフォーマットする。
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const remSec = s % 60;
  if (mins < 60) return `${mins}m ${remSec}s`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hours}h ${remMin}m ${remSec}s`;
}

function _startTimesMatch(a, b) {
  return require('./process-lifecycle').startTimesMatch(a, b);
}

function _cachePid(pid) {
  const n = parseInt(pid, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * worker-status の再描画間で共有するプロセス起動時刻キャッシュを作成する。
 *
 * キャッシュは無期限ではない。観測から上限間隔に達したら必ず再観測し、
 * `verifyProcessIdentity` が新しい実起動時刻を登録値と比較できるようにする。
 * `begin()` から次の `begin()` までの1集計内では、同じ PID に対する再取得も抑止する。
 *
 * @param {(pid: number) => (string|null)} getStartTimeFn
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs=PROCESS_START_TIME_CACHE_MAX_AGE_MS] テスト用の上限値
 * @returns {{begin: (now: number) => void, get: (pid: number, expectedStartTime: string|null, now: number) => (string|null), invalidate: (pid: number) => void}}
 */
function createProcessStartTimeCache(getStartTimeFn = _getProcessStartTime, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? PROCESS_START_TIME_CACHE_MAX_AGE_MS;
  const entries = new Map();
  const currentObservation = new Map();
  let currentNow = null;

  function begin(now) {
    currentNow = now;
    currentObservation.clear();
  }

  function get(pid, expectedStartTime, now) {
    const key = _cachePid(pid);
    if (key === null) return null;

    if (currentObservation.has(key)) {
      return currentObservation.get(key).startTime;
    }

    const cached = entries.get(key);
    const age = cached ? now - cached.observedAt : Infinity;
    const fresh = cached
      && Number.isFinite(now)
      && Number.isFinite(cached.observedAt)
      && age >= 0
      && age < maxAgeMs;
    const expectedMatches = !expectedStartTime
      || (cached && (
        cached.startTime
          ? _startTimesMatch(expectedStartTime, cached.startTime)
          : cached.expectedStartTime && _startTimesMatch(expectedStartTime, cached.expectedStartTime)
      ));

    if (fresh && expectedMatches) {
      currentObservation.set(key, cached);
      return cached.startTime;
    }

    const startTime = getStartTimeFn(key) || null;
    const next = { startTime, expectedStartTime: expectedStartTime || null, observedAt: now };
    entries.set(key, next);
    currentObservation.set(key, next);
    return startTime;
  }

  function invalidate(pid) {
    const key = _cachePid(pid);
    if (key === null) return;
    entries.delete(key);
    // 1集計内の別行が同じ PID を持っていても、invalidate 後に2回目の OS 観測を
    // 発生させない。次の begin() でこの番兵を捨て、必要なら再観測する。
    currentObservation.set(key, { startTime: null, observedAt: currentNow });
  }

  return { begin, get, invalidate };
}

/**
 * 全ワーカーの稼働状態と経過秒数を集計する。
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @returns {Array<{workerName: string, pid: number|null, running: boolean, startTime: string|null, elapsedSeconds: number, issue: number|null, agentId: string|null}>}
 */
function collectWorkersStatus(workspace, opts = {}) {
  const now = (opts.nowFn || _now)();
  const getStartTime = opts.getProcessStartTimeFn || _getProcessStartTime;
  const isProcAlive = opts.isProcessAliveFn || _isProcessAlive;
  const verifyProcessIdentity = opts.verifyProcessIdentityFn || _verifyProcessIdentity;
  const startTimeCache = opts.startTimeCache || createProcessStartTimeCache(getStartTime);
  const observedStartTimes = new Map();
  startTimeCache.begin(now);

  const isAlive = opts.isWorkerAliveFn || ((rawEntry) => {
    const entry = normalizeWorkerEntry(rawEntry);
    if (!entry.startTime) return _isWorkerAlive(rawEntry);
    return _isWorkerAlive(rawEntry, {
      getProcessStartTimeFn: (pid) => {
        const actualStartTime = startTimeCache.get(pid, entry.startTime, now);
        observedStartTimes.set(_cachePid(pid), actualStartTime);
        return actualStartTime;
      },
    });
  });

  // Review Manager 用の agentId を 1 回だけ解決（PRごとのループ内でファイル読み込みを繰り返さない）
  let reviewerAgentId = null;
  try {
    const resolveMapFn = opts.resolveSkillAgentMapFn || _resolveSkillAgentMap;
    const skillMap = resolveMapFn({ workspace });
    if (skillMap && typeof skillMap['gh-maestro-reviewer'] === 'string') {
      reviewerAgentId = skillMap['gh-maestro-reviewer'];
    }
  } catch {
    reviewerAgentId = null;
  }

  const rawWorkers = readWorkersRaw(workspace);
  const results = [];
  if (rawWorkers) {
    for (const [workerName, rawEntry] of Object.entries(rawWorkers)) {
      if (workerName === 'orchestrator') continue;
      const entry = normalizeWorkerEntry(rawEntry);
      const running = isAlive(rawEntry);
      if (!running && entry.pid) {
        // 起動時刻の観測失敗（null）は同一性確認を安全側で停止扱いにするが、
        // TTL 内は null 自体を観測済み値として保持し、毎描画の再取得を避ける。
        // 非null の不一致や PID 消滅はキャッシュを破棄して次回に再観測する。
        const observedStartTime = observedStartTimes.get(_cachePid(entry.pid));
        if (observedStartTime !== null) startTimeCache.invalidate(entry.pid);
      }
      let startTime = null;
      let elapsedSeconds = 0;

      if (running && entry.pid) {
        startTime = startTimeCache.get(entry.pid, entry.startTime, now) || entry.startTime || null;
        if (startTime) {
          const startMs = new Date(startTime).getTime();
          if (!Number.isNaN(startMs)) {
            elapsedSeconds = Math.max(0, Math.floor((now - startMs) / 1000));
          }
        }
      }

      results.push({
        workerName,
        pid: entry.pid,
        running,
        startTime,
        elapsedSeconds,
        issue: entry.issue,
        agentId: entry.agentId,
        skill: entry.skill,
        role: entry.skill ? deriveRoleFromSkill(entry.skill) : null,
        durationKnown: Boolean(running && startTime),
      });
    }
  }

  // 稼働中の Review Manager を収集（破損ファイル等は tolerant にスキップ）
  const isManagerProcessAlive = (pid) => {
    const alive = isProcAlive(pid);
    if (!alive) startTimeCache.invalidate(pid);
    return alive;
  };
  const runningManagers = listRunningReviewManagers(workspace, {
    isProcessAliveFn: isManagerProcessAlive,
    verifyProcessIdentityFn: verifyProcessIdentity,
    // 通常ワーカーと同じ startTime キャッシュを共有する。キャッシュされた値は
    // helper の verifyProcessIdentity に actualStartTime として渡されるため、
    // Review Manager もPID再利用を検出しつつ、#407の再描画間隔を維持できる。
    getProcessStartTimeFn: (pid, expectedStartTime) => (
      startTimeCache.get(pid, expectedStartTime || null, now) || null
    ),
    onError: 'skip',
    cleanupStale: false,
  });

  const findInstancesFn = opts.findRunningInstancesFn || _findRunningInstances;
  let runningReviewJobs = [];
  let reviewJobsUnavailable = false;
  try {
    runningReviewJobs = findInstancesFn(workspace, {
      script: 'review-job',
      isProcessAliveFn: isManagerProcessAlive,
      verifyProcessIdentityFn: verifyProcessIdentity,
      getProcessStartTimeFn: (pid, expectedStartTime) => (
        startTimeCache.get(pid, expectedStartTime || null, now) || null
      ),
      allowSelf: true,
    });
  } catch {
    runningReviewJobs = [];
    reviewJobsUnavailable = true;
  }

  for (const manager of runningManagers) {
    const startTime = manager.startTime || null;
    let elapsedSeconds = 0;
    if (startTime) {
      const startMs = new Date(startTime).getTime();
      if (!Number.isNaN(startMs)) {
        elapsedSeconds = Math.max(0, Math.floor((now - startMs) / 1000));
      }
    }

    const prNum = Number(manager.pr);
    const jobsForManager = runningReviewJobs.filter(j => (
      j.pr === prNum || String(j.pr) === String(manager.pr)
    ));
    const jobEntries = jobsForManager.map(job => {
      const jobStartTime = job.startTime || null;
      let jobElapsedSeconds = 0;
      if (jobStartTime) {
        const startMs = new Date(jobStartTime).getTime();
        if (!Number.isNaN(startMs)) {
          jobElapsedSeconds = Math.max(0, Math.floor((now - startMs) / 1000));
        }
      }
      return {
        jobId: job.jobId || 'unknown',
        aspect: job.aspect || '-',
        leafIds: job.leafIds || job.leaf_ids || [],
        pid: job.pid,
        running: true,
        startTime: jobStartTime,
        elapsedSeconds: jobElapsedSeconds,
        agentId: job.agentId || reviewerAgentId,
      };
    });

    const managerEntry = {
      workerName: `review-manager-pr-${manager.pr}`,
      pid: manager.pid,
      running: true,
      startTime,
      elapsedSeconds,
      issue: null,
      pr: prNum,
      agentId: reviewerAgentId,
    };
    if (jobEntries.length > 0) {
      managerEntry.jobs = jobEntries;
    }
    if (reviewJobsUnavailable) managerEntry.jobsError = true;
    results.push(managerEntry);
  }

  return results;
}

/**
 * 既存の一覧描画で使っていた列幅計算を、監視ペインのワーカー行でも共有する。
 * 行の意味や表示内容は呼び出し側が決め、ここでは最大幅とpadだけを担当する。
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
function alignStatusRows(rows) {
  const maxIssueLen = Math.max(...rows.map(r => String(r.issueCol ?? '').length), 0);
  const maxNameLen = Math.max(...rows.map(r => String(r.shortName ?? '').length), 0);
  const maxAgentLen = Math.max(...rows.map(r => String(r.agentCol ?? '').length), 0);

  return rows.map((row) => ({
    ...row,
    issuePart: String(row.issueCol ?? '').padEnd(maxIssueLen, ' '),
    namePart: String(row.shortName ?? '').padEnd(maxNameLen, ' '),
    agentPart: String(row.agentCol ?? '').padEnd(maxAgentLen, ' '),
    statusPart: String(row.statusCol ?? '').padEnd(9, ' '),
    timePart: String(row.timeCol ?? '').padStart(8, ' '),
  }));
}

/**
 * ワーカー一覧から横棒グラフのテキスト行を生成する。
 *
 * @param {Array<{workerName: string, pid: number|null, running: boolean, startTime: string|null, elapsedSeconds: number, issue?: number|null, agentId?: string|null}>} workers
 * @param {object} [opts]
 * @param {number} [opts.maxBarWidth=30]
 * @returns {string[]}
 */
function renderUptimeBars(workers, opts = {}) {
  if (opts.mode === 'interval') {
    return [renderCycleLine(workers, opts)];
  }
  if (!workers || workers.length === 0) {
    return ['No workers registered.'];
  }

  const maxBarWidth = opts.maxBarWidth ?? 30;
  const allEntriesForMax = [];
  for (const w of workers) {
    allEntriesForMax.push(w);
    if (w.jobs && Array.isArray(w.jobs)) {
      for (const j of w.jobs) allEntriesForMax.push(j);
    }
  }
  const maxElapsed = Math.max(0, ...allEntriesForMax.map(w => w.elapsedSeconds));

  const rows = [];
  for (const w of workers) {
    let issueCol = '-';
    if (w.pr != null) {
      issueCol = `PR#${w.pr}`;
    } else if (w.issue != null) {
      issueCol = `#${w.issue}`;
    }
    const shortName = stripWorkerNamePrefix(w.workerName);
    const agentCol = w.agentId ? String(w.agentId) : '-';
    const statusCol = w.running ? '[running]' : '[stopped]';
    const timeCol = w.running ? formatDuration(w.elapsedSeconds) : '-';
    let bar = '';
    if (w.running && maxElapsed > 0 && w.elapsedSeconds > 0) {
      const barLen = Math.max(1, Math.round((w.elapsedSeconds / maxElapsed) * maxBarWidth));
      bar = '█'.repeat(barLen);
    }
    const pidStr = w.pid ? `(pid: ${w.pid})` : '';

    rows.push({
      issueCol,
      shortName,
      agentCol,
      statusCol,
      timeCol,
      bar,
      pidStr,
    });

    if (w.jobs && Array.isArray(w.jobs)) {
      for (const j of w.jobs) {
        const childShortName = `  └─ ${j.jobId} (${j.aspect})`;
        const childAgentCol = j.agentId ? String(j.agentId) : '-';
        const childStatusCol = j.running ? '[running]' : '[stopped]';
        const childTimeCol = j.running ? formatDuration(j.elapsedSeconds) : '-';
        let childBar = '';
        if (j.running && maxElapsed > 0 && j.elapsedSeconds > 0) {
          const barLen = Math.max(1, Math.round((j.elapsedSeconds / maxElapsed) * maxBarWidth));
          childBar = '█'.repeat(barLen);
        }
        const childPidStr = j.pid ? `(pid: ${j.pid})` : '';

        rows.push({
          issueCol: '',
          shortName: childShortName,
          agentCol: childAgentCol,
          statusCol: childStatusCol,
          timeCol: childTimeCol,
          bar: childBar,
          pidStr: childPidStr,
        });
      }
    }
  }

  const lines = [];
  for (const r of alignStatusRows(rows)) {
    const barPart = r.bar ? `${r.bar} ` : '';
    const line = `${r.issuePart}  ${r.namePart}  ${r.agentPart}  ${r.statusPart}  ${r.timePart}  ${barPart}${r.pidStr}`.trimEnd();
    lines.push(line);
  }
  return lines;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(text) {
  return Array.from(stripAnsi(text)).length;
}

function colorizeText(text, code, enabled) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function formatIntervalSeconds(seconds) {
  if (seconds == null) return '未記録';
  // formatElapsedTime is intentionally used as the single elapsed-time formatter for
  // cycle intervals. Its public API takes two instants, so use an epoch pair here.
  return formatElapsedTime(0, Math.max(0, Number(seconds)) * 1000);
}

function intervalBarLengths(intervals, budget) {
  const recorded = intervals
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.recorded && Number(item.seconds) >= 0);
  if (recorded.length === 0 || budget < recorded.length) return null;

  const lengths = new Map(recorded.map(({ index }) => [index, 1]));
  let remaining = budget - recorded.length;
  const weights = recorded.map(({ item }) => Math.max(0, Number(item.seconds)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);

  if (remaining > 0 && weightTotal > 0) {
    const fractions = recorded.map(({ index }, position) => {
      const exact = remaining * (weights[position] / weightTotal);
      return { index, whole: Math.floor(exact), fraction: exact - Math.floor(exact) };
    });
    for (const part of fractions) lengths.set(part.index, lengths.get(part.index) + part.whole);
    let assigned = fractions.reduce((sum, part) => sum + part.whole, 0);
    fractions.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let i = assigned; i < remaining; i++) {
      const part = fractions[(i - assigned) % fractions.length];
      lengths.set(part.index, lengths.get(part.index) + 1);
    }
  } else if (remaining > 0) {
    for (let i = 0; i < remaining; i++) {
      const part = recorded[i % recorded.length];
      lengths.set(part.index, lengths.get(part.index) + 1);
    }
  }
  return lengths;
}

/**
 * 6区間を1行へ畳む。既存の renderUptimeBars 入口から呼び出すことで、
 * 区間の棒だけをここで描画し、ワーカー行へ棒を持ち込まない。
 */
function renderCycleLine(projection, opts = {}) {
  const intervals = Array.isArray(projection) ? projection : [];
  const issue = opts.issue == null ? '?' : String(opts.issue);
  const totalSeconds = opts.totalSeconds == null
    ? intervals.reduce((sum, item) => item.recorded ? sum + Number(item.seconds || 0) : sum, 0)
    : Number(opts.totalSeconds);
  const prefix = `#${issue} 計${formatDuration(totalSeconds)}`;
  const colorize = Boolean(opts.colorize);
  const maxLineWidth = Number.isFinite(Number(opts.maxLineWidth))
    ? Math.max(1, Math.floor(Number(opts.maxLineWidth)))
    : 120;
  const specs = INTERVALS.map((spec, index) => ({
    ...spec,
    ...(intervals[index] || {}),
    label: (intervals[index] && intervals[index].label) || spec.label,
    recorded: intervals[index]
      ? (intervals[index].recorded !== undefined
        ? Boolean(intervals[index].recorded)
        : intervals[index].seconds != null)
      : false,
  }));
  const palette = [31, 36, 33, 34, 35, 32];
  const plainToken = (item) => item.recorded
    ? `${item.label} ${formatIntervalSeconds(item.seconds)}`
    : `${item.label} ┈ 未記録`;
  const separators = '   ';
  const baseTokens = specs.map(plainToken);
  const baseLine = `${prefix}   ${baseTokens.join(separators)}`;

  let line = baseLine;
  if (visibleLength(baseLine) <= maxLineWidth) {
    const recordedCount = specs.filter(item => item.recorded).length;
    const free = maxLineWidth - visibleLength(baseLine);
    // The plain token already contains one separator between its label and
    // duration. Adding a bar introduces one additional separator per recorded
    // interval; reserve those cells before allocating the normalized bar
    // lengths so the complete line, rather than just the bar cells, fits the
    // terminal width.
    const barPadding = recordedCount;
    const lengths = intervalBarLengths(specs, free - barPadding);
    if (lengths) {
      const tokens = specs.map((item, index) => {
        const length = lengths.get(index);
        const token = length
          ? `${item.label} ${'█'.repeat(length)} ${formatIntervalSeconds(item.seconds)}`
          : plainToken(item);
        return colorizeText(token, palette[index], colorize);
      });
      line = `${prefix}   ${tokens.join(separators)}`;
    } else {
      line = `${prefix}   ${specs.map((item, index) => (
        colorizeText(plainToken(item), palette[index], colorize)
      )).join(separators)}`;
    }
  }

  if (visibleLength(line) > maxLineWidth) {
    const plain = stripAnsi(line);
    const width = Math.max(1, maxLineWidth);
    line = width === 1 ? '…' : `${Array.from(plain).slice(0, width - 1).join('')}…`;
  }
  return line;
}

function roleFromWorker(worker) {
  if (worker && worker.role) {
    const role = String(worker.role);
    if (role.startsWith('gh-maestro-')) {
      try { return deriveRoleFromSkill(role); } catch { /* keep the recorded role */ }
    }
    return role;
  }
  if (worker && worker.skill) {
    try { return deriveRoleFromSkill(worker.skill); } catch { /* fall through */ }
  }
  const name = stripWorkerNamePrefix(worker && worker.workerName);
  const match = /^(review-manager|senior-coder|diagnostician|explorer|architect|coder|base)(?:-|$)/.exec(name);
  return match ? match[1] : (name || 'worker');
}

function workerDurationKnown(worker) {
  if (!worker) return false;
  if (worker.durationKnown !== undefined) return Boolean(worker.durationKnown);
  return worker.elapsedSeconds != null
    && Boolean(worker.running ? worker.startTime : (worker.stopTime || worker.startTime));
}

function workerDisplayKey(worker) {
  if (worker && worker.workerName) return `worker:${worker.workerName}`;
  const role = worker && worker.role || '';
  const pr = worker && worker.pr != null ? String(worker.pr) : '';
  const pid = worker && worker.pid != null ? String(worker.pid) : '';
  return [
    'anonymous',
    role,
    pr,
    pid,
  ].join('|');
}

function workerRunMatches(left, right) {
  if (!left || !right) return false;
  if (left.workerName !== right.workerName) return false;
  if (left.pid != null && right.pid != null && Number(left.pid) !== Number(right.pid)) return false;
  if (left.startTime && right.startTime && left.startTime !== right.startTime) return false;
  return true;
}

function workerRunOrder(worker, fallback) {
  const value = Date.parse(worker && (worker.startTime || worker.stopTime || ''));
  return Number.isNaN(value) ? fallback : value;
}

function mergeCycleWorkers(projectedWorkers, currentWorkers) {
  const groups = new Map();
  const addToGroup = (worker, source, order) => {
    const key = workerDisplayKey(worker);
    let group = groups.get(key);
    if (!group) {
      group = { projected: [], current: null };
      groups.set(key, group);
    }
    if (source === 'projected') {
      group.projected.push({ worker: { ...worker }, order });
    } else {
      group.current = { ...worker };
    }
  };

  for (const [index, worker] of (Array.isArray(projectedWorkers) ? projectedWorkers : []).entries()) {
    addToGroup(worker, 'projected', index);
  }

  for (const current of Array.isArray(currentWorkers) ? currentWorkers : []) {
    if (!groups.has(workerDisplayKey(current))) addToGroup(current, 'current', Number.MAX_SAFE_INTEGER);
    else groups.get(workerDisplayKey(current)).current = { ...current };
  }

  return [...groups.values()].map((group) => {
    const runs = group.projected
      .slice()
      .sort((left, right) => (
        workerRunOrder(left.worker, left.order) - workerRunOrder(right.worker, right.order)
        || left.order - right.order
      ));
    const current = group.current;
    let currentRun = null;

    if (current && runs.length > 0) {
      const exact = runs.find(item => (
        item.worker.workerName === current.workerName
        && item.worker.pid != null && current.pid != null
        && Number(item.worker.pid) === Number(current.pid)
        && item.worker.startTime && current.startTime
        && item.worker.startTime === current.startTime
      ));
      currentRun = exact || runs.slice().reverse().find(item => workerRunMatches(item.worker, current)) || null;
    }

    // A current registry entry with a new PID/startTime is a run whose start
    // event has not been projected yet. Include it during that hand-off window.
    if (current && !currentRun) {
      const currentOrder = runs.length > 0 ? runs[runs.length - 1].order + 1 : 0;
      currentRun = { worker: { ...current }, order: currentOrder, currentOnly: true };
      runs.push(currentRun);
    }

    const knownDurations = [];
    let totalElapsed = 0;
    for (const run of runs) {
      let elapsed = run.worker.elapsedSeconds;
      let durationKnown = workerDurationKnown(run.worker);

      if (run === currentRun && current) {
        if (workerDurationKnown(current)) {
          elapsed = current.elapsedSeconds;
          durationKnown = true;
        } else if (!current.running && !run.worker.stopTime) {
          // The registry proves that this PID is gone, but without a stop event
          // there is no trustworthy end timestamp for the latest run.
          elapsed = null;
          durationKnown = false;
        }
      }

      if (durationKnown && Number.isFinite(Number(elapsed))) {
        totalElapsed += Number(elapsed);
        knownDurations.push(true);
      } else {
        knownDurations.push(false);
      }
      run.elapsed = elapsed;
      run.durationKnown = durationKnown;
    }

    const latest = runs[runs.length - 1] || (current ? { worker: current } : { worker: {} });
    const latestWorker = latest.worker || {};
    const latestIsCurrent = current && currentRun === latest;
    const durationKnown = runs.length > 0 && knownDurations.every(Boolean);
    const merged = {
      workerName: current?.workerName || latestWorker.workerName || '',
      role: current?.role || latestWorker.role || roleFromWorker(latestWorker),
      runNumber: runs.length,
      agentId: current?.agentId || latestWorker.agentId || null,
      skill: current?.skill || latestWorker.skill || null,
      pid: current && current.pid != null ? current.pid : (latestWorker.pid ?? null),
      issue: current?.issue ?? latestWorker.issue ?? null,
      pr: current?.pr ?? latestWorker.pr ?? null,
      startTime: latestIsCurrent && current.startTime ? current.startTime : (latestWorker.startTime || null),
      stopTime: latestWorker.stopTime || null,
      running: current ? Boolean(current.running) : false,
      abnormal: Boolean(current?.abnormal || runs.some(run => run.worker.abnormal)),
      elapsedSeconds: durationKnown ? totalElapsed : null,
      durationKnown,
    };
    if (Array.isArray(current?.jobs)) merged.jobs = current.jobs.map(job => ({ ...job }));
    if (current?.jobsError) merged.jobsError = true;
    return merged;
  });
}

function renderWorkerRows(workers, opts = {}) {
  const input = Array.isArray(workers) ? workers : [];
  const sorted = input.slice().sort((a, b) => {
    if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
    if (Boolean(a.abnormal) !== Boolean(b.abnormal)) return a.abnormal ? -1 : 1;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''));
  });
  const prepared = sorted.map(worker => ({ worker, role: roleFromWorker(worker) }));
  const maxRows = Math.max(0, Number(opts.maxRows ?? 4));
  const visible = prepared.slice(0, maxRows);
  const hidden = Math.max(0, prepared.length - visible.length);
  const colorize = Boolean(opts.colorize);
  const entries = [];
  for (const [visibleIndex, { worker, role }] of visible.entries()) {
    const dot = worker.abnormal
      ? colorizeText('●', 31, colorize)
      : worker.running
        ? colorizeText('●', 32, colorize)
        : colorizeText('○', 90, colorize);
    const runNumber = Number(worker.runNumber);
    const runSuffix = Number.isInteger(runNumber) && runNumber > 1 ? ` x${runNumber}` : '';
    const agent = worker.agentId ? String(worker.agentId) : '-';
    const elapsed = worker.elapsedSeconds == null || !workerDurationKnown(worker)
      ? '-'
      : formatDuration(worker.elapsedSeconds);
    const pid = worker.pid == null ? '-' : String(worker.pid);
    const row = {
      issueCol: '',
      shortName: `${role}${runSuffix}`,
      agentCol: agent,
      statusCol: '',
      timeCol: elapsed,
      bar: '',
      pidStr: `(pid: ${pid})`,
      prefix: `${dot} `,
      hiddenSuffix: hidden > 0 && visibleIndex === visible.length - 1 ? ` +${hidden}件` : '',
    };
    entries.push({ type: 'row', row });

    if (worker.jobsError) entries.push({ type: 'plain', line: '  └─ review jobs unavailable (取得失敗)' });
    for (const job of Array.isArray(worker.jobs) ? worker.jobs : []) {
      const jobName = `  └─ ${job.jobId || 'unknown'} (${job.aspect || '-'})`;
      const jobAgent = job.agentId ? String(job.agentId) : '-';
      const jobElapsed = job.elapsedSeconds == null || !workerDurationKnown(job)
        ? '-'
        : formatDuration(job.elapsedSeconds);
      const jobPid = job.pid == null ? '-' : String(job.pid);
      entries.push({
        type: 'row',
        row: {
          issueCol: '',
          shortName: jobName,
          agentCol: jobAgent,
          statusCol: '',
          timeCol: jobElapsed,
          bar: '',
          pidStr: `(pid: ${jobPid})`,
          prefix: '',
          hiddenSuffix: '',
        },
      });
    }
  }
  if (hidden > 0) {
    if (entries.length === 0) entries.push({ type: 'plain', line: `+${hidden}件` });
  }

  const alignedRows = alignStatusRows(entries.filter(entry => entry.type === 'row').map(entry => entry.row));
  let alignedIndex = 0;
  const lines = [];
  for (const entry of entries) {
    if (entry.type === 'plain') {
      lines.push(entry.line);
      continue;
    }
    const row = alignedRows[alignedIndex++];
    lines.push(`${row.prefix}${row.namePart} [${row.agentPart}] ${row.timePart} ${row.pidStr}${row.hiddenSuffix}`.trimEnd());
  }
  return lines;
}

function inferIssue(workers) {
  for (const worker of Array.isArray(workers) ? workers : []) {
    const value = Number(worker.issue);
    if (Number.isInteger(value) && value > 0) return String(value);
  }
  return null;
}

function renderSnapshotLines(workspace, issue, opts = {}) {
  const currentWorkers = opts.currentWorkers || collectWorkersStatus(workspace, opts.collectOpts || opts);
  const explicitIssue = issue != null && String(issue) !== '';
  const selectedIssue = explicitIssue ? String(issue) : inferIssue(currentWorkers);
  const events = selectedIssue
    ? (opts.cycleEvents || _readCycleEvents(workspace, selectedIssue))
    : [];

  const projected = projectCycleMetrics(events, {
    issue: selectedIssue || null,
    now: opts.now == null ? _now() : opts.now,
  });
  const workers = mergeCycleWorkers(projected.workers, currentWorkers.filter(worker => (
    selectedIssue == null || worker.issue == null || String(worker.issue) === selectedIssue
  )));
  const cycleLine = renderUptimeBars(projected.intervals, {
    mode: 'interval',
    issue: selectedIssue || '?',
    totalSeconds: projected.totalSeconds,
    maxLineWidth: opts.maxLineWidth,
    colorize: opts.colorize,
  })[0];
  return [cycleLine, ...renderWorkerRows(workers, opts)];
}

const MIN_INTERVAL_SEC = 1;
const MAX_INTERVAL_SEC = 3600;
const DEFAULT_INTERVAL_SEC = 3;

/**
 * --interval の値を検証・数値化する。
 *
 * @param {string|undefined} rawValue
 * @returns {number}
 * @throws {Error} 1〜3600の数値でない場合
 */
function parseInterval(rawValue) {
  if (rawValue === undefined) return DEFAULT_INTERVAL_SEC;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_SEC || n > MAX_INTERVAL_SEC) {
    throw new Error(`--interval には ${MIN_INTERVAL_SEC}〜${MAX_INTERVAL_SEC} の数値を指定してください: ${rawValue}`);
  }
  return n;
}

/**
 * worker-status CLIを実行する。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @returns {{code: number, lines: string[], errLines: string[], isWatch?: boolean, workspace?: string, interval?: number, paneId?: string}}
 */
function main(argv = process.argv.slice(2)) {
  const out = [];
  const err = [];
  const writeOut = (line) => out.push(line);
  const writeErr = (line) => err.push(line);

  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: {
        '--workspace': {},
        '--issue': {},
        '--worker-name': {},
        '--interval': {},
        '--direction': {},
        '--percent': {},
      },
      booleans: ['--help', '-h', '--json'],
      positionals: { min: 1, max: 1 },
    }));
  } catch (parseError) {
    if (parseError.name !== 'ArgsValidationError') throw parseError;
    if (parseError.helpRequested) {
      writeOut(CLI_USAGE);
      return { code: 0, lines: out, errLines: [] };
    }
    for (const e of parseError.errors) writeErr(`worker-status: ${e.message}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(CLI_USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const sub = rest[0];
  const validSubs = new Set(['status', 'list', 'watch', 'pane', 'close-pane']);
  if (!validSubs.has(sub)) {
    writeErr(`worker-status: 未知のサブコマンドです: ${sub}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (!values['--workspace']) {
    writeErr('worker-status: --workspace が必要です');
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('worker-status: ワークスペースを解決できません');
    return { code: 1, lines: out, errLines: err };
  }

  const issueArg = values['--issue'];
  if (issueArg !== undefined && !/^[1-9]\d*$/.test(String(issueArg))) {
    writeErr(`worker-status: --issue は正の整数で指定してください: ${issueArg}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (sub === 'status') {
    if (!values['--worker-name']) {
      writeErr('worker-status: status には --worker-name が必要です');
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    const workerName = values['--worker-name'];
    let rawWorkers;
    try {
      rawWorkers = readWorkersRaw(workspace);
    } catch (e) {
      writeErr(`worker-status: status の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    const rawEntry = rawWorkers && Object.prototype.hasOwnProperty.call(rawWorkers, workerName)
      ? rawWorkers[workerName]
      : undefined;
    const entry = normalizeWorkerEntry(rawEntry);

    writeOut(JSON.stringify({
      workerName,
      running: _isWorkerAlive(rawEntry),
      pid: entry.pid,
    }));
    return { code: 0, lines: out, errLines: err };
  }

  // list / watch / pane / close-pane では --worker-name は使用不可
  if (values['--worker-name']) {
    writeErr(`worker-status: --worker-name は ${sub} では使用できません`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (sub === 'list') {
    let workers;
    try {
      workers = collectWorkersStatus(workspace);
    } catch (e) {
      writeErr(`worker-status: list の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    if (values['--json']) {
      const jsonEntries = workers.map(w => {
        const entry = {
          workerName: w.workerName,
          pid: w.pid,
          running: w.running,
          startTime: w.startTime,
          elapsedSeconds: w.elapsedSeconds,
        };
        if (w.jobs) {
          entry.jobs = w.jobs.map(j => ({
            jobId: j.jobId,
            aspect: j.aspect,
            leafIds: j.leafIds,
            pid: j.pid,
            running: j.running,
            startTime: j.startTime,
            elapsedSeconds: j.elapsedSeconds,
            agentId: j.agentId,
          }));
        }
        if (w.jobsError) entry.jobsError = true;
        return entry;
      });
      writeOut(JSON.stringify(jsonEntries, null, 2));
    } else {
      const lines = renderSnapshotLines(workspace, issueArg, {
        currentWorkers: workers,
        now: _now(),
        maxLineWidth: process.stdout.columns,
        colorize: Boolean(process.stdout.isTTY && process.env.NO_COLOR !== '1'),
      });
      for (const line of lines) writeOut(line);
    }
    return { code: 0, lines: out, errLines: err };
  }

  if (sub === 'watch') {
    let interval;
    try {
      interval = parseInterval(values['--interval']);
    } catch (e) {
      writeErr(`worker-status: ${e.message}`);
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    const startTimeCache = createProcessStartTimeCache(_getProcessStartTime);
    let workers;
    try {
      workers = collectWorkersStatus(workspace, { startTimeCache });
    } catch (e) {
      writeErr(`worker-status: watch の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    const lines = renderSnapshotLines(workspace, issueArg, {
      currentWorkers: workers,
      now: _now(),
      maxLineWidth: process.stdout.columns,
      colorize: Boolean(process.stdout.isTTY && process.env.NO_COLOR !== '1'),
    });
    for (const line of lines) writeOut(line);

    return { code: 0, lines: out, errLines: err, isWatch: true, workspace, interval, issue: issueArg, startTimeCache };
  }

  if (sub === 'pane') {
    let interval;
    try {
      interval = parseInterval(values['--interval']);
    } catch (e) {
      writeErr(`worker-status: ${e.message}`);
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    const direction = values['--direction'] || 'bottom';
    const validDirs = new Set(['bottom', 'right', 'top', 'left']);
    if (!validDirs.has(direction)) {
      writeErr(`worker-status: --direction は bottom|right|top|left のいずれかを指定してください: ${direction}`);
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    let percent = 15;
    if (values['--percent'] !== undefined) {
      const p = Number(values['--percent']);
      if (!Number.isFinite(p) || p <= 0 || p >= 100) {
        writeErr(`worker-status: --percent は 1〜99 の数値を指定してください: ${values['--percent']}`);
        writeErr(CLI_USAGE);
        return { code: 1, lines: out, errLines: err };
      }
      percent = p;
    }

    const paneResult = _ensureStatusPane({
      workspace,
      scriptsPath: __dirname,
      issue: issueArg,
      interval,
      direction,
      percent,
    });
    if (!paneResult.ok) {
      if (paneResult.stage === 'save') {
        writeErr(`worker-status: 監視ペイン状態の保存に失敗しました: ${paneResult.error}`);
      } else if (paneResult.stage === 'launch') {
        writeErr(`worker-status: pane の分割起動に失敗しました: ${paneResult.error}`);
      } else {
        writeErr(`worker-status: 監視ペインの保証に失敗しました: ${paneResult.error}`);
      }
      return { code: 1, lines: out, errLines: err };
    }

    writeOut(`STATUS_PANE_LAUNCHED: pane=${paneResult.paneId}`);
    return {
      code: 0,
      lines: out,
      errLines: err,
      paneId: paneResult.paneId,
      reused: paneResult.reused,
    };
  }

  if (sub === 'close-pane') {
    const existingPane = loadStatusPane(workspace);
    if (!existingPane || !existingPane.paneId) {
      writeOut('STATUS_PANE_NOT_FOUND');
      return { code: 0, lines: out, errLines: err };
    }

    if (issueArg !== undefined && String(existingPane.issue) !== String(issueArg)) {
      writeOut('STATUS_PANE_NOT_FOUND');
      return { code: 0, lines: out, errLines: err };
    }

    const paneId = existingPane.paneId;
    if (_isPaneAlive(paneId)) {
      const killResult = _killPane(paneId);
      if (!killResult.ok) {
        writeErr(`worker-status: 監視ペイン ${paneId} の終了に失敗しました: ${killResult.stderr}`);
        return { code: 1, lines: out, errLines: err };
      }
    }

    removeStatusPane(workspace);
    writeOut(`STATUS_PANE_CLOSED: pane=${paneId}`);
    return { code: 0, lines: out, errLines: err, paneId };
  }

  return { code: 0, lines: out, errLines: err };
}

function runWatchLoop(workspace, interval, opts = {}) {
  const intervalMs = interval * 1000;
  const outStream = opts.stdout || process.stdout;
  const errStream = opts.stderr || process.stderr;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const onSignalFn = opts.onSignalFn || ((sig, handler) => process.on(sig, handler));
  const exitFn = opts.exitFn || process.exit;
  const startTimeCache = opts.startTimeCache
    || createProcessStartTimeCache(opts.getProcessStartTimeFn || _getProcessStartTime);
  const collectOpts = { ...opts, startTimeCache };

  const render = () => {
    try {
      const workers = collectWorkersStatus(workspace, collectOpts);
      const lines = renderSnapshotLines(workspace, opts.issue, {
        ...opts,
        currentWorkers: workers,
        collectOpts,
        now: _now(),
        maxLineWidth: opts.maxLineWidth ?? outStream.columns,
        colorize: opts.colorize !== undefined
          ? Boolean(opts.colorize)
          : Boolean(outStream.isTTY && process.env.NO_COLOR !== '1'),
      });
      outStream.write('\x1b[2J\x1b[H');
      for (const line of lines) {
        outStream.write(line + '\n');
      }
    } catch (e) {
      errStream.write(`worker-status: watch 更新エラー: ${e.message}\n`);
    }
  };

  render();
  const timer = setIntervalFn(render, intervalMs);
  const handleSignal = () => {
    clearIntervalFn(timer);
    exitFn(0);
  };
  onSignalFn('SIGINT', handleSignal);
  onSignalFn('SIGTERM', handleSignal);

  return { timer, render, handleSignal, startTimeCache };
}

module.exports = {
  main,
  CLI_USAGE,
  formatJstTime,
  stripWorkerNamePrefix,
  formatDuration,
  collectWorkersStatus,
  renderUptimeBars,
  renderCycleLine,
  renderWorkerRows,
  renderSnapshotLines,
  alignStatusRows,
  recordWatchProcess,
  mergeCycleWorkers,
  parseInterval,
  runWatchLoop,
  createProcessStartTimeCache,
  PROCESS_START_TIME_CACHE_MAX_AGE_MS,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  DEFAULT_INTERVAL_SEC,
  _setGetProcessStartTime: (fn) => { _injectedGetProcessStartTime = fn; },
  _setIsWorkerAlive: (fn) => { _injectedIsWorkerAlive = fn; },
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _injectedVerifyProcessIdentity = fn; },
  _setResolveSkillAgentMap: (fn) => { _injectedResolveSkillAgentMap = fn; },
  _setFindRunningInstances: (fn) => { _injectedFindRunningInstances = fn; },
  _setNow: (fn) => { _injectedNow = fn; },
  _setLaunchInSplitPane: (fn) => { _injectedLaunchInSplitPane = fn; },
  _setIsPaneAlive: (fn) => { _injectedIsPaneAlive = fn; },
  _setKillPane: (fn) => { _injectedKillPane = fn; },
  _setSaveStatusPane: (fn) => { _injectedSaveStatusPane = fn; },
  _setAcquireStatusPaneLock: (fn) => { _injectedAcquireStatusPaneLock = fn; },
  _setReleaseStatusPaneLock: (fn) => { _injectedReleaseStatusPaneLock = fn; },
  _setReadCycleEvents: (fn) => { _injectedReadCycleEvents = fn; },
};

if (require.main === module) {
  const result = main();
  for (const line of result.errLines) process.stderr.write(line + '\n');
  if (result.code !== 0) {
    process.exit(result.code);
  }
  if (result.isWatch) {
    recordWatchProcess(result.workspace, result.issue);
    runWatchLoop(result.workspace, result.interval, {
      issue: result.issue,
      startTimeCache: result.startTimeCache,
    });
  } else {
    for (const line of result.lines) process.stdout.write(line + '\n');
    process.exit(result.code);
  }
}

