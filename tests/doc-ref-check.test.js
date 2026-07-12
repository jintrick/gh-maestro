'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractMdRefs, resolveRefExists } = require('../scripts/shared/doc-ref-check');

const REPO_ROOT = path.resolve(__dirname, '..');

// docs/rag/ はベンダードの外部ツール参照ドキュメント（Claude Code/Antigravity/Codex/WezTerm等
// の公式ドキュメント抜粋）であり、このリポジトリのファイル構成とは無関係のパスを大量に
// 含むため対象外とする。
const EXCLUDED_DIRS = ['docs/rag'];

// 過去の設計・移行の経緯を記した完了済み計画書。文中の `*.md` 言及は、移行前に存在した
// 旧パスや、まだ実装されていない提案上のパスへの意図的な言及であり、リネーム漏れの
// 兆候ではないため対象外とする。
const EXCLUDED_FILES = [
  'docs/architect-plan.md',
  'docs/harmonic-finding-token.md',
  'docs/review-manager-plan.md',
];

function listMarkdownFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(rel)) continue;
      listMarkdownFiles(abs, out);
    } else if (entry.name.endsWith('.md')) {
      if (EXCLUDED_FILES.includes(rel)) continue;
      out.push(abs);
    }
  }
  return out;
}

function checkFiles(files) {
  const failures = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const refs = extractMdRefs(content);
    for (const ref of refs) {
      if (!resolveRefExists(REPO_ROOT, file, ref.target)) {
        failures.push(`${path.relative(REPO_ROOT, file)}:${ref.line} -> ${ref.target}`);
      }
    }
  }
  return failures;
}

// ── extractMdRefs ────────────────────────────────────────────────────────

test('extractMdRefs: Markdownリンクとインラインコードから.mdパスを抽出する', () => {
  const content = [
    '[foo](docs/foo.md) と `docs/bar/baz.md` を参照。',
  ].join('\n');
  const refs = extractMdRefs(content);
  const targets = refs.map((r) => r.target).sort();
  assert.deepEqual(targets, ['docs/bar/baz.md', 'docs/foo.md']);
});

test('extractMdRefs: テンプレート変数・ワイルドカード・URL・裸のファイル名は除外する', () => {
  const content = [
    '`{{SHARED_SKILLS_PATH}}/foo.md`',
    '`skills/*/SKILL.md`',
    '`<葉セレクタ>.md`',
    '[link](https://example.com/readme.md)',
    '[link](file:///C:/abs/path.md)',
    '`SKILL.md`',
    '`/tmp/issue-draft.md`',
  ].join('\n');
  assert.deepEqual(extractMdRefs(content), []);
});

// ── resolveRefExists ─────────────────────────────────────────────────────

test('resolveRefExists: 言及元ファイルからの相対パスを解決する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', 'target.md'), '# target');
    const sourceFile = path.join(tmpDir, 'sub', 'source.md');
    assert.equal(resolveRefExists(tmpDir, sourceFile, 'target.md'), true);
    assert.equal(resolveRefExists(tmpDir, sourceFile, 'missing.md'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRefExists: 祖先ディレクトリからの相対パスも解決する（スキルルート等）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'skill', 'correctness'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'skill', 'resilience'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'skill', 'correctness', 'concurrency.md'), '# c');
    const sourceFile = path.join(tmpDir, 'skill', 'resilience', 'failure.md');
    assert.equal(resolveRefExists(tmpDir, sourceFile, 'correctness/concurrency.md'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRefExists: リポジトリルートからの相対パスを解決する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'target.md'), '# target');
    const sourceFile = path.join(tmpDir, 'skills', 'foo', 'SKILL.md');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    assert.equal(resolveRefExists(tmpDir, sourceFile, 'docs/target.md'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── リポジトリ全体への検証 ────────────────────────────────────────────────

test('docs/**/*.md と skills/**/*.md 内の.md言及が実在するファイルを指している', () => {
  const files = [
    ...listMarkdownFiles(path.join(REPO_ROOT, 'docs'), []),
    ...listMarkdownFiles(path.join(REPO_ROOT, 'skills'), []),
  ];
  assert.ok(files.length > 0, 'ドキュメント/スキルファイルが1件も見つからなかった');
  const failures = checkFiles(files);
  assert.deepEqual(failures, [], `存在しないパスへの言及が見つかりました:\n${failures.join('\n')}`);
});

test('意図的に壊れたパスへの言及を含むフィクスチャで失敗を検出できる', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-fixture-'));
  try {
    const badFile = path.join(tmpDir, 'broken.md');
    fs.writeFileSync(
      badFile,
      '存在しないファイルへの言及: `docs/does-not-exist.md` および ' +
        '[リンク](also/missing.md)。\n',
    );
    const failures = checkFiles([badFile]);
    assert.equal(failures.length, 2);
    assert.ok(failures.some((f) => f.includes('docs/does-not-exist.md')));
    assert.ok(failures.some((f) => f.includes('also/missing.md')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
