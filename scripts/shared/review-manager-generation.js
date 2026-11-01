'use strict';

// manager.json and manager.incomplete are reused by later reviews of the same PR.
// This sidecar identifies which review run, if any, produced the current result.

const fs = require('fs');
const { atomicWriteJson } = require('./atomic-write');
const { reviewArtifactPath } = require('./review-manager-paths');

const RESULT_STATES = new Set(['running', 'complete', 'incomplete']);

function validateRecord(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || typeof value.startTime !== 'string'
    || !Number.isFinite(Date.parse(value.startTime))
    || !RESULT_STATES.has(value.state)) {
    throw new Error(`Review Manager 世代記録が不正です: ${filePath}`);
  }
  return { version: value.version, startTime: value.startTime, state: value.state };
}

function readReviewManagerGeneration(workspace, pr) {
  const filePath = reviewArtifactPath(workspace, pr, '.generation.json');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Review Manager 世代記録を読めません: ${filePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Review Manager 世代記録を解析できません: ${filePath}: ${error.message}`);
  }
  return validateRecord(parsed, filePath);
}

function beginReviewManagerGeneration(workspace, pr, startTime) {
  if (typeof startTime !== 'string' || !Number.isFinite(Date.parse(startTime))) {
    throw new Error('Review Manager 起動時刻が不正です');
  }
  // A valid prior generation is expected and will be replaced. A corrupt record is
  // management state and must be reported instead of silently repaired.
  readReviewManagerGeneration(workspace, pr);
  const record = { version: 1, startTime, state: 'running' };
  atomicWriteJson(reviewArtifactPath(workspace, pr, '.generation.json'), record);
  return record;
}

function recordReviewManagerResult(workspace, pr, startTime, state) {
  if (state !== 'complete' && state !== 'incomplete') {
    throw new Error(`Review Manager の結果状態が不正です: ${state}`);
  }
  const current = readReviewManagerGeneration(workspace, pr);
  if (!current || current.startTime !== startTime) {
    throw new Error('Review Manager 世代記録が現在のmanager.runningと一致しません');
  }
  if (current.state === state) return current;
  if (current.state !== 'running') {
    throw new Error(`Review Manager 世代記録は既に結果状態です: ${current.state}`);
  }
  const record = { ...current, state };
  atomicWriteJson(reviewArtifactPath(workspace, pr, '.generation.json'), record);
  return record;
}

function inspectReviewManagerResult(workspace, pr, startTime) {
  if (!workspace || !pr || typeof startTime !== 'string' || !Number.isFinite(Date.parse(startTime))) {
    return { status: 'unconfirmed', reason: 'Review Managerの世代識別情報が不正です' };
  }

  const generation = readReviewManagerGeneration(workspace, pr);
  if (!generation || generation.startTime !== startTime) {
    return { status: 'unconfirmed', reason: '対応する世代記録がありません' };
  }
  if (generation.state === 'incomplete') {
    return { status: 'confirmed', state: generation.state };
  }
  if (generation.state !== 'complete') {
    return { status: 'unconfirmed', state: generation.state };
  }

  const resultPath = reviewArtifactPath(workspace, pr, '.json');
  let resultStat;
  try {
    resultStat = fs.statSync(resultPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'complete-without-artifact', resultPath };
    }
    throw new Error(`Review Managerの成果物を確認できません: ${resultPath}: ${error.message}`);
  }
  if (!resultStat.isFile()) {
    return { status: 'complete-without-artifact', resultPath, reason: 'manager.jsonが通常ファイルではありません' };
  }
  return { status: 'confirmed', state: generation.state };
}

module.exports = {
  beginReviewManagerGeneration,
  recordReviewManagerResult,
  readReviewManagerGeneration,
  inspectReviewManagerResult,
};
