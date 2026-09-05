'use strict';

// マージ時のサイクル記録を、リポジトリ共通の metrics Issue へ保存する処理。
// 検索・作成・重複確認・投稿はここへ集約し、poll-pr.js の終了判断とは分離する。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('./child-process');
const { listComments, parseCommentsResponse } = require('./gh-comments');
const { commentIssue } = require('../comment-issue');
const { readCycleEvents, projectCycleMetrics } = require('./cycle-metrics');
const { formatElapsedTime } = require('./worker-report-check');

const METRICS_LABEL = 'gh-maestro-metrics';
const SNAPSHOT_MARKER = '<!-- gh-maestro-cycle-snapshot:v1';
const LOCK_SCRIPT = 'cycle-snapshot';
const LOCK_WORKER = null;

function markerFor(issue, pr) {
  return `${SNAPSHOT_MARKER} issue=${issue} pr=${pr} -->`;
}

function formatSeconds(seconds) {
  return seconds == null
    ? '未記録'
    : formatElapsedTime(0, Math.max(0, Number(seconds)) * 1000);
}

function buildSnapshotBody({ issue, pr, metrics }) {
  const projected = metrics || { intervals: [], workers: [], totalSeconds: 0 };
  const intervals = Array.isArray(projected.intervals) ? projected.intervals : [];
  const intervalLines = intervals.map((item) => (
    `- ${item.label || item.key}: ${formatSeconds(item.seconds)}`
  ));
  const workers = Array.isArray(projected.workers) ? projected.workers : [];
  const workerLines = workers.map((worker) => {
    const state = worker.abnormal ? 'abnormal' : worker.running ? 'running' : 'stopped';
    const role = worker.role || worker.skill || 'worker';
    const agent = worker.agentId || '-';
    const pid = worker.pid == null ? '-' : worker.pid;
    return `- ${role}${worker.runNumber > 1 ? ` #${worker.runNumber}` : ''} [${agent}] ${formatSeconds(worker.elapsedSeconds)} (pid: ${pid}) ${state}`;
  });

  return [
    markerFor(issue, pr),
    `#${issue} PR #${pr} サイクルスナップショット`,
    `合計: ${formatSeconds(projected.totalSeconds)}`,
    '',
    '区間:',
    ...(intervalLines.length > 0 ? intervalLines : ['- 未記録']),
    '',
    'ワーカー:',
    ...(workerLines.length > 0 ? workerLines : ['- 未記録']),
  ].join('\n');
}

function parseIssueNumber(output) {
  const text = String(output || '').trim();
  const direct = /^([1-9]\d*)$/.exec(text);
  if (direct) return direct[1];
  const url = /\/issues\/([1-9]\d*)(?:\D|$)/.exec(text);
  return url ? url[1] : null;
}

function defaultListMetricsIssues({ repo, workspace }) {
  return spawnSync('gh', [
    'issue', 'list', '--repo', repo,
    '--label', METRICS_LABEL, '--state', 'open',
    '--json', 'number', '-q', '.[0].number',
  ], { cwd: workspace, encoding: 'utf8' });
}

function defaultCreateMetricsIssue({ repo, workspace }) {
  // --label が必要な常設ストックIssueのため、pending-list.md と同じ意図的な例外。
  return spawnSync('gh', [
    'issue', 'create', '--repo', repo,
    '--title', 'gh-maestro cycle metrics',
    '--body', 'gh-maestro がマージ済み開発サイクルの計測スナップショットを保存するIssueです。',
    '--label', METRICS_LABEL,
  ], { cwd: workspace, encoding: 'utf8' });
}

