'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFrontmatter, extractBody, resolveIncludes } = require('../lib/compile-reviewers-utils');

// ── 純粋関数のユニットテスト ─────────────────────────────────────────────────

test('parseFrontmatter: max-turnsを正しく読む', () => {
  const md = '---\nmax-turns: 42\ntitle: test\n---\nbody';
  const fm = parseFrontmatter(md);
  assert.equal(fm['max-turns'], '42');
  assert.equal(fm['title'], 'test');
});

test('parseFrontmatter: frontmatterがなければ空オブジェクトを返す', () => {
  const fm = parseFrontmatter('no frontmatter here');
  assert.deepEqual(fm, {});
});

test('parseFrontmatter: 区切り線が1つだけの場合も空オブジェクト', () => {
  const fm = parseFrontmatter('---\nonly one delimiter');
  assert.deepEqual(fm, {});
});

test('extractBody: frontmatterを除いたbodyを返す', () => {
  const md = '---\nkey: val\n---\n# Hello\nWorld';
  assert.equal(extractBody(md), '# Hello\nWorld');
});

test('extractBody: frontmatterがなければエラー', () => {
  assert.throws(() => extractBody('no frontmatter'), /Expected two --- delimiters/);
});

test('resolveIncludes: {{#include}} ディレクティブを展開する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-compile-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'shared.md'), 'shared content');
    const body = 'before\n{{#include shared.md}}\nafter';
    const result = resolveIncludes(body, tmpDir);
    assert.equal(result, 'before\nshared content\nafter');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveIncludes: 存在しないincludeはエラー', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-compile-test-'));
  try {
    assert.throws(
      () => resolveIncludes('{{#include nonexistent.md}}', tmpDir),
      /Include not found/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── MAX_TURNS置換の統合テスト ─────────────────────────────────────────────────

test('compile-reviewers.js: MAX_TURNSがfrontmatterのmax-turnsで置換される', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-compile-test-'));
  try {
    // shared/reviewer-output-policy.md を模倣
    const sharedDir = path.join(tmpDir, 'shared');
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(
      path.join(sharedDir, 'policy.md'),
      '**ターン予算: 最大{{MAX_TURNS}}ターン。**'
    );

    // md source ファイル
    const mdContent = [
      '---',
      'max-turns: 25',
      '---',
      '# フォーマット',
      '{{#include shared/policy.md}}',
    ].join('\n');

    const fm = parseFrontmatter(mdContent);
    assert.equal(fm['max-turns'], '25');

    const body = extractBody(mdContent);
    const resolved = resolveIncludes(body, tmpDir).replace(/\{\{MAX_TURNS\}\}/g, fm['max-turns'] || '30');

    assert.ok(resolved.includes('最大25ターン'), `resolved: ${resolved}`);
    assert.ok(!resolved.includes('{{MAX_TURNS}}'), '{{MAX_TURNS}}が残っている');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('compile-reviewers.js: max-turnsが未定義なら30にフォールバック', () => {
  const md = '---\ntitle: no-max-turns\n---\nbody {{MAX_TURNS}}';
  const fm = parseFrontmatter(md);
  const maxTurns = fm['max-turns'] || '30';
  assert.equal(maxTurns, '30');
});

// ── 実際のワークフローファイルに対する統合テスト ──────────────────────────────

const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');
const REVIEWER_NAMES = ['reviewer-correctness', 'reviewer-maintainability', 'reviewer-resilience'];

for (const name of REVIEWER_NAMES) {
  test(`${name}.lock.yml: MAX_TURNSプレースホルダーが残っていない`, () => {
    const lockPath = path.join(WORKFLOWS_DIR, `${name}.lock.yml`);
    if (!fs.existsSync(lockPath)) return; // ファイルがない場合はスキップ
    const content = fs.readFileSync(lockPath, 'utf8');
    assert.ok(!content.includes('{{MAX_TURNS}}'), `${name}.lock.yml に {{MAX_TURNS}} が残っている`);
  });

  test(`${name}.lock.yml: --max-turnsフラグが数値を持つ`, () => {
    const lockPath = path.join(WORKFLOWS_DIR, `${name}.lock.yml`);
    if (!fs.existsSync(lockPath)) return;
    const content = fs.readFileSync(lockPath, 'utf8');
    assert.match(content, /--max-turns \d+/, `${name}.lock.yml に --max-turns が見つからない`);
  });

  test(`${name}.md: max-turnsフロントマターと--max-turnsフラグが一致する`, () => {
    const mdPath   = path.join(WORKFLOWS_DIR, `${name}.md`);
    const lockPath = path.join(WORKFLOWS_DIR, `${name}.lock.yml`);
    if (!fs.existsSync(mdPath) || !fs.existsSync(lockPath)) return;

    const mdContent   = fs.readFileSync(mdPath, 'utf8');
    const lockContent = fs.readFileSync(lockPath, 'utf8');

    const fm = parseFrontmatter(mdContent);
    const expectedTurns = fm['max-turns'] || '30';

    const flagMatch = lockContent.match(/--max-turns (\d+)/);
    assert.ok(flagMatch, `${name}.lock.yml に --max-turns が見つからない`);
    assert.equal(flagMatch[1], expectedTurns,
      `frontmatterのmax-turns(${expectedTurns})とlock.ymlの--max-turns(${flagMatch[1]})が不一致`);
  });
}
