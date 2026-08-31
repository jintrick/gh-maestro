#!/usr/bin/env node
// worker-status.js — ワーカーの稼働状況・連続稼働時間の確認
//
// workers.json の指定エントリまたは全エントリを照会し、
// ワーカーの生死および実起動時刻に基づく連続稼働時間を返す。
// 一覧（list）では横棒グラフ（または --json）を出力し、
// 常駐表示（watch / pane）では画面クリア・WezTermスプリットペインで自動更新する。

'use strict';

const { normalizeWorkerEntry } = require('./shared/worker-entry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { readWorkersRaw } = require('./shared/workers-registry');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { loadStatusPane, removeStatusPane } = require('./shared/status-pane-registry');
const { ensureStatusPane: ensureStatusPaneLib } = require('./shared/ensure-status-pane');
const { resolveSkillAgentMap } = require('./shared/resolve-config');
const { listRunningReviewManagers } = require('./shared/running-review-managers');

const CLI_USAGE = `worker-status.js — ワーカーの稼働状況・連続稼働時間の確認

Usage:
  node worker-status.js status --workspace <path> --worker-name <name>
  node worker-status.js list --workspace <path> [--json]
  node worker-status.js watch --workspace <path> [--interval <sec>]
  node worker-status.js pane --workspace <path> [--interval <sec>] [--direction <dir>] [--percent <pct>]
  node worker-status.js close-pane --workspace <path>

Commands:
  status                 指定ワーカーの生死状態をJSONで照会する
  list                   全ワーカーの稼働状況と連続稼働時間の横棒グラフを表示する
  watch                  横棒グラフを画面クリアしながら定期更新（自動再描画）する
  pane                   WezTermスプリットペインを下部に開き、watchモードを常駐表示する（既存ペインがあれば再利用）
  close-pane             開いているWezTerm監視ペインを終了する

Options:
  --workspace <path>     ワークスペースパス（必須）
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
    横棒グラフ、または --json 指定時は [{"workerName":...,"pid":...,"running":...,"startTime":...,"elapsedSeconds":...}]
  pane:
    STATUS_PANE_LAUNCHED: pane=<paneId>
  close-pane:
    STATUS_PANE_CLOSED: pane=<paneId>

Description:
  workers.json のワーカーを読み取り、プロセスの実起動時刻（process-lifecycle.getProcessStartTime）
  に基づいて連続稼働時間を算出する。一覧モードは最長稼働のワーカーを基準にした相対長で横棒グラフを描く。
  pane サブコマンドは WezTerm の専用ペイン（既定: bottom 15%）を分割作成し、独立して自動更新し続ける。
  既存ペインが生存している場合は新しく作らず既存ペインを再利用する。
  close-pane サブコマンドは記録された監視ペインを終了して記録を削除する。`;

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
    results.push(managerEntry);
  }

  return results;
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

  const maxIssueLen = Math.max(...rows.map(r => r.issueCol.length), 0);
  const maxNameLen = Math.max(...rows.map(r => r.shortName.length), 0);
  const maxAgentLen = Math.max(...rows.map(r => r.agentCol.length), 0);

  const lines = [];
  for (const r of rows) {
    const issuePart = r.issueCol.padEnd(maxIssueLen, ' ');
    const namePart = r.shortName.padEnd(maxNameLen, ' ');
    const agentPart = r.agentCol.padEnd(maxAgentLen, ' ');
    const statusPart = r.statusCol.padEnd(9, ' ');
    const timePart = r.timeCol.padStart(8, ' ');
    const barPart = r.bar ? `${r.bar} ` : '';
    const line = `${issuePart}  ${namePart}  ${agentPart}  ${statusPart}  ${timePart}  ${barPart}${r.pidStr}`.trimEnd();
    lines.push(line);
  }
  return lines;
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
        return entry;
      });
      writeOut(JSON.stringify(jsonEntries, null, 2));
    } else {
      const bars = renderUptimeBars(workers);
      for (const line of bars) writeOut(line);
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

    const timeStr = formatJstTime(_now());
    writeOut(`=== gh-maestro worker status (${timeStr}, interval: ${interval}s) ===`);
    const bars = renderUptimeBars(workers);
    for (const line of bars) writeOut(line);

    return { code: 0, lines: out, errLines: err, isWatch: true, workspace, interval, startTimeCache };
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
      const bars = renderUptimeBars(workers, opts);
      const timeStr = formatJstTime(_now());
      outStream.write('\x1b[2J\x1b[H');
      outStream.write(`=== gh-maestro worker status (${timeStr}, interval: ${interval}s) ===\n`);
      for (const line of bars) {
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
};

if (require.main === module) {
  const result = main();
  for (const line of result.errLines) process.stderr.write(line + '\n');
  if (result.code !== 0) {
    process.exit(result.code);
  }
  if (result.isWatch) {
    runWatchLoop(result.workspace, result.interval, { startTimeCache: result.startTimeCache });
  } else {
    for (const line of result.lines) process.stdout.write(line + '\n');
    process.exit(result.code);
  }
}

