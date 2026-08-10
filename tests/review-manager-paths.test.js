'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  assertValidPr, reviewArtifactPath,
  reviewWorktreeBranchName, reviewWorktreeFetchRef, reviewWorktreeDir,
} = require('../scripts/shared/review-manager-paths');
const { workerLogPath } = require('../scripts/shared/headless-launch');

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

test('reviewArtifactPath builds a PR-owned records path', () => {
  const ghDir = path.resolve('C:/ws/.gh-maestro');
  const result = reviewArtifactPath(ghDir, '42', '.running');
  assert.equal(result, path.join(ghDir, 'records', 'pr', '42', 'review', 'manager.running'));
});

test('reviewArtifactPath rejects a path-traversal pr before building any path', () => {
  const ghDir = path.resolve('C:/ws/.gh-maestro');
  assert.throws(() => reviewArtifactPath(ghDir, '../../evil', '.running'), /invalid PR number/);
});

test('reviewArtifactPath: .log はPR recordsのreview配下に置く', () => {
  const workspace = path.resolve('C:/ws');
  const ghDir = path.join(workspace, '.gh-maestro');
  const result = reviewArtifactPath(ghDir, '42', '.log');
  assert.equal(result, path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.log'));
});

test('reviewArtifactPath: .log でもpath-traversalなprは拒否される', () => {
  const ghDir = path.resolve('C:/ws/.gh-maestro');
  assert.throws(() => reviewArtifactPath(ghDir, '../../evil', '.log'), /invalid PR number/);
});

// ── reviewWorktreeBranchName / reviewWorktreeFetchRef ───────────────────

test('reviewWorktreeBranchName builds a PR-scoped branch name', () => {
  assert.equal(reviewWorktreeBranchName('42'), 'review-pr-42');
});

test('reviewWorktreeBranchName rejects an invalid PR number', () => {
  assert.throws(() => reviewWorktreeBranchName('../42'), /invalid PR number/);
});

test('reviewWorktreeFetchRef builds a dedicated non-remote-tracking ref name', () => {
  assert.equal(reviewWorktreeFetchRef('42'), 'refs/gh-maestro/review-pr-42');
});

// ── reviewWorktreeDir ────────────────────────────────────────────────────

test('reviewWorktreeDir builds a path inside workspace/.gh-maestro/worktrees', () => {
  const workspace = path.resolve('C:/ws');
  const result = reviewWorktreeDir(workspace, '42');
  assert.equal(result, path.join(workspace, '.gh-maestro', 'worktrees', 'review-pr-42'));
});

test('reviewWorktreeDir rejects a path-traversal pr before building any path', () => {
  const workspace = path.resolve('C:/ws');
  assert.throws(() => reviewWorktreeDir(workspace, '../../evil'), /invalid PR number/);
});
