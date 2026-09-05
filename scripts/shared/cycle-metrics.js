'use strict';

// Issue単位の開発サイクル記録。表示やスナップショットはこのJSONLを正本として読む。
// ペインやWezTermを記録経路に含めないため、ヘッドレスの決定論的スクリプトから
// best-effortで直接追記する。

const fs = require('fs');
const path = require('path');
const { ARTIFACTS, recordPath } = require('./record-paths');

const SCHEMA_VERSION = 1;
const ISSUE_RE = /^[1-9]\d*$/;

const EVENT_TYPES = Object.freeze(new Set([
  'issue-created',
  'worker-started',
  'worker-stopped',
  'plan-reported',
  'implementation-approved',
  'pr-created',
  'review-completed',
  'merged',
]));

const INTERVALS = Object.freeze([
  Object.freeze({ key: 'preparation', label: '準備', start: 'issue-created', end: 'worker-started' }),
  Object.freeze({ key: 'planning', label: '計画', start: 'worker-started', end: 'plan-reported' }),
  Object.freeze({ key: 'approval', label: '承認', start: 'plan-reported', end: 'implementation-approved' }),
  Object.freeze({ key: 'implementation', label: '実装', start: 'implementation-approved', end: 'pr-created' }),
  Object.freeze({ key: 'review', label: '査読', start: 'pr-created', end: 'review-completed' }),
  Object.freeze({ key: 'integration', label: '統合', start: 'review-completed', end: 'merged' }),
]);

function assertIssue(issue) {
  const value = String(issue);
  if (!ISSUE_RE.test(value)) {
    throw new Error(`invalid issue number: ${JSON.stringify(issue)}`);
  }
  return Number(value);
}

