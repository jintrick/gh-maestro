'use strict';

const { test } = require('node:test');
const { createFakeGh } = require('../helpers/fake-gh');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'gh-maestro-setup.js');
const setupModule = require(SCRIPT);

// セットアップの副作用（git hooks 書き換え・.git/info/exclude 追記・dev ブランチ作成・
// GitHub API での旧CIファイル削除）はすべて main() の内側に閉じており、
// require.main===module ガードで CLI 実行時のみ走る。
// ここでは実プロセス起動（subprocess）で本来の振る舞いを検証しつつ、
// require しただけでは何も起きないことも確認する。checkEnvironment
// （WEZTERM_PANE/wezterm/gh 依存）は .gh-maestro/setup-ok を事前に置いて
// isFirstRun=false にすることでスキップする。

function withGitProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-test-'));
  try {
    ensureGitTemplate();
    fs.cpSync(gitTemplate, dir, { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let gitTemplate;
let gitOrigin;
function ensureGitTemplate() {
  if (gitTemplate) return;
  gitTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-template-'));
  gitOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-origin-'));
  const origin = spawnSync('git', ['init', '--bare', '-q'], { cwd: gitOrigin, encoding: 'utf8' });
  assert.equal(origin.status, 0, `git init --bare failed: ${origin.stderr}`);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: gitTemplate, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };
  git('init', '-q');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(gitTemplate, 'README.md'), 'x', 'utf8');
  git('add', 'README.md');
  git('commit', '-qm', 'init');
  git('branch', '-m', 'main');
  git('remote', 'add', 'origin', gitOrigin);
  git('push', '-q', 'origin', 'main');
  git('branch', 'dev');
  git('push', '-q', 'origin', 'dev');
  fs.mkdirSync(path.join(gitTemplate, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(gitTemplate, '.gh-maestro', 'setup-ok'), '', 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(gitTemplate, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(gitOrigin, { recursive: true, force: true }); } catch {}
  });
}

function runSetup(dir) {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  const scriptModule = require.resolve(SCRIPT);
  process.argv = [process.execPath, SCRIPT, dir];
  console.log = (...args) => { stdout += `${args.join(' ')}\n`; };
  console.warn = (...args) => { stderr += `${args.join(' ')}\n`; };
  console.error = (...args) => { stderr += `${args.join(' ')}\n`; };
  process.exit = (code = 0) => {
    const error = new Error(`process.exit(${code})`);
    error.exitCode = code;
    throw error;
  };
  try {
    delete require.cache[scriptModule];
    require(scriptModule).main();
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (error && Number.isInteger(error.exitCode)) {
      return { status: error.exitCode, stdout, stderr };
    }
    throw error;
  } finally {
    delete require.cache[scriptModule];
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

// 少なくとも1件は実CLIのargv・require.main経路を維持する。その他の成功系は
// 同じ main() をテストプロセス内で呼び、各ケースのGit fixtureと副作用の検証を
// 残したままNodeプロセス起動の固定費だけを省く。
function runSetupCli(dir, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, dir], { cwd: dir, env, encoding: 'utf8' });
}

test('初回setupは成功確認行を表示し、後続実行用sentinelを作る', () => {
  withGitProject((dir) => {
    const sentinel = path.join(dir, '.gh-maestro', 'setup-ok');
    fs.unlinkSync(sentinel);
    gitIn(dir, 'config', 'remote.origin.url', 'https://github.com/example/gh-maestro-test.git');

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm setup first-run bin with spaces-'));
    try {
      const fakeAuthStatusCall = path.join(binDir, 'fake-gh-auth-status.called');
      const baseEnv = { ...process.env };
      delete baseEnv.NODE_TEST_CONTEXT;
      const fakeGh = createFakeGh({
        binDir,
        baseEnv,
        extraEnv: { WEZTERM_PANE: 'first-run-test-pane' },
        fixtures: [{ match: ['auth', 'status'], action: 'write-marker', markerPath: fakeAuthStatusCall }],
      });
      const fakeVersion = path.join(binDir, process.platform === 'win32' ? 'wezterm.exe' : 'wezterm');
      fs.copyFileSync(process.execPath, fakeVersion);
      if (process.platform !== 'win32') fs.chmodSync(fakeVersion, 0o755);
      const env = fakeGh.env;

      const r = runSetupCli(dir, env);

      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(fs.existsSync(fakeAuthStatusCall), '初回のgh auth statusでfake ghを実行すること');
      assert.match(r.stdout, /\x1b\[32mv Repository:/);
      assert.match(r.stdout, /\x1b\[32mv \.gh-maestro\/worktrees directory ready/);
      assert.ok(fs.existsSync(sentinel), '初回成功後に setup-ok を作成すること');

      fs.rmSync(fakeAuthStatusCall, { force: true });
      const rerun = runSetupCli(dir, env);
      assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
      assert.doesNotMatch(rerun.stdout, /\x1b\[32mv /, 'sentinel後は成功確認行を抑止する');
      assert.ok(fs.existsSync(sentinel), '後続実行でも setup-ok を維持すること');
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

test('git問い合わせ: core.hooksPathの未設定と問い合わせ不能（status=null）を区別する', () => {
  const unavailable = setupModule.gitOutput(
    ['config', '--get', 'core.hooksPath'],
    () => ({ status: null, error: { message: 'git spawn failed' }, stdout: '', stderr: '' }),
  );
  assert.deepEqual(unavailable, { status: 'unavailable', detail: 'git spawn failed' });

  const unset = setupModule.gitOutput(
    ['config', '--get', 'core.hooksPath'],
    () => ({ status: 1, stdout: '', stderr: '' }),
  );
  assert.deepEqual(unset, { status: 'unset', value: '' });

  assert.throws(
    () => setupModule.resolveHooksDir(
      (cmd, args) => args[0] === 'config'
        ? { status: null, error: { message: 'git spawn failed' }, stdout: '', stderr: '' }
        : { status: 0, stdout: '.git\n', stderr: '' },
    ),
    /core\.hooksPath の問い合わせに失敗しました: git spawn failed/,
    '判定不能なhooksPathを既定.git/hooksへ縮退させてはならない',
  );
});

test('テスト実行中のWezTerm前提チェック拒否はsetupの失敗として顕在化し、未処理例外にならない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-wezterm-guard-'));
  try {
    const env = { ...process.env, NODE_TEST_CONTEXT: 'node-test', WEZTERM_PANE: 'test-pane' };
    delete env.GH_MAESTRO_DISABLE_REAL_SPAWN;
    const r = spawnSync(process.execPath, [SCRIPT, dir], { cwd: dir, env, encoding: 'utf8' });

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /WezTermを起動しません.*NODE_TEST_CONTEXT/);
    assert.match(r.stderr, /wezterm CLI が PATH に見つかりません/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// withGitProject の内側で git を実行する（失敗時 assert）。
function gitIn(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

function setBareOriginHead(branch) {
  const r = spawnSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
    cwd: gitOrigin,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git symbolic-ref HEAD ${branch} failed: ${r.stderr}`);
}

function prepareProjectWithoutDev(dir, defaultBranch) {
  gitIn(dir, 'branch', '-D', 'dev');
  const remoteDev = gitIn(dir, 'ls-remote', '--heads', 'origin', 'dev');
  if (remoteDev.stdout.trim()) {
    gitIn(dir, 'push', '-q', 'origin', '--delete', 'dev');
  }
  if (defaultBranch !== 'main') {
    gitIn(dir, 'branch', '-m', 'main', defaultBranch);
    gitIn(dir, 'push', '-q', 'origin', defaultBranch);
  }
  assert.equal(gitIn(dir, 'branch', '--show-current').stdout.trim(), defaultBranch);
}

function addMasterOnlyCommit(dir) {
  gitIn(dir, 'branch', 'master');
  fs.writeFileSync(path.join(dir, 'master-only.txt'), 'master', 'utf8');
  gitIn(dir, 'add', 'master-only.txt');
  gitIn(dir, 'commit', '-qm', 'master-only');
  gitIn(dir, 'checkout', 'master');
}

// 追跡下・無視対象でない .githooks に手書きの同期フック（マーカー無し・相対パス）を置く。
function setUpTrackedGithooks(dir) {
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), [
    '#!/bin/sh',
    "if git diff --cached --name-only | grep -q '^\\.claude/rules/'; then",
    '  node scripts/sync-rules.js || exit 1',
    'fi',
    '',
  ].join('\n'), 'utf8');
  gitIn(dir, 'add', '.githooks');
  gitIn(dir, 'commit', '-qm', 'track githooks');
}

function readHook(dir, name) {
  return fs.readFileSync(path.join(dir, '.git', 'hooks', name), 'utf8');
}

test('新規プロジェクトにはsync-rulesフックのみを設置し、checksフックは設置しない', () => {
  withGitProject((dir) => {
    const r = runSetupCli(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.match(preCommit, /# gh-maestro:sync-rules:v2/);
    // Issue #283: フックからのテスト実行は廃止した。
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
    assert.doesNotMatch(preCommit, /run-checks/);
    // Issue #419: AGENTS.md と CLAUDE.md の同期ブロックは設置しない。
    assert.doesNotMatch(preCommit, /sync-agents-md\.js/);
    assert.doesNotMatch(preCommit, /git add CLAUDE\.md/);

    assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')), false,
      'pre-push フックは作られないこと');
  });
});

test('既定ブランチがmainでなくてもmasterからdevブランチを作成する', () => {
  withGitProject((dir) => {
    prepareProjectWithoutDev(dir, 'master');
    setBareOriginHead('master');

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Creating 'dev' branch from master/);
    assert.equal(
      gitIn(dir, 'rev-parse', 'dev').stdout.trim(),
      gitIn(dir, 'rev-parse', 'master').stdout.trim(),
      'devは現在のmasterから作成されること',
    );
  });
});

test('既定ブランチがmainの場合はmainからdevブランチを作成する', () => {
  withGitProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    setBareOriginHead('main');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Creating 'dev' branch from main/);
    assert.equal(
      gitIn(dir, 'rev-parse', 'dev').stdout.trim(),
      gitIn(dir, 'rev-parse', 'main').stdout.trim(),
      'devはmainから作成されること',
    );
  });
});

test('devブランチが無く別ブランチにコミット前の変更があっても、作業ブランチを切り替えず変更に触れずにdevを作成する', () => {
  withGitProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    setBareOriginHead('main');

    gitIn(dir, 'checkout', '-qb', 'ui/design-system');
    fs.writeFileSync(path.join(dir, 'README.md'), 'feature-base\n', 'utf8');
    gitIn(dir, 'add', 'README.md');
    gitIn(dir, 'commit', '-qm', 'feature commit');

    fs.writeFileSync(path.join(dir, 'README.md'), 'uncommitted-edit\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged-content\n', 'utf8');
    gitIn(dir, 'add', 'staged.txt');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked-content\n', 'utf8');

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(gitIn(dir, 'branch', '--show-current').stdout.trim(), 'ui/design-system');
    assert.equal(
      gitIn(dir, 'rev-parse', 'dev').stdout.trim(),
      gitIn(dir, 'rev-parse', 'main').stdout.trim(),
      'devは作業ブランチではなくmainから作成されること',
    );
    assert.notEqual(
      gitIn(dir, 'ls-remote', '--heads', 'origin', 'dev').stdout.trim(),
      '',
      'origin/devがpushされること',
    );
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'uncommitted-edit\n');
    assert.equal(gitIn(dir, 'diff', '--cached', '--name-only').stdout.trim(), 'staged.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'untracked-content\n');
  });
});

test('mainとmasterの両方がある場合はdevを作成せず停止する', () => {
  withGitProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    addMasterOnlyCommit(dir);
    setBareOriginHead('main');

    const r = runSetup(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /'main' と 'master' の両方が存在するため、分岐元を決定できませんでした/);
    assert.equal(gitIn(dir, 'branch', '--list', 'dev').stdout.trim(), '');
    assert.equal(gitIn(dir, 'branch', '--show-current').stdout.trim(), 'master');
    assert.doesNotMatch(r.stdout, /Branch 'dev' exists/);
  });
});

test('mainとmasterのどちらも無い場合はdevを作成せず停止する', () => {
  withGitProject((dir) => {
    prepareProjectWithoutDev(dir, 'feature');

    const r = runSetup(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /'main' と 'master' のどちらも見つかりませんでした/);
    assert.equal(gitIn(dir, 'branch', '--list', 'dev').stdout.trim(), '');
    assert.equal(gitIn(dir, 'branch', '--show-current').stdout.trim(), 'feature');
    assert.doesNotMatch(r.stdout, /Branch 'dev' exists/);
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

    // checks撤去後に実コマンドが残らない pre-push は抜け殻として削除される。
    assert.equal(fs.existsSync(prePushPath), false, 'checks撤去後に空になった pre-push は削除される');
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
    assert.match(preCommit, /# gh-maestro:sync-rules:v2/);
    assert.doesNotMatch(preCommit, /gh-maestro:checks/);
  });
});

// ── core.hooksPath（git が実際に使うフック置き場）への対応 ─────────────────────

test('core.hooksPathが追跡下の.githooksを指し必要な呼び出しが揃っていれば、書き込まず導入済みと報告し、死んだ既定フックを削除する', () => {
  withGitProject((dir) => {
    setUpTrackedGithooks(dir);
    // 既定 .git/hooks に死んだフックを残す（このリポジトリ相当）
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\n# gh-maestro:sync-rules:v1\nnode "/x/sync-rules.js"\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'),
      '#!/bin/sh\n', 'utf8');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks');

    const before = fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8');
    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    // 追跡下フックは書き換えない（共有物を汚さない）
    assert.equal(fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8'), before);
    // 実行されない既定置き場の死んだフックは削除される
    assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), false);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')), false);
  });
});

test('core.hooksPathが追跡下の.githooksを指すがsync-rules呼び出しが無い場合、未導入と警告し書き換えない', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), [
      '#!/bin/sh',
      "if git diff --cached --name-only | grep -q '^AGENTS\\.md$'; then",
      '  echo old AGENTS synchronization',
      'fi',
      '',
    ].join('\n'), 'utf8');
    gitIn(dir, 'add', '.githooks');
    gitIn(dir, 'commit', '-qm', 'track githooks');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks');

    const before = fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8');
    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    assert.equal(fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8'), before);
    assert.match(r.stderr, /未導入/);
    assert.match(r.stderr, /sync-rules 呼び出し/);
    assert.doesNotMatch(r.stderr, /sync-agents-md/);
    assert.match(r.stderr, /追記してください/);
  });
});

test('core.hooksPathが追跡下・無視対象でない空ディレクトリを指す場合、書き込まず未導入を警告する（絶対パス汚染を防ぐ）', () => {
  withGitProject((dir) => {
    // 新規プロジェクトが規約導入直後で、hooksPath の指すディレクトリがまだ何も含まない状態
    fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    gitIn(dir, 'config', 'core.hooksPath', '.githooks');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    assert.equal(fs.existsSync(path.join(dir, '.githooks', 'pre-commit')), false,
      '空の共有リスクディレクトリに絶対パス入りファイルを書き込んではならない');
    assert.match(r.stderr, /未導入/);
  });
});

test('core.hooksPathがgit無視対象のディレクトリを指す場合、そこに従来どおり設置する', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.githooks-ignored'), { recursive: true });
    fs.appendFileSync(path.join(dir, '.gitignore'), '.githooks-ignored/\n');
    gitIn(dir, 'add', '.gitignore');
    gitIn(dir, 'commit', '-qm', 'ignore githooks-ignored');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks-ignored');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const hook = fs.readFileSync(path.join(dir, '.githooks-ignored', 'pre-commit'), 'utf8');
    assert.match(hook, /# gh-maestro:sync-rules:v2/);
    assert.doesNotMatch(hook, /sync-agents-md\.js/);
    assert.doesNotMatch(hook, /git add CLAUDE\.md/);
  });
});

test('core.hooksPathがワークツリー外（絶対パス）を指す場合、そこに従来どおり設置する', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-outside-hooks-'));
  try {
    withGitProject((dir) => {
      gitIn(dir, 'config', 'core.hooksPath', outside);
      const r = runSetup(dir);
      assert.equal(r.status, 0, r.stderr);
      const hook = fs.readFileSync(path.join(outside, 'pre-commit'), 'utf8');
      assert.match(hook, /# gh-maestro:sync-rules:v2/);
      assert.doesNotMatch(hook, /sync-agents-md\.js/);
      assert.doesNotMatch(hook, /git add CLAUDE\.md/);
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('死んだ既定フックからgh-maestroブロックだけ撤去し、無関係なユーザーフックの中身は残す', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), [
      '#!/bin/sh',
      '# gh-maestro:sync-rules:v1',
      'node "/x/sync-rules.js"',
      '',
      '# user-hook',
      'echo keep-me',
    ].join('\n') + '\n', 'utf8');
    // アクティブ置き場を別の git 無視対象ディレクトリへ切り替える
    fs.mkdirSync(path.join(dir, '.githooks-active'), { recursive: true });
    fs.appendFileSync(path.join(dir, '.gitignore'), '.githooks-active/\n');
    gitIn(dir, 'add', '.gitignore');
    gitIn(dir, 'commit', '-qm', 'ignore');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks-active');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const pc = fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.doesNotMatch(pc, /gh-maestro:sync-rules/);
    assert.match(pc, /echo keep-me/);
  });
});

test('管理対象のフック置き場では、追跡下のpre-pushを書き換え・削除しない（retireChecksHooksを実行しない）', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), [
      '#!/bin/sh',
      "if git diff --cached --name-only | grep -q '^\\.claude/rules/'; then",
      '  node scripts/sync-rules.js || exit 1',
      'fi',
      '',
    ].join('\n'), 'utf8');
    const prePushContent = [
      '#!/bin/sh',
      '# gh-maestro:checks:v1',
      'node "/somewhere/run-checks.js" prepush || exit 1',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-push'), prePushContent, 'utf8');
    gitIn(dir, 'add', '.githooks');
    gitIn(dir, 'commit', '-qm', 'track githooks');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    // 管理対象（書き込まない契約）の置き場では追跡下の pre-push が不変のまま残る
    assert.equal(fs.existsSync(path.join(dir, '.githooks', 'pre-push')), true);
    assert.equal(fs.readFileSync(path.join(dir, '.githooks', 'pre-push'), 'utf8'), prePushContent);
  });
});

test('同期呼び出しがコメント内だけにある追跡下フックは「導入済み」と誤報告しない', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), [
      '#!/bin/sh',
      '# node scripts/sync-rules.js',
      'echo custom-hook',
      '',
    ].join('\n'), 'utf8');
    gitIn(dir, 'add', '.githooks');
    gitIn(dir, 'commit', '-qm', 'track githooks');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    // 実行されない内容を「導入済み」と報告しない
    assert.doesNotMatch(r.stdout, /tracked; untouched/);
    assert.match(r.stderr, /未導入/);
    // 追跡下フックは書き換えない
    assert.match(fs.readFileSync(path.join(dir, '.githooks', 'pre-commit'), 'utf8'), /# node scripts\/sync-rules\.js/);
  });
});

test('同期呼び出しがecho等の実行されない文として現れるだけでは導入済みと誤報告しない', () => {
  withGitProject((dir) => {
    fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), [
      '#!/bin/sh',
      'echo "node scripts/sync-rules.js"',
      '',
    ].join('\n'), 'utf8');
    gitIn(dir, 'add', '.githooks');
    gitIn(dir, 'commit', '-qm', 'track githooks');
    gitIn(dir, 'config', 'core.hooksPath', '.githooks');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    assert.doesNotMatch(r.stdout, /tracked; untouched/);
    assert.match(r.stderr, /未導入/);
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
// ─── 作業ファイルの除外・dev作成の事実行（Issue #777） ───

function withIsolatedProject(fn) {
  return withGitProject((dir) => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-isolated-origin-'));
    try {
      const init = spawnSync('git', ['init', '--bare', '-q'], { cwd: bare, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      const head = spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' });
      assert.equal(head.status, 0, head.stderr);
      gitIn(dir, 'remote', 'set-url', 'origin', bare);
      gitIn(dir, 'push', '-q', 'origin', 'main');
      return fn(dir, bare);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
}

function factBlock(stdout) {
  const start = stdout.indexOf('[gh-maestro dev branch created]');
  assert.ok(start >= 0, `dev作成の事実行が出力されること: ${stdout}`);
  const fields = {};
  for (const line of stdout.slice(start).split('\n').slice(1)) {
    if (!/^[A-Z_]+=/.test(line)) break;
    const eq = line.indexOf('=');
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  gitIn(dir, 'add', name);
  gitIn(dir, 'commit', '-qm', message);
}

test('dev作成時は分岐元・今いるブランチの未取り込み件数・push で新たに出た件数を事実行として出す', () => {
  withIsolatedProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    gitIn(dir, 'checkout', '-qb', 'feature');
    commitFile(dir, 'feature-1.txt', '1\n', 'feature 1');
    commitFile(dir, 'feature-2.txt', '2\n', 'feature 2');

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(factBlock(r.stdout), {
      DEV_BASE_BRANCH: 'main',
      DEV_BASE_COMMIT: gitIn(dir, 'rev-parse', 'main').stdout.trim(),
      CURRENT_BRANCH: 'feature',
      CURRENT_BRANCH_COMMITS_NOT_IN_DEV: '2',
      DEV_PUSH: 'pushed',
      DEV_PUSH_COMMITS_NEW_ON_REMOTE_BASE: '0',
    });
  });
});

test('分岐元に未pushのコミットがあると、dev のpushで GitHub に新たに出た件数として数える', () => {
  withIsolatedProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    commitFile(dir, 'local-only.txt', 'x\n', 'local only on main');

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const block = factBlock(r.stdout);
    assert.equal(block.CURRENT_BRANCH, 'main');
    assert.equal(block.CURRENT_BRANCH_COMMITS_NOT_IN_DEV, '0');
    assert.equal(block.DEV_PUSH, 'pushed');
    assert.equal(block.DEV_PUSH_COMMITS_NEW_ON_REMOTE_BASE, '1');
    assert.equal(
      gitIn(dir, 'ls-remote', '--heads', 'origin', 'dev').stdout.split('\t')[0],
      gitIn(dir, 'rev-parse', 'dev').stdout.trim(),
      'origin/devがローカルのdevと一致すること',
    );
  });
});

test('GitHub上の分岐元が手元より先行していると、件数を数えず unknown と1行の理由を出す', () => {
  withIsolatedProject((dir, bare) => {
    prepareProjectWithoutDev(dir, 'main');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-other-clone-'));
    try {
      gitIn(os.tmpdir(), 'clone', '-q', bare, other);
      gitIn(other, 'config', 'user.email', 'test@example.com');
      gitIn(other, 'config', 'user.name', 'test');
      commitFile(other, 'remote-only.txt', 'r\n', 'remote only');
      gitIn(other, 'push', '-q', 'origin', 'main');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const value = factBlock(r.stdout).DEV_PUSH_COMMITS_NEW_ON_REMOTE_BASE;
    assert.match(value, /^unknown REASON=".+"$/);
    assert.ok(JSON.parse(value.slice('unknown REASON='.length)).length > 0);
  });
});

test('detached HEADでは CURRENT_BRANCH を (detached HEAD) とし、dev に無いコミットを数える', () => {
  withIsolatedProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    gitIn(dir, 'checkout', '-qb', 'feature');
    commitFile(dir, 'feature.txt', 'f\n', 'feature');
    gitIn(dir, 'checkout', '-q', '--detach');

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const block = factBlock(r.stdout);
    assert.equal(block.CURRENT_BRANCH, '(detached HEAD)');
    assert.equal(block.CURRENT_BRANCH_COMMITS_NOT_IN_DEV, '1');
  });
});

test('devが既にあるときは dev 作成の事実行を出さない', () => {
  withIsolatedProject((dir) => {
    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /\[gh-maestro dev branch created\]/);
  });
});

test('unknownFactは改行を含む理由でも1行に収まり、理由を復元できる', () => {
  const reason = 'fatal: first line\nsecond line\r\nthird';
  const fact = setupModule.unknownFact(reason);
  assert.equal(fact.includes('\n'), false);
  assert.equal(fact.includes('\r'), false);
  assert.equal(JSON.parse(fact.slice('unknown REASON='.length)), reason);
});

test('作業ファイルは .git/info/exclude で除外し、.gitignoreは書き換えず、config.jsonだけを追跡対象に残す', () => {
  withGitProject((dir) => {
    const gitignore = path.join(dir, '.gitignore');
    const legacy = 'node_modules/\n.gh-maestro/\n';
    fs.writeFileSync(gitignore, legacy, 'utf8');
    fs.mkdirSync(path.join(dir, '.gh-maestro', 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'config.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'worktrees', 'w1', 'prompt.md'), 'x\n', 'utf8');
    const excludeFile = path.join(dir, '.git', 'info', 'exclude');

    assert.equal(runSetupCli(dir).status, 0);
    assert.equal(runSetupCli(dir).status, 0, '2回目も成功すること');

    assert.equal(fs.readFileSync(gitignore, 'utf8'), legacy, '.gitignore は書き換えないこと');
    const excludeLines = fs.readFileSync(excludeFile, 'utf8').split(/\r?\n/).map((line) => line.trim());
    assert.equal(excludeLines.filter((line) => line === '.gh-maestro/*').length, 1, '2回実行しても重複しないこと');
    assert.equal(excludeLines.filter((line) => line === '!.gh-maestro/config.json').length, 1);

    const status = gitIn(dir, 'status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean);
    assert.ok(status.filter((line) => line.includes('.gh-maestro')).every((line) => line === '?? .gh-maestro/config.json'),
      '.gh-maestro配下はconfig.json以外が未追跡として現れないこと');

    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-wt-'));
    const wt = path.join(wtParent, 'wt');
    try {
      gitIn(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
      fs.mkdirSync(path.join(wt, '.gh-maestro'), { recursive: true });
      fs.writeFileSync(path.join(wt, '.gh-maestro', 'prompt.md'), 'x\n', 'utf8');
      fs.writeFileSync(path.join(wt, '.gh-maestro', 'config.json'), '{}\n', 'utf8');
      const wtStatus = gitIn(wt, 'status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean);
      assert.ok(wtStatus.filter((line) => line.includes('.gh-maestro')).every((line) => line === '?? .gh-maestro/config.json'),
        'linked worktreeにも除外が効くこと');
    } finally {
      fs.rmSync(wtParent, { recursive: true, force: true });
    }
  });
});

test('setupで作業ファイル除外を書けないときは中断し、dev を作らず .gitignore も作らない', () => {
  withIsolatedProject((dir) => {
    prepareProjectWithoutDev(dir, 'main');
    const excludeFile = path.join(dir, '.git', 'info', 'exclude');
    fs.rmSync(excludeFile, { force: true });
    fs.mkdirSync(excludeFile);

    const r = runSetupCli(dir);
    assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /作業ファイルを git から除外できないため setup を中断しました/);
    assert.equal(gitIn(dir, 'branch', '--list', 'dev').stdout.trim(), '', 'devを作らないこと');
    assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, '.gitignoreを作らないこと');
  });
});

test('リポジトリ直下に.gitignoreが無くてもsetupは成功し、.gitignoreを作らず、.git/info/excludeの2行で.gh-maestro配下のconfig.json以外を除外する', () => {
  withGitProject((dir) => {
    assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, '前提: .gitignoreが無いこと');
    fs.mkdirSync(path.join(dir, '.gh-maestro', 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'config.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'worktrees', 'w1', 'prompt.md'), 'x\n', 'utf8');

    const r = runSetupCli(dir);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

    assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, 'setupが.gitignoreを作らないこと');
    const excludeLines = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
      .split(/\r?\n/).map((line) => line.trim());
    assert.ok(excludeLines.includes('.gh-maestro/*'), 'info/excludeに.gh-maestro/*があること');
    assert.ok(excludeLines.includes('!.gh-maestro/config.json'), 'info/excludeに!.gh-maestro/config.jsonがあること');

    const status = gitIn(dir, 'status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean);
    const ghMaestroLines = status.filter((line) => line.includes('.gh-maestro'));
    assert.deepEqual(ghMaestroLines, ['?? .gh-maestro/config.json'],
      '.gh-maestro配下で未追跡として見えるのはconfig.jsonだけであること');
  });
});
