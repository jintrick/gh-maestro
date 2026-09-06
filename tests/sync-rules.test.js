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
  const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return fn(base);
  } finally {
    if (savedWorkspace !== undefined) process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    else delete process.env.GH_MAESTRO_WORKSPACE;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function withGitWorkspace(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-sync-rules-git-'));
  const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    const git = (...args) => {
      const env = { ...process.env };
      delete env.GH_MAESTRO_WORKSPACE;
      const r = spawnSync('git', args, { cwd: base, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };
    git('init', '-q');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'test');
    fs.mkdirSync(path.join(base, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(base, 'README.md'), 'init');
    git('add', 'README.md');
    git('commit', '-qm', 'init');
    return fn(base);
  } finally {
    if (savedWorkspace !== undefined) process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    else delete process.env.GH_MAESTRO_WORKSPACE;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runScript(cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.GH_MAESTRO_WORKSPACE;
  return spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
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

// ── --help ───────────────────────────────────────────────────────────────────


// ── syncRules (integration) ───────────────────────────────────────────────────