function metricsPath(workspace, issue) {
  return recordPath(workspace, {
    ownerKind: 'issue',
    ownerId: assertIssue(issue),
    artifact: ARTIFACTS.CYCLE_METRICS,
  });
}

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoTimestamp(value, nowFn = Date.now) {
  const ms = timestampMs(value);
  if (ms !== null) return new Date(ms).toISOString();
  const now = timestampMs(nowFn());
  return new Date(now === null ? Date.now() : now).toISOString();
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalPositiveInt(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function optionalNonNegativeInt(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function buildEvent(issue, event, details = {}, nowFn = Date.now) {
  const normalizedIssue = assertIssue(issue);
  if (!EVENT_TYPES.has(event)) {
    throw new Error(`invalid cycle metric event: ${JSON.stringify(event)}`);
  }

  const source = details && typeof details === 'object' ? details : {};
  const result = {
    schemaVersion: SCHEMA_VERSION,
    issue: normalizedIssue,
    event,
    at: isoTimestamp(source.at, nowFn),
  };

  const stringFields = ['workerName', 'role', 'agentId', 'skill', 'startTime'];
  for (const field of stringFields) {
    const value = optionalString(source[field]);
    if (value !== undefined) result[field] = value;
  }
  for (const field of ['pid', 'pr']) {
    const value = optionalPositiveInt(source[field]);
    if (value !== undefined) result[field] = value;
  }
  const exitCode = optionalNonNegativeInt(source.exitCode);
  if (exitCode !== undefined) {
    result.exitCode = exitCode;
  }
  if (typeof source.abnormal === 'boolean') result.abnormal = source.abnormal;
  return result;
}

/**
 * JSONLへ1イベントを同期追記する。記録経路は意図的にbest-effortで、
 * パス検証・ディレクトリ作成・書き込みの失敗を呼び出し元へ投げ返さない。
 *
 * @returns {{ok:boolean,event?:object,path?:string,error?:Error}}
 */
function recordCycleEvent(workspace, issue, event, details = {}, deps = {}) {
  try {
    const nowFn = deps.nowFn || Date.now;
    const entry = buildEvent(issue, event, details, nowFn);
    const filePath = (deps.metricsPathFn || metricsPath)(workspace, entry.issue);
    const mkdirFn = deps.mkdirFn || ((dir) => fs.mkdirSync(dir, { recursive: true }));
    const appendFileFn = deps.appendFileFn || ((file, content) => fs.appendFileSync(file, content, 'utf8'));
    mkdirFn(path.dirname(filePath));
    appendFileFn(filePath, `${JSON.stringify(entry)}\n`);
    return { ok: true, event: entry, path: filePath };
  } catch (error) {
    const warnFn = deps.warnFn;
    if (typeof warnFn === 'function') warnFn(error);
    return { ok: false, error };
  }
}

function parseEventLine(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.schemaVersion !== SCHEMA_VERSION
      || !ISSUE_RE.test(String(value.issue))
      || !EVENT_TYPES.has(value.event)
      || timestampMs(value.at) === null) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * JSONLを読み取る。不正な行は他の記録を隠さないようスキップする。
 * ファイル不在はまだ打刻されていない正常な状態として空配列を返す。
 */
function readCycleEvents(workspace, issue, opts = {}) {
  try {
    const normalizedIssue = assertIssue(issue);
    const filePath = (opts.metricsPathFn || metricsPath)(workspace, issue);
    const readFileFn = opts.readFileFn || ((file) => fs.readFileSync(file, 'utf8'));
    const content = readFileFn(filePath);
    return String(content).split(/\r?\n/).map(parseEventLine).filter(item => (
      item && Number(item.issue) === normalizedIssue
    ));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    if (typeof opts.onError === 'function') opts.onError(error);
    return [];
  }
}

function firstEvent(events, event) {
  return events
    .filter(item => item.event === event)
    .sort((a, b) => timestampMs(a.at) - timestampMs(b.at))[0] || null;
}

function intervalProjection(events) {
  const normalized = Array.isArray(events) ? events.filter(Boolean) : [];
  const intervals = INTERVALS.map(spec => {
    const start = firstEvent(normalized, spec.start);
    const end = firstEvent(normalized, spec.end);
    const startMs = start ? timestampMs(start.at) : null;
    const endMs = end ? timestampMs(end.at) : null;
    const seconds = startMs !== null && endMs !== null && endMs >= startMs
      ? Math.floor((endMs - startMs) / 1000)
      : null;
    return {
      ...spec,
      startAt: start ? start.at : null,
      endAt: end ? end.at : null,
      seconds,
      recorded: seconds !== null,
    };
  });
  const totalSeconds = intervals.reduce(
    (sum, item) => item.seconds === null ? sum : sum + item.seconds,
    0,
  );
  return { intervals, totalSeconds, totalRecorded: intervals.filter(item => item.recorded).length };
}

function samePid(left, right) {
  return left != null && right != null && Number(left) === Number(right);
}

function sameStartTime(left, right) {
  if (!left || !right) return true;
  const a = timestampMs(left);
  const b = timestampMs(right);
  return a !== null && b !== null && a === b;
}

function stopHasIdentity(stop) {
  return Boolean(stop && (stop.pid != null || stop.startTime));
}

function stopMatches(start, stop) {
  if (start.workerName && stop.workerName && start.workerName !== stop.workerName) return false;
  if (start.pid != null && stop.pid != null && !samePid(start.pid, stop.pid)) return false;
  if (start.startTime && stop.startTime && !sameStartTime(start.startTime, stop.startTime)) return false;
  // A stop without PID/startTime is only useful when both sides carry the
  // worker name. An otherwise anonymous stop is not safe to assign to a run.
  if (!stopHasIdentity(stop) && (!start.workerName || !stop.workerName)) return false;
  const startMs = timestampMs(start.startTime || start.at);
  const stopMs = timestampMs(stop.at);
  return startMs !== null && stopMs !== null && stopMs >= startMs;
}

function workerProjection(events, now = Date.now()) {
  const normalized = Array.isArray(events) ? events.filter(Boolean) : [];
  const starts = normalized
    .filter(item => item.event === 'worker-started')
    .sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
  const stops = normalized
    .filter(item => item.event === 'worker-stopped')
    .sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
  const nowMs = timestampMs(now) ?? Date.now();
  const roleCounts = new Map();

  // Assign stops in chronological order. A stop with PID/startTime is matched
  // to its identified run (and repeated identified stops fold into that same
  // run). A legacy stop without those fields uses an explicit LIFO rule: the
  // latest still-unmatched run with the same worker name. This avoids silently
  // stopping the oldest run merely because names are equal.
  const assignedStops = new Map();
  const assignedRuns = new Set();
  const latestStartIndex = (indices) => indices.reduce((latest, index) => {
    if (latest < 0) return index;
    const latestMs = timestampMs(starts[latest].startTime || starts[latest].at);
    const candidateMs = timestampMs(starts[index].startTime || starts[index].at);
    if (candidateMs > latestMs || (candidateMs === latestMs && index > latest)) return index;
    return latest;
  }, -1);

  for (let stopIndex = 0; stopIndex < stops.length; stopIndex++) {
    const stop = stops[stopIndex];
    const candidates = starts
      .map((start, index) => ({ start, index }))
      .filter(({ start }) => stopMatches(start, stop));
    if (candidates.length === 0) continue;

    const assignedCandidates = candidates
      .map(({ index }) => index)
      .filter(index => assignedStops.has(index));
    const unmatchedCandidates = candidates
      .map(({ index }) => index)
      .filter(index => !assignedRuns.has(index));
    const candidatePool = stopHasIdentity(stop) && assignedCandidates.length > 0
      ? assignedCandidates
      : unmatchedCandidates;
    const startIndex = latestStartIndex(candidatePool);
    if (startIndex < 0) continue;

    const stopIndices = assignedStops.get(startIndex) || [];
    stopIndices.push(stopIndex);
    assignedStops.set(startIndex, stopIndices);
    assignedRuns.add(startIndex);
  }

  return starts.map((start, startIndex) => {
    const matchingStopIndices = assignedStops.get(startIndex) || [];
    const stop = matchingStopIndices.length > 0
      ? stops[matchingStopIndices[0]]
      : null;
    const relatedStops = matchingStopIndices.map(index => stops[index]);

    const startedAt = start.startTime || start.at;
    const endedAt = stop ? stop.at : null;
    const startMs = timestampMs(startedAt);
    const endMs = stop ? timestampMs(endedAt) : nowMs;
    const elapsedSeconds = startMs !== null && endMs !== null && endMs >= startMs
      ? Math.floor((endMs - startMs) / 1000)
      : null;
    const role = start.role || start.skill || 'worker';
    const ordinal = (roleCounts.get(role) || 0) + 1;
    roleCounts.set(role, ordinal);
    const abnormal = relatedStops.some(item => item.abnormal === true
      || (item.exitCode != null && Number(item.exitCode) !== 0));

    return {
      workerName: start.workerName || '',
      role,
      runNumber: ordinal,
      agentId: start.agentId || null,
      skill: start.skill || null,
      pid: start.pid || null,
      issue: start.issue,
      pr: start.pr || null,
      startTime: startedAt || null,
      stopTime: endedAt,
      running: !stop,
      abnormal,
      elapsedSeconds,
    };
  });
}

function projectCycleMetrics(events, opts = {}) {
  const issue = opts.issue == null ? null : assertIssue(opts.issue);
  const now = opts.now == null ? Date.now() : opts.now;
  const normalized = Array.isArray(events) ? events.filter(Boolean) : [];
  const interval = intervalProjection(normalized);
  const workers = workerProjection(normalized, now);
  const prEvent = firstEvent(normalized, 'pr-created');
  return {
    issue,
    pr: opts.pr == null ? (prEvent && prEvent.pr ? Number(prEvent.pr) : null) : Number(opts.pr),
    intervals: interval.intervals,
    totalSeconds: interval.totalSeconds,
    totalRecorded: interval.totalRecorded,
    workers,
  };
}

module.exports = {
  SCHEMA_VERSION,
  EVENT_TYPES,
  INTERVALS,
  assertIssue,
  metricsPath,
  timestampMs,
  buildEvent,
  recordCycleEvent,
  parseEventLine,
  readCycleEvents,
  intervalProjection,
  workerProjection,
  projectCycleMetrics,
};
