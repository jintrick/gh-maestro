'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// run-review-manager.js の CLI 実行部は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない
// （.claude/rules/test-process-spawn-safety.md 準拠）。
const { resolveMode, buildPrompt, digestText, writeRunMetadata, parseArgs } = require('../scripts/run-review-manager');

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

// ── digestText ───────────────────────────────────────────────────────────

test('digestText returns a stable sha256 and byte length', () => {
  const a = digestText('正しさだけを見る');
  const b = digestText('正しさだけを見る');
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256.length, 64);
  assert.equal(a.length, Buffer.byteLength('正しさだけを見る', 'utf8'));
});

test('digestText differs for different text', () => {
  const a = digestText('正しさだけを見る');
  const b = digestText('命名と可読性だけを見る');
  assert.notEqual(a.sha256, b.sha256);
});

// ── writeRunMetadata ─────────────────────────────────────────────────────
// findings JSON本体（outputFile）は変更しない。mode/directedBriefは別ファイルに
// 書き出し、directedのレビュー方針本文そのものは記録しない（ダイジェストのみ）。

test('writeRunMetadata records only mode for heavy runs', () => {
  const metaFile = path.join(tmpBase, 'heavy.meta.json');
  writeRunMetadata(metaFile, 'heavy', null);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.equal(meta.mode, 'heavy');
  assert.equal('directedBrief' in meta, false);
});

test('writeRunMetadata records a brief digest (not raw text) for directed runs', () => {
  const metaFile = path.join(tmpBase, 'directed.meta.json');
  const brief = '命名と可読性だけを見る';
  writeRunMetadata(metaFile, 'directed', brief);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.equal(meta.mode, 'directed');
  assert.deepEqual(meta.directedBrief, digestText(brief));
  assert.equal(JSON.stringify(meta).includes(brief), false);
});

// ── parseArgs ────────────────────────────────────────────────────────────

test('parseArgs: 位置引数とフラグを通常どおりパースする', () => {
  const r = parseArgs(['5', 'o/r', 'C:\\ws', '--mode', 'directed', '--brief-file', '/tmp/b.md']);
  assert.equal(r.help, false);
  assert.equal(r.mode, 'directed');
  assert.equal(r.briefFile, '/tmp/b.md');
  assert.deepEqual(r.positional, ['5', 'o/r', 'C:\\ws']);
});

test('parseArgs: --help はヘルプフラグとして認識される', () => {
  const r = parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('parseArgs: --brief-file の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['5', 'o/r', 'C:\\ws', '--brief-file', '--help']);
  assert.equal(r.help, false);
  assert.equal(r.briefFile, '--help');
  assert.deepEqual(r.positional, ['5', 'o/r', 'C:\\ws']);
});

test('parseArgs: --mode の値が"--brief-file"文字列でも別フラグとして誤解釈しない', () => {
  const r = parseArgs(['--mode', '--brief-file', '--brief-file', 'x']);
  assert.equal(r.mode, '--brief-file');
  assert.equal(r.briefFile, 'x');
});

test('writeRunMetadata does not touch any findings output file', () => {
  const outputFile = path.join(tmpBase, 'untouched-output.json');
  const original = JSON.stringify({ pr: 1, repo: 'o/r', headRefOid: 'abc', findings: [] });
  fs.writeFileSync(outputFile, original);
  writeRunMetadata(path.join(tmpBase, 'untouched.meta.json'), 'directed', '秘密の方針');
  assert.equal(fs.readFileSync(outputFile, 'utf8'), original);
});
