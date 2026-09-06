'use strict';

// test-result.js — test runner が作成する実行結果成果物の共通契約。
// v1 は従来の単一結果として読み書きを維持し、通常経路は v2 の層別集合を使う。

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const { calculateWorktreeContentHash, calculateCommitContentHash } = require('./test-content');
const {
  workspaceRuntimeDir,
  assertValidWorkspace,
  assertDisjointRoots,
} = require('./storage-layout');

const TEST_RESULT_SCHEMA_VERSION = 1;
const TEST_RESULT_AGGREGATE_SCHEMA_VERSION = 2;
const TEST_RESULT_PRODUCER = 'gh-maestro-test-runner';
const TEST_RESULT_PROVENANCE = 'test-runner';
const TEST_RESULT_FILE_NAME = 'test-result.json';
const TEST_RESULT_INVALIDATION_FILE_NAME = 'test-result.invalidated';
const TEST_RESULT_LOCK_FILE_NAME = `${TEST_RESULT_FILE_NAME}.lock`;
const TEST_RESULT_SCOPES = Object.freeze(new Set(['full', 'partial']));
const TEST_RESULT_STATUSES = Object.freeze(new Set(['complete', 'unavailable']));
const TEST_RESULT_OUTCOMES = Object.freeze(new Set(['pass', 'fail']));
const TAP_COUNT_FIELDS = Object.freeze(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);
const TEST_CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedWorktree(worktree = process.cwd()) {
  const base = typeof worktree === 'string' && worktree.trim() ? worktree : process.cwd();
  return path.resolve(base);
}

function testResultPath(worktree = process.cwd()) {
  const base = normalizedWorktree(worktree);
  assertValidWorkspace(base);
  assertDisjointRoots();
  const resultPath = path.join(workspaceRuntimeDir(base), TEST_RESULT_FILE_NAME);
  const relative = path.relative(base, resultPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`test result artifact path must be outside the worktree: ${resultPath}`);
  }
  return resultPath;
}

function testResultInvalidationPath(worktree = process.cwd()) {
  return path.join(path.dirname(testResultPath(worktree)), TEST_RESULT_INVALIDATION_FILE_NAME);
}

function testResultLockPath(worktree = process.cwd()) {
  return path.join(path.dirname(testResultPath(worktree)), TEST_RESULT_LOCK_FILE_NAME);
}

function clearTestResultInvalidation(worktree) {
  try {
    fs.unlinkSync(testResultInvalidationPath(worktree));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function invalidateTestResultArtifact(worktree, reason = 'artifact-refresh-failed') {
  const markerPath = testResultInvalidationPath(worktree);
  return atomicWriteJson(markerPath, {
    schemaVersion: TEST_RESULT_SCHEMA_VERSION,
    reason: typeof reason === 'string' && reason.trim() ? reason : 'artifact-refresh-failed',
    recordedAt: new Date().toISOString(),
  });
}

function readTestResultInvalidation(markerPath) {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return 'artifact-invalidated';
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) && typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason : 'artifact-invalidated';
  } catch {
    return 'artifact-invalidated';
  }
}

function parseNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative safe integer` };
  }
  return { ok: true, value };
}

function parseTapSummary(output) {
  if (typeof output !== 'string' || !output) return { ok: false, error: 'test runner output is empty' };
  const summary = {};
  const seen = new Set();
  const re = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+([0-9]+)\s*$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    const field = match[1];
    if (seen.has(field)) return { ok: false, error: `duplicate TAP summary field: ${field}` };
    seen.add(field);
    const value = Number(match[2]);
    const parsed = parseNonNegativeInteger(value, field);
    if (!parsed.ok) return parsed;
    summary[field] = value;
  }
  for (const field of ['tests', 'pass', 'fail']) {
    if (!Object.prototype.hasOwnProperty.call(summary, field)) {
      return { ok: false, error: `missing TAP summary field: ${field}` };
    }
  }
  for (const field of ['cancelled', 'skipped', 'todo']) {
    if (!Object.prototype.hasOwnProperty.call(summary, field)) summary[field] = 0;
  }
  return { ok: true, summary };
}

function validateCountFields(value, required) {
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return { ok: false, error: `missing test result field: ${field}` };
    }
  }
  for (const field of TAP_COUNT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const parsed = parseNonNegativeInteger(value[field], field);
    if (!parsed.ok) return parsed;
  }
  return { ok: true };
}

function validateResultFields(value, fieldPrefix, { requireLayer = false } = {}) {
  if (!isPlainObject(value)) return { ok: false, error: `${fieldPrefix} must be a JSON object` };
  if (requireLayer && (typeof value.layer !== 'string' || !value.layer.trim())) return { ok: false, error: `${fieldPrefix} layer is required` };
  if (typeof value.scope !== 'string' || !TEST_RESULT_SCOPES.has(value.scope)) return { ok: false, error: `${fieldPrefix} scope is invalid` };
  if (typeof value.status !== 'string' || !TEST_RESULT_STATUSES.has(value.status)) return { ok: false, error: `${fieldPrefix} status is invalid` };
  if (typeof value.command !== 'string' || !value.command.trim()) return { ok: false, error: `${fieldPrefix} command is required` };
  if (typeof value.recordedAt !== 'string' || !value.recordedAt.trim()) return { ok: false, error: `${fieldPrefix} recordedAt is required` };
  if (value.status === 'complete') {
    if (value.outcome !== undefined && (typeof value.outcome !== 'string' || !TEST_RESULT_OUTCOMES.has(value.outcome))) return { ok: false, error: `${fieldPrefix} complete outcome is invalid` };
    const counts = validateCountFields(value, []);
    if (!counts.ok) return counts;
    const hasFail = Object.prototype.hasOwnProperty.call(value, 'fail');
    const hasPass = Object.prototype.hasOwnProperty.call(value, 'pass');
    if (hasFail !== hasPass) return { ok: false, error: `${fieldPrefix} fail and pass must be provided together` };
    if (value.outcome === undefined && !hasFail) return { ok: false, error: `${fieldPrefix} complete must include outcome or fail/pass counts` };
    if (hasFail && Object.prototype.hasOwnProperty.call(value, 'tests') && value.fail + value.pass > value.tests) return { ok: false, error: `${fieldPrefix} counts exceed tests count` };
    if (typeof value.testedContentHash !== 'string' || !TEST_CONTENT_HASH_RE.test(value.testedContentHash)) return { ok: false, error: `${fieldPrefix} complete must include a testedContentHash` };
  } else {
    if (typeof value.reason !== 'string' || !value.reason.trim()) return { ok: false, error: `${fieldPrefix} unavailable must include a reason` };
    const counts = validateCountFields(value, []);
    if (!counts.ok) return counts;
  }
  if (value.testedHead !== undefined && value.testedHead !== null && (typeof value.testedHead !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(value.testedHead))) return { ok: false, error: `${fieldPrefix} testedHead is invalid` };
  if (value.executionLogPath !== undefined && (typeof value.executionLogPath !== 'string' || !value.executionLogPath.trim())) return { ok: false, error: `${fieldPrefix} executionLogPath is invalid` };
  if (value.executor !== undefined && (typeof value.executor !== 'string' || !value.executor.trim())) return { ok: false, error: `${fieldPrefix} executor is invalid` };
  return { ok: true, value };
}

function validateLayerResult(value, fieldPrefix = 'test result') {
  return validateResultFields(value, fieldPrefix, { requireLayer: true });
}

function validateLegacyTestResultArtifact(value) {
  if (!isPlainObject(value)) return { ok: false, error: 'test result artifact must be a JSON object' };
  if (value.schemaVersion !== TEST_RESULT_SCHEMA_VERSION) return { ok: false, error: `unsupported test result schemaVersion: ${JSON.stringify(value.schemaVersion)}` };
  if (value.producer !== TEST_RESULT_PRODUCER) return { ok: false, error: 'test result artifact producer is invalid' };
  if (value.provenance !== TEST_RESULT_PROVENANCE) return { ok: false, error: 'test result artifact provenance is invalid' };
  return validateResultFields(value, 'test result artifact');
}

function validateAggregateTestResultArtifact(value) {
  if (!isPlainObject(value)) return { ok: false, error: 'test result aggregate must be a JSON object' };
  if (value.schemaVersion !== TEST_RESULT_AGGREGATE_SCHEMA_VERSION) return { ok: false, error: 'unsupported aggregate schemaVersion' };
  if (value.producer !== TEST_RESULT_PRODUCER) return { ok: false, error: 'test result aggregate producer is invalid' };
  if (value.provenance !== TEST_RESULT_PROVENANCE) return { ok: false, error: 'test result aggregate provenance is invalid' };
  if (typeof value.recordedAt !== 'string' || !value.recordedAt.trim()) return { ok: false, error: 'test result aggregate recordedAt is required' };
  if (!isPlainObject(value.layers) || Object.keys(value.layers).length === 0) return { ok: false, error: 'test result aggregate layers are required' };
  for (const [name, rawLayer] of Object.entries(value.layers)) {
    const layer = isPlainObject(rawLayer) ? { ...rawLayer, layer: rawLayer.layer || name } : rawLayer;
    const validated = validateLayerResult(layer, `layer ${name}`);
    if (!validated.ok) return validated;
    if (validated.value.layer !== name) return { ok: false, error: `layer ${name} has a mismatched name` };
  }
  if (value.testedHead !== undefined && value.testedHead !== null && (typeof value.testedHead !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(value.testedHead))) return { ok: false, error: 'test result aggregate testedHead is invalid' };
  return { ok: true, value };
}

function validateTestResultArtifact(value) {
  return value && value.schemaVersion === TEST_RESULT_AGGREGATE_SCHEMA_VERSION
    ? validateAggregateTestResultArtifact(value)
    : validateLegacyTestResultArtifact(value);
}

function writeTestResultArtifact(worktree, artifact) {
  const validated = validateLegacyTestResultArtifact(artifact);
  if (!validated.ok) throw new Error(validated.error);
  const base = normalizedWorktree(worktree);
  const resultPath = testResultPath(base);
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const writtenPath = atomicWriteJson(resultPath, artifact);
  clearTestResultInvalidation(base);
  return writtenPath;
}

function acquireResultLock(worktree) {
  const lockPath = testResultLockPath(worktree);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try { fd = fs.openSync(lockPath, 'wx'); } catch (error) { throw new Error(`test result aggregate lock is unavailable: ${error.message}`); }
  return { fd, lockPath };
}

function releaseResultLock(lock) {
  try { if (lock && Number.isInteger(lock.fd)) fs.closeSync(lock.fd); } catch {}
  try { if (lock && lock.lockPath) fs.unlinkSync(lock.lockPath); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

function readAggregateFromDisk(resultPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const validated = validateAggregateTestResultArtifact(parsed);
    return validated.ok ? validated.value : null;
  } catch { return null; }
}

/** 同じ対象HEADの他層を保持したまま、1層だけを原子的に更新する。 */
function writeTestResultLayer(worktree, layerArtifact) {
  const layer = { ...layerArtifact };
  if (typeof layer.layer !== 'string' || !layer.layer.trim()) throw new Error('test result layer is required');
  layer.layer = layer.layer.trim();
  const validatedLayer = validateLayerResult(layer, `layer ${layer.layer}`);
  if (!validatedLayer.ok) throw new Error(validatedLayer.error);
  const base = normalizedWorktree(worktree);
  const resultPath = testResultPath(base);
  const lock = acquireResultLock(base);
  try {
    const current = readAggregateFromDisk(resultPath);
    const currentHead = current && current.testedHead;
    const incomingHead = layer.testedHead || null;
    const sameHead = current && currentHead && incomingHead && currentHead.toLowerCase() === incomingHead.toLowerCase();
    const layers = sameHead ? { ...current.layers } : {};
    layers[layer.layer] = layer;
    const aggregate = {
      schemaVersion: TEST_RESULT_AGGREGATE_SCHEMA_VERSION,
      producer: TEST_RESULT_PRODUCER,
      provenance: TEST_RESULT_PROVENANCE,
      recordedAt: new Date().toISOString(),
      testedHead: incomingHead,
      layers,
    };
    const validated = validateAggregateTestResultArtifact(aggregate);
    if (!validated.ok) throw new Error(validated.error);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    const writtenPath = atomicWriteJson(resultPath, aggregate);
    clearTestResultInvalidation(base);
    return writtenPath;
  } finally {
    releaseResultLock(lock);
  }
}

function layerForRead(layer) {
  return {
    layer: layer.layer,
    scope: layer.scope,
    status: layer.status,
    ...(layer.outcome !== undefined ? { outcome: layer.outcome } : {}),
    ...Object.fromEntries(TAP_COUNT_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(layer, field)).map(field => [field, layer[field]])),
    command: layer.command,
    recordedAt: layer.recordedAt,
    testedHead: layer.testedHead || undefined,
    ...(layer.testedContentHash ? { testedContentHash: layer.testedContentHash } : {}),
    ...(layer.reason ? { reason: layer.reason } : {}),
    ...(layer.executor ? { executor: layer.executor } : {}),
    ...(layer.executionLogPath ? { executionLogPath: layer.executionLogPath } : {}),
  };
}

function readTestResultArtifact(worktree = process.cwd()) {
  const resultPath = testResultPath(worktree);
  const invalidationReason = readTestResultInvalidation(testResultInvalidationPath(worktree));
  if (invalidationReason) return { ok: false, kind: 'unavailable', reason: invalidationReason, path: resultPath };
  let raw;
  try {
    raw = fs.readFileSync(resultPath, 'utf8');
  } catch (error) {
    return { ok: false, kind: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', path: resultPath };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, kind: 'invalid', reason: 'invalid-json', path: resultPath }; }
  const validated = validateTestResultArtifact(parsed);
  if (!validated.ok) return { ok: false, kind: 'invalid', reason: 'invalid-artifact', path: resultPath };
  if (parsed.schemaVersion === TEST_RESULT_AGGREGATE_SCHEMA_VERSION) {
    return {
      ok: true,
      path: resultPath,
      result: {
        provenance: parsed.provenance,
        scope: 'aggregate',
        command: 'layered test execution',
        recordedAt: parsed.recordedAt,
        testedHead: parsed.testedHead || undefined,
        layers: Object.fromEntries(Object.entries(parsed.layers).map(([name, layer]) => [name, layerForRead(layer)])),
      },
    };
  }
  if (parsed.status !== 'complete') return { ok: false, kind: 'unavailable', reason: parsed.reason, path: resultPath };
  return {
    ok: true,
    path: resultPath,
    result: {
      provenance: parsed.provenance,
      scope: parsed.scope,
      ...(parsed.outcome !== undefined ? { outcome: parsed.outcome } : {}),
      ...Object.fromEntries(TAP_COUNT_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(parsed, field)).map(field => [field, parsed[field]])),
      command: parsed.command,
      recordedAt: parsed.recordedAt,
      testedHead: parsed.testedHead || undefined,
      testedContentHash: parsed.testedContentHash,
    },
  };
}

module.exports = {
  TEST_RESULT_SCHEMA_VERSION,
  TEST_RESULT_AGGREGATE_SCHEMA_VERSION,
  TEST_RESULT_PRODUCER,
  TEST_RESULT_PROVENANCE,
  TEST_RESULT_FILE_NAME,
  TEST_RESULT_INVALIDATION_FILE_NAME,
  TEST_RESULT_LOCK_FILE_NAME,
  TEST_RESULT_SCOPES,
  TEST_RESULT_STATUSES,
  TEST_RESULT_OUTCOMES,
  TAP_COUNT_FIELDS,
  TEST_CONTENT_HASH_RE,
  calculateWorktreeContentHash,
  calculateCommitContentHash,
  testResultPath,
  testResultInvalidationPath,
  testResultLockPath,
  clearTestResultInvalidation,
  invalidateTestResultArtifact,
  parseTapSummary,
  validateLayerResult,
  validateTestResultArtifact,
  writeTestResultArtifact,
  writeTestResultLayer,
  readTestResultArtifact,
};
