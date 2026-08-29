'use strict';

// test-result.js — test runner が作成する実行結果成果物の共通契約。
//
// 成果物は worktree ではなく storage-layout.js の runtime root に置く。push-and-declare.js
// は git add -A で worktree 全体をステージするため、リポジトリ内へ成果物を置くと実装
// コミットへ混入しうる。worktree ごとの runtime directory を使うことで、実行記録を
// 作業ツリーから分離しつつ、同じ worktree の npm test と申告入口だけで共有できる。

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic-write');
const {
  workspaceRuntimeDir,
  ensureWorkspaceRuntimeDir,
  assertValidWorkspace,
  assertDisjointRoots,
} = require('./storage-layout');

const TEST_RESULT_SCHEMA_VERSION = 1;
const TEST_RESULT_PRODUCER = 'gh-maestro-test-runner';
const TEST_RESULT_PROVENANCE = 'test-runner';
const TEST_RESULT_FILE_NAME = 'test-result.json';
const TEST_RESULT_SCOPES = Object.freeze(new Set(['full', 'partial']));
const TEST_RESULT_STATUSES = Object.freeze(new Set(['complete', 'unavailable']));
const TAP_COUNT_FIELDS = Object.freeze(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * worktree 固有の成果物パスを返す。runtime root 配下なので git の対象外であり、
 * `push-and-declare.js` の git add -A によって実装コミットへ混入しない。
 *
 * @param {string} worktree
 * @returns {string}
 */
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

function parseNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative safe integer` };
  }
  return { ok: true, value };
}

/**
 * Node test runner の TAP summary を解析する。必須 summary が一つでも欠けている場合は
 * 部分的な出力を成功結果へ丸めず、呼び出し側が unknown 成果物を作れる形で返す。
 *
 * @param {string} output stdout/stderr を結合した test runner 出力
 * @returns {{ok:true, summary:object}|{ok:false, error:string}}
 */
function parseTapSummary(output) {
  if (typeof output !== 'string' || !output) {
    return { ok: false, error: 'test runner output is empty' };
  }

  const summary = {};
  const seen = new Set();
  // 複数ファイルを node --test で実行すると、各サブテストの集計がインデント付きで
  // 出力され、最後にトップレベルの総計が出る。トップレベルだけを拾うことで、
  // サブテストの件数を重複扱いしない。
  const re = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+([0-9]+)\s*$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    const field = match[1];
    if (seen.has(field)) {
      return { ok: false, error: `duplicate TAP summary field: ${field}` };
    }
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

/**
 * 成果物のスキーマを検証する。検証できない JSON は呼び出し側で unknown として扱う。
 *
 * @param {unknown} value
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateTestResultArtifact(value) {
  if (!isPlainObject(value)) return { ok: false, error: 'test result artifact must be a JSON object' };
  if (value.schemaVersion !== TEST_RESULT_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported test result schemaVersion: ${JSON.stringify(value.schemaVersion)}` };
  }
  if (value.producer !== TEST_RESULT_PRODUCER) {
    return { ok: false, error: 'test result artifact producer is invalid' };
  }
  if (value.provenance !== TEST_RESULT_PROVENANCE) {
    return { ok: false, error: 'test result artifact provenance is invalid' };
  }
  if (typeof value.scope !== 'string' || !TEST_RESULT_SCOPES.has(value.scope)) {
    return { ok: false, error: 'test result artifact scope is invalid' };
  }
  if (typeof value.status !== 'string' || !TEST_RESULT_STATUSES.has(value.status)) {
    return { ok: false, error: 'test result artifact status is invalid' };
  }
  if (typeof value.command !== 'string' || !value.command.trim()) {
    return { ok: false, error: 'test result artifact command is required' };
  }
  if (typeof value.recordedAt !== 'string' || !value.recordedAt.trim()) {
    return { ok: false, error: 'test result artifact recordedAt is required' };
  }

  if (value.status === 'complete') {
    const counts = validateCountFields(value, TAP_COUNT_FIELDS);
    if (!counts.ok) return counts;
    if (value.fail + value.pass > value.tests) {
      return { ok: false, error: 'test result counts exceed tests count' };
    }
  } else {
    if (typeof value.reason !== 'string' || !value.reason.trim()) {
      return { ok: false, error: 'unavailable test result must include a reason' };
    }
    const counts = validateCountFields(value, []);
    if (!counts.ok) return counts;
  }

  if (value.testedHead !== undefined && value.testedHead !== null
      && (typeof value.testedHead !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(value.testedHead))) {
    return { ok: false, error: 'test result artifact testedHead is invalid' };
  }

  return { ok: true, value };
}

/**
 * ランナーが作成した成果物を runtime root へ原子的に書き出す。
 * @param {string} worktree
 * @param {object} artifact
 * @returns {string}
 * @throws {Error} 成果物が不正、または書き出しに失敗した場合
 */
function writeTestResultArtifact(worktree, artifact) {
  const validated = validateTestResultArtifact(artifact);
  if (!validated.ok) throw new Error(validated.error);
  const base = normalizedWorktree(worktree);
  const resultPath = testResultPath(base);
  ensureWorkspaceRuntimeDir(base);
  return atomicWriteJson(resultPath, artifact);
}

/**
 * runtime root の成果物を読み取り、完全な結果だけを申告へ渡す。
 * 欠落・読み取り不能・JSON破損・スキーマ不正・unavailable はすべて ok=false だが、
 * 呼び出し側はこれを副作用停止条件にせず unknown 申告へ縮退する。
 *
 * @param {string} worktree
 * @returns {{ok:true,result:object,path:string}|{ok:false,kind:string,reason:string,path:string}}
 */
function readTestResultArtifact(worktree = process.cwd()) {
  const resultPath = testResultPath(worktree);
  let raw;
  try {
    raw = fs.readFileSync(resultPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      kind: error && error.code === 'ENOENT' ? 'missing' : 'unreadable',
      reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable',
      path: resultPath,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, kind: 'invalid', reason: 'invalid-json', path: resultPath };
  }

  const validated = validateTestResultArtifact(parsed);
  if (!validated.ok) {
    return { ok: false, kind: 'invalid', reason: 'invalid-artifact', path: resultPath };
  }
  if (parsed.status !== 'complete') {
    return { ok: false, kind: 'unavailable', reason: parsed.reason, path: resultPath };
  }

  return {
    ok: true,
    path: resultPath,
    result: {
      provenance: parsed.provenance,
      scope: parsed.scope,
      tests: parsed.tests,
      pass: parsed.pass,
      fail: parsed.fail,
      cancelled: parsed.cancelled,
      skipped: parsed.skipped,
      todo: parsed.todo,
      command: parsed.command,
      recordedAt: parsed.recordedAt,
      testedHead: parsed.testedHead || undefined,
    },
  };
}

module.exports = {
  TEST_RESULT_SCHEMA_VERSION,
  TEST_RESULT_PRODUCER,
  TEST_RESULT_PROVENANCE,
  TEST_RESULT_FILE_NAME,
  TEST_RESULT_SCOPES,
  TEST_RESULT_STATUSES,
  TAP_COUNT_FIELDS,
  testResultPath,
  parseTapSummary,
  validateTestResultArtifact,
  writeTestResultArtifact,
  readTestResultArtifact,
};
