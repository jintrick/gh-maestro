'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gh-maestro-setup.js');

// セットアップの副作用（git hooks 書き換え・.gitignore 追記・dev ブランチ作成・
// GitHub API での旧CIファイル削除）はすべて main() の内側に閉じており、
// require.main===module ガードで CLI 実行時のみ走る。
// ここでは実プロセス起動（subprocess）で本来の振る舞いを検証しつつ、
// require しただけでは何も起きないことも確認する。checkEnvironment
// （WEZTERM_PANE/wezterm/gh 依存）は .gh-maestro/setup-ok を事前に置いて
// isFirstRun=false にすることでスキップする。

function withGitProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-test-'));
  try {
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };
    git('init', '-q');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x', 'utf8');
    git('add', 'README.md');
    git('commit', '-qm', 'init');
    git('branch', '-m', 'main');
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'setup-ok'), '', 'utf8');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSetup(dir) {
  return spawnSync(process.execPath, [SCRIPT, dir], { cwd: dir, encoding: 'utf8' });
}

function readHook(dir, name) {
  return fs.readFileSync(path.join(dir, '.git', 'hooks', name), 'utf8');
}

test('新規プロジェクトにはsync-rulesフックのみを設置し、checksフックは設置しない', () => {
  withGitProject((dir) => {
    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.match(preCommit, /# gh-maestro:sync-rules:v1/);
    // Issue #283: フックからのテスト実行は廃止した。
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
    assert.doesNotMatch(preCommit, /run-checks/);

    assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')), false,
      'pre-push フックは作られないこと');
  });
});

test('既に設置済みのchecksブロックは撤去され、無関係なブロックは残る', () => {
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, [
      '#!/bin/sh',
      '# gh-maestro:checks:v1',
      'node "/somewhere/run-checks.js" precommit || exit 1',
      '',
      '# some-unrelated-marker',
      'echo unrelated-block-must-survive',
    ].join('\n') + '\n', 'utf8');

    const prePushPath = path.join(dir, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(prePushPath, [
      '#!/bin/sh',
      '# gh-maestro:checks:v1',
      'node "/somewhere/run-checks.js" prepush || exit 1',
    ].join('\n') + '\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
    assert.doesNotMatch(preCommit, /run-checks/);
    assert.match(preCommit, /# some-unrelated-marker/);
    assert.match(preCommit, /echo unrelated-block-must-survive/);

    const prePush = fs.readFileSync(prePushPath, 'utf8');
    assert.doesNotMatch(prePush, /gh-maestro:checks/);
    assert.doesNotMatch(prePush, /run-checks/);
  });
});

test('2回連続実行しても内容が変化しない（冪等）', () => {
  withGitProject((dir) => {
    assert.equal(runSetup(dir).status, 0);
    const preCommitFirst = readHook(dir, 'pre-commit');

    assert.equal(runSetup(dir).status, 0);
    assert.equal(readHook(dir, 'pre-commit'), preCommitFirst);
  });
});

test('旧バージョンマーカーのchecksブロックも撤去される', () => {
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, [
      '#!/bin/sh',
      '# gh-maestro:checks:v0',
      'echo old-behavior',
    ].join('\n') + '\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.doesNotMatch(preCommit, /old-behavior/);
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
  });
});

test('旧ブロックの行数が新エントリと異なっていても、後続の別ブロックを巻き込まずに置き換わる', () => {
  // 旧checksブロックは3行本文（新エントリは1行）、かつ直後に別ブロックが続く状態を
  // 再現し、splice範囲が「新エントリの行数」ではなく「旧ブロックの実際の範囲（次の
  // 空行まで）」で決まることを検証する（固定長splice方式だと後続ブロックの先頭行を
  // 誤って巻き込む/取りこぼす）。
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, [
      '#!/bin/sh',
      '# gh-maestro:checks:v0',
      'echo old-line-1',
      'echo old-line-2',
      'echo old-line-3',
      '',
      '# some-unrelated-marker',
      'echo unrelated-block-must-survive',
    ].join('\n') + '\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.doesNotMatch(preCommit, /old-line-1|old-line-2|old-line-3/);
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
    // 後続の無関係なブロックが誤って削られていないこと
    assert.match(preCommit, /# some-unrelated-marker/);
    assert.match(preCommit, /echo unrelated-block-must-survive/);
  });
});

test('手書きの既存pre-commitフックがあってもgh-maestroブロックを末尾に追記する', () => {
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho custom-user-hook\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.match(preCommit, /custom-user-hook/);
    assert.match(preCommit, /# gh-maestro:sync-rules:v1/);
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
  });
});

// ── require.main ガード ───────────────────────────────────────────────────────
// 実障害: 動作確認のつもりで require され、git hooks が書き換わった。
// このスクリプトは gh api DELETE（旧CIファイル削除）まで走りうるため、
// require が副作用ゼロであることは安全上の要件である。

test('require しただけでは副作用が起きない（git hooks を書き換えない）', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'setup-ok'), '');
    const hooksDir = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    // 別プロセスで require のみを行い、hooks が生成されないことを確認する
    const toPosix = (p) => p.split(path.sep).join('/');
    const probe = `
      process.chdir(${JSON.stringify(dir)});
      require(${JSON.stringify(toPosix(SCRIPT))});
      const fs = require('fs');
      const p = ${JSON.stringify(toPosix(path.join(hooksDir, 'pre-commit')))};
      console.log(JSON.stringify({ preCommitExists: fs.existsSync(p) }));
    `;
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: dir });

    assert.equal(r.status, 0, `require が失敗した: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.preCommitExists, false, 'require だけで pre-commit フックが作られてはならない');
  });
});

test('module.exports.main を公開する（CLI実行時のみ副作用を起こす）', () => {
  const scriptPosix = SCRIPT.split(path.sep).join('/');
  const r = spawnSync(process.execPath, [
    '-e', `const m = require(${JSON.stringify(scriptPosix)}); console.log(typeof m.main);`,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'function');
});
