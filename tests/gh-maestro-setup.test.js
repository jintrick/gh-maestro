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
function runSetupCli(dir) {
  return spawnSync(process.execPath, [SCRIPT, dir], { cwd: dir, encoding: 'utf8' });
}

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
    assert.match(r.stdout, /tracked; untouched/);
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

test('module.exports.main を公開する（CLI実行時のみ副作用を起こす）', () => {
  const scriptPosix = SCRIPT.split(path.sep).join('/');
  const r = spawnSync(process.execPath, [
    '-e', `const m = require(${JSON.stringify(scriptPosix)}); console.log(typeof m.main);`,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'function');
});
