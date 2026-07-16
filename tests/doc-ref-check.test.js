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
  'docs/agent-launch-mechanism-plan.md',
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
      if (!resolveRefExists(REPO_ROOT, file, ref.target, { isAbsolute: ref.isAbsolute })) {
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

test('extractMdRefs: 先頭 ./ や ../ を含む相対パス表記も抽出する', () => {
  const content = '`.claude/rules/queue-path-safety.md` と `../foo/bar.md` を参照。';
  const refs = extractMdRefs(content);
  const targets = refs.map((r) => r.target).sort();
  assert.deepEqual(targets, ['../foo/bar.md', '.claude/rules/queue-path-safety.md']);
});

test('extractMdRefs: 日本語・パーセントエンコードされたアンカーを含むパスを抽出する', () => {
  const content = '`docs/foo.md#概要` と `docs/bar.md#%E6%A6%82%E8%A6%81` を参照。';
  const refs = extractMdRefs(content);
  const targets = refs.map((r) => r.target).sort();
  assert.deepEqual(targets, ['docs/bar.md#%E6%A6%82%E8%A6%81', 'docs/foo.md#概要']);
});

test('extractMdRefs: テンプレート変数・ワイルドカード・その他URLスキームは除外する', () => {
  const content = [
    '`{{SHARED_SKILLS_PATH}}/foo.md`',
    '`skills/*/SKILL.md`',
    '`<葉セレクタ>.md`',
    '[link](https://example.com/readme.md)',
    '`/tmp/issue-draft.md`',
    '`.md`',
  ].join('\n');
  assert.deepEqual(extractMdRefs(content), []);
});

test('extractMdRefs: file:///... リンクはisAbsoluteフラグ付きで抽出する', () => {
  const content = '[resolve-config.js](file:///C:/Users/amg/work/gh-maestro/scripts/shared/resolve-config.js.md#L1)';
  const refs = extractMdRefs(content);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].isAbsolute, true);
});

test('extractMdRefs: 裸のファイル名も抽出する（祖先ディレクトリ基準の解決はresolveRefExistsに委ねる）', () => {
  const content = '`SKILL.md`と`logic-invariants.md`';
  const refs = extractMdRefs(content);
  const targets = refs.map((r) => r.target).sort();
  assert.deepEqual(targets, ['SKILL.md', 'logic-invariants.md']);
});

test('extractMdRefs: 大きなファイルでも行番号を正しく計算する', () => {
  const filler = 'x'.repeat(5000) + '\n';
  const content = filler.repeat(2000) + '`docs/target.md`\n';
  const refs = extractMdRefs(content);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].line, 2001);
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

test('resolveRefExists: 祖先ディレクトリからの相対パスも解決する（スキルルート・裸のファイル名等）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'skill', 'correctness'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'skill', 'resilience'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'skill', 'correctness', 'concurrency.md'), '# c');
    const sourceFile = path.join(tmpDir, 'skill', 'resilience', 'failure.md');
    assert.equal(resolveRefExists(tmpDir, sourceFile, 'correctness/concurrency.md'), true);

    fs.writeFileSync(path.join(tmpDir, 'skill', 'sibling.md'), '# sibling');
    const nested = path.join(tmpDir, 'skill', 'resilience', 'failure.md');
    assert.equal(resolveRefExists(tmpDir, nested, 'sibling.md'), true);
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

test('resolveRefExists: file:///... 由来の絶対パスをリポジトリ配下として解決する（isAbsolute）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'scripts', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'scripts', 'shared', 'resolve-config.md'), '# rc');
    const sourceFile = path.join(tmpDir, 'docs', 'plan.md');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    const absPath = 'C:/Users/someone-else/work/gh-maestro/scripts/shared/resolve-config.md';
    assert.equal(resolveRefExists(tmpDir, sourceFile, absPath, { isAbsolute: true }), true);
    assert.equal(
      resolveRefExists(tmpDir, sourceFile, 'C:/Users/someone-else/work/gh-maestro/scripts/missing.md', { isAbsolute: true }),
      false,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRefExists: repoRoot外へのpath traversalは拒否する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-doc-ref-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-outside-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    const sourceFile = path.join(tmpDir, 'docs', 'plan.md');
    fs.writeFileSync(path.join(outsideDir, 'target.md'), '# outside');

    const depth = tmpDir.split(path.sep).length + 2;
    const escapePath = '../'.repeat(depth) + outsideDir.split(path.sep).join('/').replace(/^\//, '') + '/target.md';
    assert.equal(resolveRefExists(tmpDir, sourceFile, escapePath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
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
        '[リンク](also/missing.md)。\n' +
        '存在しない旧パス: `.claude/rules/queue-path-safety.md`。\n',
    );
    const failures = checkFiles([badFile]);
    assert.equal(failures.length, 3);
    assert.ok(failures.some((f) => f.includes('docs/does-not-exist.md')));
    assert.ok(failures.some((f) => f.includes('also/missing.md')));
    assert.ok(failures.some((f) => f.includes('.claude/rules/queue-path-safety.md')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('妥当な既存パスへの言及は検出しない（.claude/rules/git-arg-injection.md）', () => {
  const goodFile = path.join(REPO_ROOT, 'docs', 'github-comm-plan.md');
  const content = fs.readFileSync(goodFile, 'utf8');
  const refs = extractMdRefs(content).filter((r) => r.target.includes('git-arg-injection.md'));
  assert.ok(refs.length > 0, 'git-arg-injection.mdへの言及が見つからなかった');
  for (const ref of refs) {
    assert.equal(resolveRefExists(REPO_ROOT, goodFile, ref.target, { isAbsolute: ref.isAbsolute }), true);
  }
});
