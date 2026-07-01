'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { parseFrontmatter, toAgyFrontmatter } = require('../scripts/sync-rules');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'sync-rules.js');

function withProject(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-sync-test-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runScript(cwd) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
}

// ── parseFrontmatter ──────────────────────────────────────────────────────────

test('parseFrontmatter: paths: を正しく抽出する', () => {
  const content = `---\npaths:\n  - "scripts/**/*.js"\n---\n\nbody`;
  const { paths, body } = parseFrontmatter(content);
  assert.deepEqual(paths, ['scripts/**/*.js']);
  assert.equal(body, '\nbody');
});

test('parseFrontmatter: 複数の paths: を抽出する', () => {
  const content = `---\npaths:\n  - "src/**/*.js"\n  - "lib/**/*.js"\n---\nbody`;
  const { paths } = parseFrontmatter(content);
  assert.deepEqual(paths, ['src/**/*.js', 'lib/**/*.js']);
});

test('parseFrontmatter: frontmatter なしは paths: null を返す', () => {
  const { paths, body } = parseFrontmatter('just body');
  assert.equal(paths, null);
  assert.equal(body, 'just body');
});

test('parseFrontmatter: paths: のない frontmatter は null を返す', () => {
  const content = `---\nother: value\n---\nbody`;
  const { paths } = parseFrontmatter(content);
  assert.equal(paths, null);
});

test('parseFrontmatter: CRLF 改行でも正しく動作する', () => {
  const content = `---\r\npaths:\r\n  - "src/**/*.js"\r\n---\r\nbody`;
  const { paths } = parseFrontmatter(content);
  assert.deepEqual(paths, ['src/**/*.js']);
});

// ── toAgyFrontmatter ──────────────────────────────────────────────────────────

test('toAgyFrontmatter: trigger: glob 形式を生成する', () => {
  const result = toAgyFrontmatter(['scripts/**/*.js'], 'test.md');
  assert.equal(result, '---\ntrigger: glob\nglobs: scripts/**/*.js\n---\n');
});

test('toAgyFrontmatter: 複数 paths はカンマ区切りになる', () => {
  const result = toAgyFrontmatter(['src/**/*.js', 'lib/**/*.js'], 'test.md');
  assert.equal(result, '---\ntrigger: glob\nglobs: src/**/*.js,lib/**/*.js\n---\n');
});

test('toAgyFrontmatter: paths なしはエラー終了する', () => {
  assert.throws(() => toAgyFrontmatter(null, 'bad.md'), /bad\.md/);
});

test('toAgyFrontmatter: 空配列もエラー終了する', () => {
  assert.throws(() => toAgyFrontmatter([], 'bad.md'), /bad\.md/);
});

// ── syncRules (integration) ───────────────────────────────────────────────────

test('syncRules: .claude/rules/ を .agents/rules/ に同期する', () => {
  withProject(base => {
    const src = path.join(base, '.claude', 'rules');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'rule.md'),
      `---\npaths:\n  - "src/**/*.js"\n---\n\nbody text`);

    const r = runScript(base);
    assert.equal(r.status, 0, r.stderr);

    const dst = path.join(base, '.agents', 'rules', 'rule.md');
    assert.ok(fs.existsSync(dst));
    const out = fs.readFileSync(dst, 'utf8');
    assert.ok(out.startsWith('---\ntrigger: glob\nglobs: src/**/*.js\n---\n'));
    assert.ok(out.includes('body text'));
  });
});

test('syncRules: .agents/rules/ の孤児ファイルを削除する', () => {
  withProject(base => {
    const src = path.join(base, '.claude', 'rules');
    const dst = path.join(base, '.agents', 'rules');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(src, 'rule.md'),
      `---\npaths:\n  - "src/**/*.js"\n---\nbody`);
    fs.writeFileSync(path.join(dst, 'orphan.md'), 'old content');

    const r = runScript(base);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(dst, 'orphan.md')));
  });
});

test('syncRules: .claude/rules/ がなければエラー終了する', () => {
  withProject(base => {
    const r = runScript(base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\.claude\/rules/);
  });
});

test('syncRules: paths: なしのファイルはエラー終了する', () => {
  withProject(base => {
    const src = path.join(base, '.claude', 'rules');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'bad.md'), '# no frontmatter');

    const r = runScript(base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bad\.md/);
  });
});
