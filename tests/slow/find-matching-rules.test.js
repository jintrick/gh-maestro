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

test('CLI: --help / -h はUsageを表示して終了コード0（--root と --ref を含む）', () => {
  withTempDir(dir => {
    for (const flag of ['--help', '-h']) {
      const r = runScript([flag], dir);
      assert.equal(r.status, 0, `${flag}: exit 0, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes('Usage'), `${flag}: stdout should include Usage`);
      assert.ok(r.stdout.includes('--root'), `${flag}: stdout should mention --root`);
      assert.ok(r.stdout.includes('--ref'), `${flag}: stdout should mention --ref`);
    }
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

function runGitIn(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

test('CLI: --ref 指定時の境界異常入力と未解決 ref は終了コード1・空stdoutで失敗する', () => {
  withTempDir(dir => {
    runGitIn(dir, ['init']);
    runGitIn(dir, ['config', 'user.email', 'test@example.com']);
    runGitIn(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Init\n');
    runGitIn(dir, ['add', 'README.md']);
    runGitIn(dir, ['commit', '-m', 'init']);

    for (const args of [
      ['--root', dir, '--ref'],
      ['--root', dir, '--ref', '', 'src/a.js'],
      ['--root', dir, '--ref', '-bad-option', 'src/a.js'],
      ['--root', dir, '--ref', '0000000000000000000000000000000000000000', 'src/a.js'],
    ]) {
      const r = runScript(args, dir);
      assert.notEqual(r.status, 0, `${JSON.stringify(args)} should fail`);
      assert.equal(r.stdout.trim(), '', `${JSON.stringify(args)} stdout must be empty`);
      assert.ok(r.stderr.trim().length > 0, `${JSON.stringify(args)} stderr must explain reason`);
    }
  });
});

test('CLI: 実Gitリポジトリで --ref <BASE_OID> は作業ツリー(head)ではなく base commit のルール(サブディレクトリ含む)を照合し --root と一致する', () => {
  withTempDir(repoDir => {
    runGitIn(repoDir, ['init']);
    runGitIn(repoDir, ['config', 'user.email', 'test@example.com']);
    runGitIn(repoDir, ['config', 'user.name', 'Test']);

    // Commit 1: .claude/rules/ 存在前
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo\n');
    runGitIn(repoDir, ['add', '.']);
    runGitIn(repoDir, ['commit', '-m', 'no rules yet']);
    const noRulesSha = runGitIn(repoDir, ['rev-parse', 'HEAD']);

    // Commit 2 (base): ルールあり（サブディレクトリ含む、pathsなし含む）
    fs.mkdirSync(path.join(repoDir, '.claude', 'rules', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.claude', 'rules', 'js-only.md'),
      '---\npaths:\n  - "src/**/*.js"\n---\n# Base JS rule\n');
    fs.writeFileSync(path.join(repoDir, '.claude', 'rules', 'nested', 'docs-only.md'),
      '---\npaths:\n  - "docs/**/*.md"\n---\n# Base Docs rule\n');
    fs.writeFileSync(path.join(repoDir, '.claude', 'rules', 'no-paths.md'),
      '---\nother: true\n---\n# No paths\n');
    runGitIn(repoDir, ['add', '.']);
    runGitIn(repoDir, ['commit', '-m', 'base rules']);
    const baseSha = runGitIn(repoDir, ['rev-parse', 'HEAD']);

    // base 状態を作業ツリーにも展開して --root 実行結果を独立比較用に取得
    const rootAtBase = runScript(['--root', repoDir, 'src/app.js', 'docs/guide.md'], os.tmpdir());
    assert.equal(rootAtBase.status, 0, rootAtBase.stderr);

    // Commit 3 (head): base のルールを削除・改変し、head 独自ルールを追加
    fs.unlinkSync(path.join(repoDir, '.claude', 'rules', 'js-only.md'));
    fs.writeFileSync(path.join(repoDir, '.claude', 'rules', 'head-only.md'),
      '---\npaths:\n  - "src/**/*.js"\n---\n# Head only rule\n');
    runGitIn(repoDir, ['add', '-A']);
    runGitIn(repoDir, ['commit', '-m', 'head tampers rules']);

    // head がチェックアウトされた作業ツリー上で --ref <baseSha> を実行
    const refAtBase = runScript(['--root', repoDir, '--ref', baseSha, 'src/app.js', 'docs/guide.md'], os.tmpdir());
    assert.equal(refAtBase.status, 0, refAtBase.stderr);
    assert.deepEqual(
      refAtBase.stdout.trim().split(/\r?\n/),
      ['.claude/rules/js-only.md', '.claude/rules/nested/docs-only.md'],
    );
    assert.equal(refAtBase.stdout, rootAtBase.stdout);

    // 0件一致時は exit 0・空出力
    const zeroMatch = runScript(['--root', repoDir, '--ref', baseSha, 'other/file.py'], os.tmpdir());
    assert.equal(zeroMatch.status, 0, zeroMatch.stderr);
    assert.equal(zeroMatch.stdout.trim(), '');

    // .claude/rules/ 不在コミットでも exit 0・空出力
    const noRulesRes = runScript(['--root', repoDir, '--ref', noRulesSha, 'src/app.js'], os.tmpdir());
    assert.equal(noRulesRes.status, 0, noRulesRes.stderr);
    assert.equal(noRulesRes.stdout.trim(), '');
  });
});
