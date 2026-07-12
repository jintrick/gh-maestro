'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectAspects } = require('../scripts/shared/detect-aspects');

const KNOWN = [
  'api-contract', 'concurrency', 'logic-invariants',
  'structure-naming', 'test-quality',
  'failure-recovery', 'hostile-input',
];

test('detectAspects maps test files to test-quality', () => {
  const result = detectAspects(['tests/poll-pr.test.js'], KNOWN);
  assert.ok(result.includes('test-quality'));
});

test('detectAspects maps child-process/spawn changes to api-contract', () => {
  const result = detectAspects(['scripts/child-process.js'], KNOWN);
  assert.ok(result.includes('api-contract'));
});

test('detectAspects maps lock/lifecycle changes to concurrency', () => {
  const result = detectAspects(['scripts/process-lifecycle.js'], KNOWN);
  assert.ok(result.includes('concurrency'));
});

test('detectAspects maps safe-path changes to hostile-input', () => {
  const result = detectAspects(['scripts/shared/safe-path.js'], KNOWN);
  assert.ok(result.includes('hostile-input'));
});

test('detectAspects dedupes and sorts across multiple files', () => {
  const result = detectAspects(['tests/a.test.js', 'tests/b.test.js', 'scripts/child-process.js'], KNOWN);
  assert.deepEqual(result, [...new Set(result)].sort());
  assert.ok(result.includes('test-quality'));
  assert.ok(result.includes('api-contract'));
});

test('detectAspects falls back to the full known set when nothing matches', () => {
  const result = detectAspects(['docs/random-notes.txt'], KNOWN);
  assert.deepEqual(result, [...KNOWN].sort());
});

test('detectAspects falls back to the full known set for an empty file list', () => {
  const result = detectAspects([], KNOWN);
  assert.deepEqual(result, [...KNOWN].sort());
});

test('detectAspects only returns aspects present in knownAspects', () => {
  // "test-quality" が既知集合から外れている場合、一致しても含めない
  const limited = KNOWN.filter(a => a !== 'test-quality');
  const result = detectAspects(['tests/a.test.js'], limited);
  assert.equal(result.includes('test-quality'), false);
});
