'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { assertValidPr, reviewArtifactPath } = require('../scripts/shared/review-manager-paths');

// ── assertValidPr ────────────────────────────────────────────────────────

test('assertValidPr accepts positive integer strings', () => {
  assert.equal(assertValidPr('1'), '1');
  assert.equal(assertValidPr('42'), '42');
  assert.equal(assertValidPr(42), '42');
});

test('assertValidPr rejects zero, negative, and non-numeric values', () => {
  assert.throws(() => assertValidPr('0'), /invalid PR number/);
  assert.throws(() => assertValidPr('-1'), /invalid PR number/);
  assert.throws(() => assertValidPr('abc'), /invalid PR number/);
  assert.throws(() => assertValidPr(''), /invalid PR number/);
});

test('assertValidPr rejects path-traversal payloads', () => {
  assert.throws(() => assertValidPr('1/../../etc/passwd'), /invalid PR number/);
  assert.throws(() => assertValidPr('../42'), /invalid PR number/);
  assert.throws(() => assertValidPr('42.running'), /invalid PR number/);
});

// ── reviewArtifactPath ───────────────────────────────────────────────────

test('reviewArtifactPath builds a path inside ghDir', () => {
  const ghDir = path.resolve('C:/ws/.gh-maestro');
  const result = reviewArtifactPath(ghDir, '42', '.running');
  assert.equal(result, path.join(ghDir, 'review-manager-42.running'));
});

test('reviewArtifactPath rejects a path-traversal pr before building any path', () => {
  const ghDir = path.resolve('C:/ws/.gh-maestro');
  assert.throws(() => reviewArtifactPath(ghDir, '../../evil', '.running'), /invalid PR number/);
});
