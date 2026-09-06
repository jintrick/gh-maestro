'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { globToRegex, matchesAny, findMatchingRules } = require('../../scripts/find-matching-rules');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'find-matching-rules.js');

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








// ── matchesAny ───────────────────────────────────────────────────────────────





// ── findMatchingRules ────────────────────────────────────────────────────────







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
