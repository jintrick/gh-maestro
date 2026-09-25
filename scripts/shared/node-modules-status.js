'use strict';

const fs = require('fs');
const path = require('path');

const STATUS = Object.freeze({
  NOT_APPLICABLE: 'not-applicable',
  OK: 'ok',
  MISSING: 'missing',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readJson(filePath, readFile = fs.readFileSync) {
  let raw;
  try {
    raw = readFile(filePath, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { status: 'absent' };
    }
    return { status: 'unknown', reason: `${filePath} の読み取りに失敗しました: ${errorMessage(error)}` };
  }
  try {
    return { status: 'present', value: JSON.parse(raw) };
  } catch (error) {
    return { status: 'unknown', reason: `${filePath} のJSON構文エラー: ${errorMessage(error)}` };
  }
}

function inspectNodeModulesStatus(workspace, options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const stat = options.stat || fs.statSync;
  if (typeof workspace !== 'string' || workspace.length === 0) {
    return { status: STATUS.UNKNOWN, reason: 'workspace が指定されていません' };
  }

  const lockPath = path.join(workspace, 'package-lock.json');
  const lock = readJson(lockPath, readFile);
  if (lock.status === 'absent') return { status: STATUS.NOT_APPLICABLE };
  if (lock.status === 'unknown') return { status: STATUS.UNKNOWN, reason: lock.reason };
  if (!lock.value || typeof lock.value !== 'object' || Array.isArray(lock.value)) {
    return { status: STATUS.UNKNOWN, reason: 'package-lock.json のトップレベルがオブジェクトではありません' };
  }
  if (!lock.value.packages || typeof lock.value.packages !== 'object'
      || Array.isArray(lock.value.packages)) {
    return { status: STATUS.UNKNOWN, reason: 'package-lock.json のpackages情報を読み取れません' };
  }

  const nodeModulesPath = path.join(workspace, 'node_modules');
  let nodeModulesStat;
  try {
    nodeModulesStat = stat(nodeModulesPath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { status: STATUS.MISSING, reason: `${nodeModulesPath} がありません` };
    }
    return { status: STATUS.UNKNOWN, reason: `${nodeModulesPath} の存在確認に失敗しました: ${errorMessage(error)}` };
  }
  if (!nodeModulesStat.isDirectory()) {
    return { status: STATUS.MISMATCH, reason: `${nodeModulesPath} がディレクトリではありません` };
  }

  const mismatches = [];
  for (const [relativePath, expected] of Object.entries(lock.value.packages)) {
    const normalized = relativePath.replaceAll('\\', '/');
    if (!normalized.startsWith('node_modules/') || !expected || typeof expected !== 'object') continue;
    if (typeof expected.version !== 'string' || expected.version.length === 0) {
      return { status: STATUS.UNKNOWN, reason: `lockfileの${relativePath}にversionがありません` };
    }
    const packageJsonPath = path.join(workspace, relativePath, 'package.json');
    const actual = readJson(packageJsonPath, readFile);
    if (actual.status !== 'present') {
      mismatches.push(actual.status === 'unknown'
        ? actual.reason
        : `${relativePath} がありません`);
      continue;
    }
    if (!actual.value || typeof actual.value.version !== 'string') {
      mismatches.push(`${relativePath}/package.json のversionを読み取れません`);
      continue;
    }
    if (actual.value.version !== expected.version) {
      mismatches.push(`${relativePath}: lock=${expected.version}, installed=${actual.value.version}`);
    }
  }

  return mismatches.length > 0
    ? { status: STATUS.MISMATCH, reason: mismatches.join('; ') }
    : { status: STATUS.OK };
}

module.exports = { STATUS, inspectNodeModulesStatus };
