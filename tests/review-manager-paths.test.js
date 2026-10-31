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
  // 同じ検証を、ブランチ名と worktree 配置の入口でも確認する（パスを組む前に拒否する）
  const workspace = path.resolve('C:/ws');
  assert.throws(() => reviewWorktreeBranchName('../42'), /invalid PR number/);
  assert.throws(() => reviewWorktreeDir(workspace, '../../evil'), /invalid PR number/);
});

// ── reviewArtifactPath ───────────────────────────────────────────────────

test('reviewArtifactPath builds a PR-owned records path', () => {
  const workspace = path.resolve('C:/ws');
  const result = reviewArtifactPath(workspace, '42', '.running');
  assert.equal(result, path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.running'));
});

test('reviewArtifactPath rejects a path-traversal pr before building any path', () => {
  const workspace = path.resolve('C:/ws');
  // 同じ検証経路を、ファイル種別ごとの配置先（.running / .log / .retries.json）で確認する
  for (const suffix of ['.running', '.log', '.retries.json']) {
    assert.throws(() => reviewArtifactPath(workspace, '../../evil', suffix), /invalid PR number/);
  }
});

test('reviewArtifactPath: .log はPR recordsのreview配下に置く', () => {
  const workspace = path.resolve('C:/ws');
  const result = reviewArtifactPath(workspace, '42', '.log');
  assert.equal(result, path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.log'));
});

test('reviewArtifactPath: .retries.json はPR recordsのreview配下に置く', () => {
  const workspace = path.resolve('C:/ws');
  const result = reviewArtifactPath(workspace, '42', '.retries.json');
  assert.equal(result, path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.retries.json'));
});

// ── reviewWorktreeBranchName / reviewWorktreeFetchRef ───────────────────

test('reviewWorktreeBranchName builds a PR-scoped branch name', () => {
  assert.equal(reviewWorktreeBranchName('42'), 'review-pr-42');
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

