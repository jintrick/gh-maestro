'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// run-review-manager.js の CLI 実行部は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない
// （.claude/rules/test-process-spawn-safety.md 準拠）。
const { resolveMode, buildPrompt, digestText, writeRunMetadata } = require('../scripts/run-review-manager');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'run-review-manager.js');

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

// ── CLI引数パース（scripts/shared/workspace.js の parseFlags に委譲） ─────────
// parseFlags 自体の網羅的なエッジケースは tests/workspace.test.js でカバー済み。
// ここでは実際のCLI起動でフラグ/値衝突が安全に処理される（誤ってhelp表示にならない）
// ことだけをサブプロセス経由で確認する。

test('サブプロセス経由: --help は終了コード0でUsageを表示する', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /run-review-manager\.js/);
});

test('サブプロセス経由: --brief-file の値が"--help"文字列だと値欠落エラーとなり、誤ってhelp表示にならない', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '5', 'o/r', 'C:\\ws', '--brief-file', '--help'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
  assert.equal(r.stdout, '');
});

test('writeRunMetadata does not touch any findings output file', () => {
  const outputFile = path.join(tmpBase, 'untouched-output.json');
  const original = JSON.stringify({ pr: 1, repo: 'o/r', headRefOid: 'abc', findings: [] });
  fs.writeFileSync(outputFile, original);
  writeRunMetadata(path.join(tmpBase, 'untouched.meta.json'), 'directed', '秘密の方針');
  assert.equal(fs.readFileSync(outputFile, 'utf8'), original);
});