function defaultPostComment({ issue, repo, workspace, body }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-cycle-snapshot-'));
  const bodyFile = path.join(tempRoot, 'body.md');
  try {
    fs.writeFileSync(bodyFile, body, 'utf8');
    return commentIssue({ issue, repo, workspace, bodyFile });
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function defaultAcquireLock(workspace) {
  return require('../process-lifecycle').acquireStartupLock(workspace, LOCK_SCRIPT, LOCK_WORKER);
}

function defaultReleaseLock(workspace) {
  return require('../process-lifecycle').releaseStartupLock(workspace, LOCK_SCRIPT, LOCK_WORKER);
}

function normalizeCommandResult(result) {
  if (!result || result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

/**
 * マージ時スナップショットを1回投稿する。GitHub操作を含めてbest-effortで失敗を返し、
 * 呼び出し元の本来の終了処理を止めない。
 */
function postCycleSnapshot({ issue, pr, repo, workspace, metrics = null }, deps = {}) {
  const issueNumber = String(issue);
  const prNumber = String(pr);
  const listMetricsIssuesFn = deps.listMetricsIssuesFn || defaultListMetricsIssues;
  const createMetricsIssueFn = deps.createMetricsIssueFn || defaultCreateMetricsIssue;
  const listCommentsFn = deps.listCommentsFn || listComments;
  const postCommentFn = deps.postCommentFn || defaultPostComment;
  const parseCommentsFn = deps.parseCommentsFn || parseCommentsResponse;
  const readEventsFn = deps.readEventsFn || readCycleEvents;
  const projectMetricsFn = deps.projectMetricsFn || projectCycleMetrics;
  const acquireLockFn = deps.acquireLockFn || defaultAcquireLock;
  const releaseLockFn = deps.releaseLockFn || defaultReleaseLock;
  const warnFn = deps.warnFn || (() => {});

  let locked = false;
  try {
    locked = Boolean(acquireLockFn(workspace));
    if (!locked) return { ok: false, error: 'cycle snapshot lock was not acquired' };

    const projected = metrics || projectMetricsFn(readEventsFn(workspace, issueNumber), {
      issue: issueNumber,
      pr: prNumber,
      now: deps.nowFn ? deps.nowFn() : Date.now(),
    });
    const body = buildSnapshotBody({ issue: issueNumber, pr: prNumber, metrics: projected });
    const marker = markerFor(issueNumber, prNumber);

    const listResult = listMetricsIssuesFn({ repo, workspace, label: METRICS_LABEL });
    const listOutput = normalizeCommandResult(listResult);
    if (listOutput === null) {
      return { ok: false, error: `metrics Issue search failed: ${(listResult && listResult.stderr) || '(empty)'}` };
    }

    let metricsIssue = parseIssueNumber(listOutput);
    if (!metricsIssue) {
      const createResult = createMetricsIssueFn({
        repo,
        workspace,
        label: METRICS_LABEL,
        title: 'gh-maestro cycle metrics',
        body: 'gh-maestro がマージ済み開発サイクルの計測スナップショットを保存するIssueです。',
      });
      const createdOutput = normalizeCommandResult(createResult);
      metricsIssue = createdOutput === null ? null : parseIssueNumber(createdOutput);
      if (!metricsIssue) {
        return { ok: false, error: `metrics Issue creation failed: ${(createResult && createResult.stderr) || '(empty)'}` };
      }
    }

    const commentsResult = listCommentsFn(repo, metricsIssue, { cwd: workspace });
    if (!commentsResult || commentsResult.error || commentsResult.status !== 0) {
      return { ok: false, error: `metrics comment search failed: ${(commentsResult && commentsResult.stderr) || '(empty)'}` };
    }
    let comments;
    try {
      comments = parseCommentsFn(commentsResult.stdout);
    } catch (error) {
      return { ok: false, error: `metrics comment response parse failed: ${error.message}` };
    }
    if (!Array.isArray(comments)) return { ok: false, error: 'metrics comment response was not an array' };
    if (comments.some(comment => typeof comment?.body === 'string' && comment.body.includes(marker))) {
      return { ok: true, duplicate: true, issue: metricsIssue, body, marker };
    }

    const posted = postCommentFn({
      issue: metricsIssue,
      repo,
      workspace,
      body,
      sourceIssue: issueNumber,
      pr: prNumber,
    });
    if (!posted || posted.ok === false || (posted.status != null && posted.status !== 0)) {
      return { ok: false, error: `metrics snapshot comment failed: ${(posted && (posted.error || posted.stderr)) || '(empty)'}` };
    }
    return { ok: true, issue: metricsIssue, body, marker, url: posted.url || posted.stdout || null };
  } catch (error) {
    try { warnFn(error); } catch { /* best-effort */ }
    return { ok: false, error: error.message || String(error) };
  } finally {
    if (locked) {
      try { releaseLockFn(workspace); } catch (error) { try { warnFn(error); } catch {} }
    }
  }
}

module.exports = {
  METRICS_LABEL,
  SNAPSHOT_MARKER,
  markerFor,
  buildSnapshotBody,
  postCycleSnapshot,
  defaultListMetricsIssues,
  defaultCreateMetricsIssue,
};
