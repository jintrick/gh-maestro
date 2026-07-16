'use strict';

// execution-registry.js -- worker execution state persisted per workspace.
// A successful external side effect, not process startup, is the completion
// signal.  The registry is deliberately role-agnostic so every worker uses
// the same lifecycle machinery.

const fs = require('fs');
const path = require('path');

function registryPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'executions.json');
}

function readRegistry(workspace) {
  const file = registryPath(workspace);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`executions.json を読み込めません: ${error.message}`);
  }
}

function writeRegistry(workspace, registry) {
  const file = registryPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function startExecution(workspace, { executionId, issue, workerName, skill }) {
  const registry = readRegistry(workspace);
  const current = registry[executionId];
  if (current?.status === 'completed') return current;
  const now = new Date().toISOString();
  const record = {
    executionId,
    issue: Number(issue),
    workerName,
    skill,
    status: 'running',
    startedAt: current?.startedAt || now,
    updatedAt: now,
    commentUrl: null,
  };
  registry[executionId] = record;
  writeRegistry(workspace, registry);
  return record;
}

function markCommentResult(workspace, executionId, { commentUrl, error } = {}) {
  const registry = readRegistry(workspace);
  const record = registry[executionId];
  if (!record) throw new Error(`実行ID "${executionId}" が見つかりません`);
  if (record.status === 'completed') return record;
  const now = new Date().toISOString();
  if (commentUrl) {
    record.status = 'completed';
    record.commentUrl = commentUrl;
    record.completedAt = now;
    delete record.error;
  } else {
    record.status = 'comment_failed';
    record.error = error || 'コメント投稿に失敗しました';
  }
  record.updatedAt = now;
  writeRegistry(workspace, registry);
  return record;
}

function markLaunchFailure(workspace, executionId, error) {
  const registry = readRegistry(workspace);
  const record = registry[executionId];
  if (!record || record.status === 'completed') return record || null;
  record.status = 'launch_failed';
  record.error = error || 'ワーカーの起動に失敗しました';
  record.updatedAt = new Date().toISOString();
  writeRegistry(workspace, registry);
  return record;
}

function markProcessExit(workspace, executionId, exitCode) {
  const registry = readRegistry(workspace);
  const record = registry[executionId];
  if (!record || record.status === 'completed' || record.status === 'comment_failed') return record || null;
  record.status = 'process_failed';
  record.exitCode = Number(exitCode);
  record.updatedAt = new Date().toISOString();
  writeRegistry(workspace, registry);
  return record;
}

module.exports = { registryPath, readRegistry, startExecution, markCommentResult, markLaunchFailure, markProcessExit };
