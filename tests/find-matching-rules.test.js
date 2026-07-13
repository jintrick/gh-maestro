'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { globToRegex, matchesAny, findMatchingRules } = require('../scripts/find-matching-rules');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'find-matching-rules.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-fmr-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runScript(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

// ── globToRegex ──────────────────────────────────────────────────────────────

test('globToRegex: **/*.js は多段ディレクトリの.jsにマッチする', () => {
  const re = globToRegex('scripts/**/*.js');
  assert.ok(re.test('scripts/foo.js'));
  assert.ok(re.test('scripts/sub/dir/deep.js'));
  assert.ok(!re.test('scripts/foo.ts'));
  assert.ok(!re.test('other/foo.js'));
});

test('globToRegex: ** 末尾は任意のパス全体にマッチする', () => {
  const re = globToRegex('scripts/**');
  assert.ok(re.test('scripts/foo.js'));
  assert.ok(re.test('scripts/sub/dir/file.ts'));
  assert.ok(re.test('scripts/'));
  assert.ok(!re.test('scripts'));
  assert.ok(!re.test('other/file.js'));
});

test('globToRegex: * は単一セグメント内の任意文字にマッチする', () => {
  const re = globToRegex('scripts/shared/*.js');
  assert.ok(re.test('scripts/shared/workspace.js'));
  assert.ok(re.test('scripts/shared/object.js'));
  assert.ok(!re.test('scripts/shared/sub/file.js'));
  assert.ok(!re.test('scripts/shared/file.ts'));
});

test('globToRegex: リテラルパスは完全一致', () => {
  const re = globToRegex('scripts/spawn-worker.js');
  assert.ok(re.test('scripts/spawn-worker.js'));
  assert.ok(!re.test('scripts/spawn-worker.ts'));
  assert.ok(!re.test('scripts/sub/spawn-worker.js'));
});

test('globToRegex: ドット始まりパスにマッチする', () => {
  const re = globToRegex('.claude/rules/**');
  assert.ok(re.test('.claude/rules/foo.md'));
  assert.ok(re.test('.claude/rules/sub/bar.md'));
});

test('globToRegex: ルート直下ファイルにマッチする', () => {
  const re = globToRegex('AGENTS.md');
  assert.ok(re.test('AGENTS.md'));
  assert.ok(!re.test('sub/AGENTS.md'));
});

test('globToRegex: 正規表現の特殊文字をエスケープする', () => {
  const re = globToRegex('test.+foo.js');
  assert.ok(re.test('test.+foo.js'));
  assert.ok(!re.test('testX+foo.js'));
});

// ── matchesAny ───────────────────────────────────────────────────────────────

test('matchesAny: いずれかのglobにマッチすればtrue', () => {
  const globs = ['scripts/**/*.js', 'skills/**/*.md'];
  assert.ok(matchesAny('scripts/foo.js', globs));
  assert.ok(matchesAny('skills/sub/doc.md', globs));
  assert.ok(!matchesAny('scripts/foo.ts', globs));
});

test('matchesAny: 空のglobs配列は常にfalse', () => {
  assert.ok(!matchesAny('any/file.js', []));
});

test('matchesAny: バックスラッシュパスを正規化する', () => {
  const globs = ['scripts/**/*.js'];
  assert.ok(matchesAny('scripts\\sub\\file.js', globs));
});

test('matchesAny: 単一globにマッチ', () => {
  assert.ok(matchesAny('CLAUDE.md', ['CLAUDE.md']));
});

// ── findMatchingRules ────────────────────────────────────────────────────────

test('findMatchingRules: .claude/rules/ がなければ空を返す', () => {
  withTempDir(dir => {
    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(matched, []);
    assert.deepEqual(errors, []);
  });
});

test('findMatchingRules: 空のrulesディレクトリは空を返す', () => {
  withTempDir(dir => {
    fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(matched, []);
    assert.deepEqual(errors, []);
  });
});

test('findMatchingRules: paths: にマッチするルールを返す', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'js-rules.md'),
      `---\npaths:\n  - "scripts/**/*.js"\n---\n# JS Rules`);
    fs.writeFileSync(path.join(rulesDir, 'md-rules.md'),
      `---\npaths:\n  - "docs/**/*.md"\n---\n# MD Rules`);

    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(errors, []);
    assert.ok(matched.includes('.claude/rules/js-rules.md'));
    assert.ok(!matched.includes('.claude/rules/md-rules.md'));
  });
});

