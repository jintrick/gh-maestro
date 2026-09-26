'use strict';

// pr-monitor-target.js — plugin monitor と Issue 単位の poll-pr を結ぶ制御レコード。
//
// plugin monitor のコマンドは固定で引数を受け取れないため、監視対象 Issue は
// workspace ごとの runtime に置く。このファイルは可変状態の正本であり、managed root
// （~/.gh-maestro/）には置かない。読み取りは readJsonFile、書き込みは atomicWriteJson
// に統一し、破損・読み取り不能を「対象なし」へ縮退させない。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson } = require('./atomic-write');
const { JsonFileError, readJsonFile } = require('./json-file');
const {
  workspaceRuntimeDir,
  ensureWorkspaceRuntimeDir,
  isNodeTestContext,
  assertValidWorkspace,
  assertDisjointRoots,
} = require('./storage-layout');

const TARGET_FILE = 'pr-monitor-target.json';

function assertWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('PR monitor target: workspace が必要です');
  }
  assertValidWorkspace(workspace);
  assertDisjointRoots();
}

function targetPath(workspace) {
  assertWorkspace(workspace);
  return path.join(workspaceRuntimeDir(workspace), TARGET_FILE);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateTarget(value, filePath = TARGET_FILE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PR monitor target の形式が不正です: ${filePath}`);
  }
  const allowed = new Set([
    'schemaVersion', 'generation', 'issue', 'baseBranch',
    'noReviewManager', 'noReviewEvents', 'sessionPid', 'sessionStartTime', 'updatedAt',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`PR monitor target に未知のフィールドがあります: ${key}`);
  }
  if (value.schemaVersion !== 1
    || typeof value.generation !== 'string' || value.generation === ''
    || !/^[1-9][0-9]*$/.test(String(value.issue))
    || (value.baseBranch !== null && typeof value.baseBranch !== 'string')
    || typeof value.noReviewManager !== 'boolean'
    || typeof value.noReviewEvents !== 'boolean'
    || (value.sessionPid !== null && !isPositiveInteger(value.sessionPid))
    || (value.sessionStartTime !== null && typeof value.sessionStartTime !== 'string')
    || typeof value.updatedAt !== 'string' || value.updatedAt === '') {
    throw new Error(`PR monitor target のフィールドが不正です: ${filePath}`);
  }
  return {
    schemaVersion: 1,
    generation: value.generation,
    issue: String(value.issue),
    baseBranch: value.baseBranch || null,
    noReviewManager: value.noReviewManager,
    noReviewEvents: value.noReviewEvents,
    sessionPid: value.sessionPid === null ? null : value.sessionPid,
    sessionStartTime: value.sessionStartTime || null,
    updatedAt: value.updatedAt,
  };
}

function readPrMonitorTarget(workspace) {
  const filePath = targetPath(workspace);
  let value;
  try {
    value = readJsonFile(filePath);
  } catch (error) {
    if (error instanceof JsonFileError && error.kind === 'read' && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`PR monitor target を読み取れません: ${filePath}: ${error.message}`, { cause: error });
  }
  return validateTarget(value, filePath);
}

function writePrMonitorTarget(workspace, target) {
  const filePath = targetPath(workspace);
  const normalized = validateTarget(target, filePath);
  ensureWorkspaceRuntimeDir(workspace, { register: !isNodeTestContext() });
  atomicWriteJson(filePath, normalized);
  return normalized;
}

function createPrMonitorTarget({
  issue,
  baseBranch = null,
  noReviewManager = false,
  noReviewEvents = false,
  sessionPid = null,
  sessionStartTime = null,
  generation = crypto.randomUUID(),
  updatedAt = new Date().toISOString(),
}) {
  return validateTarget({
    schemaVersion: 1,
    generation,
    issue,
    baseBranch: baseBranch || null,
    noReviewManager: Boolean(noReviewManager),
    noReviewEvents: Boolean(noReviewEvents),
    sessionPid: sessionPid === null || sessionPid === undefined ? null : Number(sessionPid),
    sessionStartTime: sessionStartTime || null,
    updatedAt,
  });
}

/**
 * Target が expected と一致する場合だけ削除する。
 * Issue 終了処理と target 切替の競合で、新しい target を誤って消さないために
 * generation も照合できる。
 */
function clearPrMonitorTarget(workspace, expected = {}) {
  const filePath = targetPath(workspace);
  const current = readPrMonitorTarget(workspace);
  if (!current) return false;
  if (expected.issue !== undefined && String(expected.issue) !== current.issue) return false;
  if (expected.generation !== undefined && expected.generation !== current.generation) return false;

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw new Error(`PR monitor target を削除できません: ${filePath}: ${error.message}`, { cause: error });
  }
  return true;
}

module.exports = {
  TARGET_FILE,
  targetPath,
  validateTarget,
  createPrMonitorTarget,
  readPrMonitorTarget,
  writePrMonitorTarget,
  clearPrMonitorTarget,
};
