'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// run-review-manager.js の CLI 実行部は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない
// （.claude/rules/test-process-spawn-safety.md 準拠）。
const { resolveMode, buildPrompt, augmentOutputWithMode } = require('../scripts/run-review-manager');

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-run-rm-' + Date.now());

before(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── resolveMode ──────────────────────────────────────────────────────────

test('resolveMode defaults to heavy for null/undefined', () => {
  assert.equal(resolveMode(null), 'heavy');
  assert.equal(resolveMode(undefined), 'heavy');
});

test('resolveMode accepts heavy and directed', () => {
  assert.equal(resolveMode('heavy'), 'heavy');
  assert.equal(resolveMode('directed'), 'directed');
});

test('resolveMode rejects an unknown mode', () => {
  assert.throws(() => resolveMode('light'), /invalid mode/);
});

// ── buildPrompt ──────────────────────────────────────────────────────────

test('buildPrompt heavy mode instructs the 3-aspect parallel review', () => {
  const prompt = buildPrompt({
    pr: '5', repo: 'o/r', workspace: 'C:\\ws', outputFile: 'C:\\ws\\out.json', mode: 'heavy',
  });
  assert.match(prompt, /MODE=heavy/);
  assert.match(prompt, /3観点のReviewerを独立に並列spawnする/);
});

test('buildPrompt directed mode embeds the given brief and omits the 3-aspect instruction', () => {
  const prompt = buildPrompt({
    pr: '5',
    repo: 'o/r',
    workspace: 'C:\\ws',
    outputFile: 'C:\\ws\\out.json',
    mode: 'directed',
    directedBrief: '正しさだけを見る',
  });
  assert.match(prompt, /MODE=directed/);
  assert.match(prompt, /正しさだけを見る/);
  assert.doesNotMatch(prompt, /3観点のReviewerを独立に並列spawnする/);
});

test('buildPrompt normalizes backslash paths to forward slashes', () => {
  const prompt = buildPrompt({
    pr: '5', repo: 'o/r', workspace: 'C:\\ws', outputFile: 'C:\\ws\\out.json', mode: 'heavy',
  });
  assert.match(prompt, /WORKSPACE=C:\/ws/);
  assert.match(prompt, /OUTPUT=C:\/ws\/out\.json/);
});

// ── augmentOutputWithMode ────────────────────────────────────────────────

test('augmentOutputWithMode records mode on a heavy-mode output', () => {
  const outputFile = path.join(tmpBase, 'heavy-output.json');
  fs.writeFileSync(outputFile, JSON.stringify({ pr: 1, repo: 'o/r', headRefOid: 'abc', findings: [] }));
  augmentOutputWithMode(outputFile, 'heavy', null);
  const payload = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(payload.mode, 'heavy');
  assert.equal('directedPrompt' in payload, false);
});

test('augmentOutputWithMode records mode and the directed brief on a directed-mode output', () => {
  const outputFile = path.join(tmpBase, 'directed-output.json');
  fs.writeFileSync(outputFile, JSON.stringify({ pr: 1, repo: 'o/r', headRefOid: 'abc', findings: [] }));
  augmentOutputWithMode(outputFile, 'directed', '命名と可読性だけを見る');
  const payload = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(payload.mode, 'directed');
  assert.equal(payload.directedPrompt, '命名と可読性だけを見る');
});

test('augmentOutputWithMode preserves existing findings', () => {
  const outputFile = path.join(tmpBase, 'preserve-output.json');
  const finding = { aspect: 'Correctness', path: 'a.ts', line_anchor: 'x', summary: 's' };
  fs.writeFileSync(outputFile, JSON.stringify({ pr: 1, repo: 'o/r', headRefOid: 'abc', findings: [finding] }));
  augmentOutputWithMode(outputFile, 'heavy', null);
  const payload = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.deepEqual(payload.findings, [finding]);
});