test('findMatchingRules: 複数ファイル入力でいずれかにマッチするルールを返す', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'js-rules.md'),
      `---\npaths:\n  - "scripts/**/*.js"\n---\n# JS Rules`);
    fs.writeFileSync(path.join(rulesDir, 'md-rules.md'),
      `---\npaths:\n  - "docs/**/*.md"\n---\n# MD Rules`);
    fs.writeFileSync(path.join(rulesDir, 'all-rules.md'),
      `---\npaths:\n  - "scripts/**"\n  - "docs/**"\n---\n# All`);

    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js', 'docs/readme.md']);
    assert.deepEqual(errors, []);
    assert.ok(matched.includes('.claude/rules/js-rules.md'));
    assert.ok(matched.includes('.claude/rules/md-rules.md'));
    assert.ok(matched.includes('.claude/rules/all-rules.md'));
  });
});

test('findMatchingRules: paths: がないルールはスキップする', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'no-paths.md'),
      `---\nother: value\n---\n# No paths`);
    fs.writeFileSync(path.join(rulesDir, 'with-paths.md'),
      `---\npaths:\n  - "scripts/**"\n---\n# With paths`);

    const { matched } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.ok(!matched.includes('.claude/rules/no-paths.md'));
    assert.ok(matched.includes('.claude/rules/with-paths.md'));
  });
});

test('findMatchingRules: frontmatterなしのルールはスキップする', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'plain.md'), '# No frontmatter');

    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(matched, []);
    assert.deepEqual(errors, []);
  });
});

// ── CLI integration ──────────────────────────────────────────────────────────

test('CLI: --help はUsageを表示して終了コード0', () => {
  withTempDir(dir => {
    const r = runScript(['--help'], dir);
    assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage'), 'stdout should include Usage');
    assert.ok(r.stdout.includes('--root'), 'stdout should mention --root');
  });
});

test('CLI: -h も同様に終了コード0', () => {
  withTempDir(dir => {
    const r = runScript(['-h'], dir);
    assert.equal(r.status, 0, `exit 0, got ${r.status}`);
    assert.ok(r.stdout.includes('Usage'));
  });
});

test('CLI: ファイルパス引数がないと終了コード1でUsageエラー', () => {
  withTempDir(dir => {
    const r = runScript([], dir);
    assert.notEqual(r.status, 0, `should exit non-zero, got ${r.status}`);
    assert.ok(r.stderr.includes('ファイルパスを1つ以上指定してください'), `stderr: ${r.stderr}`);
  });
});

test('CLI: --root で指定したディレクトリのルールを検索する', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'test-rule.md'),
      `---\npaths:\n  - "src/**/*.ts"\n---\n# Test Rule`);

    const r = runScript(['--root', dir, 'src/foo.ts'], os.tmpdir());
    assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('.claude/rules/test-rule.md'), `stdout: ${r.stdout}`);
  });
});

test('CLI: マッチなしは空出力で終了コード0', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'test-rule.md'),
      `---\npaths:\n  - "src/**/*.ts"\n---\n# Test Rule`);

    const r = runScript(['--root', dir, 'other/file.py'], os.tmpdir());
    assert.equal(r.status, 0, `exit 0, got ${r.status}`);
    assert.equal(r.stdout.trim(), '');
  });
});

test('CLI: .claude/rules/ がなくてもエラー終了せず空出力でexit 0', () => {
  withTempDir(dir => {
    const r = runScript(['--root', dir, 'scripts/foo.js'], dir);
    assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '');
  });
});
