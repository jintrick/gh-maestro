'use strict';

// Issue #283 回帰テスト — フック環境の git 変数（GIT_DIR 等）がテストへ漏れても
// 実リポジトリを破壊しないことを証明する。
//
// 経路: リンク付き worktree から push すると git が pre-push フック環境へ
// GIT_DIR=<実リポジトリ>/.git/worktrees/<名前> を注入する。`npm test`（node --test）が
// これを全テストファイルと spawn 子プロセスへ継承し、GIT_DIR は spawnSync の cwd 指定より
// 優先されて git のリポジトリ発見を上書きする。
//
// 対策の3層:
//   1. .githooks の冒頭で unset（注入源の遮断）
//   2. tests/_env-setup.js プリロードで除去（テスト環境の中和）
//   3. scripts/shared/child-process.js 共有ラッパーが git spawn 時に除去（「cwd が正」を保証。
//      テストはバイパス不要で既存テストが無改変のまま通る）
//
// 受け入れ条件は「ガードで throw すること」ではなく「実リポジトリが無傷であること」。
// 各テストは victim リポジトリのスナップショットを操作前後で比較し、無傷を検証する。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process'); // 生 child_process（GIT_* を除去しない＝リーク再現の対照実験用）

const { worktreeAdd } = require('../../scripts/shared/git-worktree');
const { spawnSync: wrappedSpawnSync } = require('../../scripts/shared/child-process');
const { superviseReviewManager } = require('../../scripts/run-review-manager');

const SETUP_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'gh-maestro-setup.js');

// ── ヘルパー ─────────────────────────────────────────────────────────────────

// 一時リポジトリを初期化し、ブランチ main に初期コミットを置く（gh-maestro-setup.test.js と同じ手順）。
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };
  git('init', '-q');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'test');
  // リポジトリごとに内容を変えて commit hash を一意にする（同一秒内に同内容で init すると
  // 別リポジトリでも hash が一致し、対照実験の「HEADが異なる」前提が壊れる）。
  fs.writeFileSync(path.join(dir, 'README.md'), path.basename(dir), 'utf8');
  git('add', 'README.md');
  git('commit', '-qm', 'init');
  git('branch', '-m', 'main');
  return git;
}

// victim/.git 配下のファイルパスを再帰列挙（worktree 登録の生成を検出するため）。
function listRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out.sort();
}

// victim リポジトリの状態を文字列化する。--git-dir を明示するため、env に GIT_DIR が
// 漏れていてもスナップショット自体は影響を受けない（正の対照との混同を防ぐ）。
function snapshotVictim(victimDir) {
  const gitDir = path.join(victimDir, '.git');
  const git = (...args) => spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' });
  const refs = git('for-each-ref').stdout;
  const head = git('rev-parse', 'HEAD').stdout;
  const cfg = git('config', '--list').stdout;
  const worktrees = git('worktree', 'list', '--porcelain').stdout;
  const wtEntries = listRecursive(path.join(gitDir, 'worktrees'));
  return JSON.stringify({ refs, head, cfg, worktrees, wtEntries });
}

function refsOf(dir) {
  return spawnSync('git', ['--git-dir', path.join(dir, '.git'), 'for-each-ref'], { encoding: 'utf8' }).stdout;
}

// ── 3層目: 共有ラッパーの GIT_* 除去 ──────────────────────────────────────────

test('共有ラッパー(child-process.js)は git spawn 時に GIT_DIR を除去し cwd 基準のリポジトリ発見を保証する', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envleak-cp-'));
  try {
    const victim = path.join(base, 'victim');
    const cwdRepo = path.join(base, 'cwd');
    makeRepo(victim);
    makeRepo(cwdRepo);

    const victimHead = spawnSync('git', ['--git-dir', path.join(victim, '.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const cwdHead = spawnSync('git', ['--git-dir', path.join(cwdRepo, '.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(victimHead, cwdHead, '対照実験の前提: 2つのリポジトリのHEADは異なる');

    // リークの再現: git フックが注入するのと同じ形で GIT_DIR を設定する。
    process.env.GIT_DIR = path.join(victim, '.git');
    try {
      // 生 child_process（ラッパー不使用）は GIT_DIR に支配され victim を解決する＝リーク経路。
      const raw = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cwdRepo, encoding: 'utf8' });
      assert.equal(raw.stdout.trim(), victimHead, '生spawnはGIT_DIRでvictimのHEADを返す（リーク経路の再現）');

      // 共有ラッパー経由は GIT_DIR を除去し cwd のリポジトリを解決する＝対策。
      const wrapped = wrappedSpawnSync('git', ['rev-parse', 'HEAD'], { cwd: cwdRepo, encoding: 'utf8' });
      assert.equal(wrapped.status, 0, wrapped.stderr);
      assert.equal(wrapped.stdout.trim(), cwdHead, '共有ラッパー経由はcwd基準で解決する');
    } finally {
      delete process.env.GIT_DIR;
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── 受け入れ条件: GIT_DIR 注入下で worktreeAdd → victim 無傷 ─────────────────


// ── 受け入れ条件: GIT_DIR 注入下で superviseReviewManager → victim 無傷 ──────


// ── 受け入れ条件: GIT_DIR 注入下で gh-maestro-setup → victim 無傷 ────────────

test('GIT_DIR 注入下で gh-maestro-setup.js を実行しても victim リポジトリが無傷である', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envleak-setup-'));
  try {
    const victim = path.join(base, 'victim');
    const target = path.join(base, 'target');
    makeRepo(victim);
    makeRepo(target);
    // setup-ok を置いて checkEnvironment（WEZTERM_PANE 等）をスキップし、冪等セットアップの
    // git 操作（dev ブランチ作成等）に到達させる。
    fs.mkdirSync(path.join(target, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(target, '.gh-maestro', 'setup-ok'), '');

    const before = snapshotVictim(victim);
    // サブプロセスに GIT_DIR を注入する（実 push フックが npm test を起動する経路の再現）。
    const env = { ...process.env, GIT_DIR: path.join(victim, '.git') };
    const r = spawnSync(process.execPath, [SETUP_SCRIPT, target], { cwd: target, env, encoding: 'utf8' });

    assert.equal(r.status, 0, r.stderr);
    assert.equal(snapshotVictim(victim), before, 'GIT_DIR 注入下でも victim リポジトリは無傷であること');
    // 正の対照: target（cwd）にだけ dev ブランチが作られている。
    assert.match(refsOf(target), /refs\/heads\/dev/, 'setup は target に dev ブランチを作る');
    assert.doesNotMatch(refsOf(victim), /refs\/heads\/dev/, 'victim に dev ブランチが作られていない');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── 1層目: .githooks の unset ────────────────────────────────────────────────

// リポジトリ位置を上書きする変数だけを落とす。
const HOOK_POSITION_VARS = [
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
];
// これらは落としてはならない。git commit -a / パス指定コミットで git が渡す一時
// インデックスを失うと、git diff --cached が実インデックスを読みステージ内容が
// 空に見え、sync が無言でスキップされる。
const HOOK_MUST_KEEP_VARS = ['GIT_INDEX_FILE', 'GIT_PREFIX'];


// ── 2層目: tests/_env-setup.js プリロードの除去 ───────────────────────────────

test('_env-setup.js プリロードが git 注入変数を除去する', () => {
  const injected = {
    GIT_DIR: '/fake/victim/.git', GIT_COMMON_DIR: '/fake/common', GIT_WORK_TREE: '/fake/wt',
    GIT_INDEX_FILE: '/fake/index', GIT_PREFIX: '/fake/', GIT_OBJECT_DIRECTORY: '/fake/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/fake/alts', GIT_QUARANTINE_PATH: '/fake/q',
  };
  const env = { ...process.env, ...injected };
  const probe = 'console.log(JSON.stringify(process.env))';
    const r = spawnSync(process.execPath, ['--require', path.join(__dirname, '..', '_env-setup.js'), '-e', probe], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  for (const key of Object.keys(injected)) {
    assert.equal(out[key], undefined, `_env-setup.js は ${key} を除去すること`);
  }
});

test('_env-setup.js プリロードがワーカー文脈変数を除去し、テストruntime rootを保持する', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envleak-worker-context-'));
  try {
    const runtimeRoot = path.join(base, 'runtime-root');
    const injected = {
      GH_MAESTRO_WORKER: 'issue-342-worker',
      GH_MAESTRO_WORKSPACE: path.join(base, 'real-workspace'),
      GH_MAESTRO_BASE_BRANCH: 'dev',
      GH_MAESTRO_ISSUE: '342',
      ISSUE: '342',
      NO_COLOR: '1',
      GH_MAESTRO_RESOURCE_KEY: 'a'.repeat(64),
      GH_MAESTRO_INSTANCE_ID: 'parent-instance',
      GH_MAESTRO_RUNTIME_DIR: runtimeRoot,
    };
    const probe = 'console.log(JSON.stringify(process.env))';
    const r = spawnSync(process.execPath, ['--require', path.join(__dirname, '..', '_env-setup.js'), '-e', probe], {
      env: { ...process.env, ...injected },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    for (const key of [
      'GH_MAESTRO_WORKER',
      'GH_MAESTRO_WORKSPACE',
      'GH_MAESTRO_BASE_BRANCH',
      'GH_MAESTRO_ISSUE',
      'ISSUE',
      'NO_COLOR',
      'GH_MAESTRO_RESOURCE_KEY',
      'GH_MAESTRO_INSTANCE_ID',
    ]) {
      assert.equal(out[key], undefined, `_env-setup.js は ${key} を除去すること`);
    }
    assert.equal(out.GH_MAESTRO_RUNTIME_DIR, runtimeRoot, 'テスト専用runtime rootは子プロセスへ継承すること');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── 1層目: .githooks/pre-commit を実行し、git 呼び出し時点の環境を記録させて確かめる ──
// 偽の git を PATH の先頭に置いてフックを実行する。偽 git は呼ばれた時点の位置系変数と
// 残すべき変数を記録する。記録から次を確かめる:
//   - 最初の git 呼び出しより前に HOOK_POSITION_VARS が unset されている
//   - HOOK_MUST_KEEP_VARS は注入した値のまま残る
// 変異確認: unset をフック末尾へ移す変異と、GIT_PREFIX を unset に加える変異で失敗する。

// 親環境の GIT_* を取り除いた環境（テストの git 呼び出しを親のリポジトリ指定から切り離す）
function gitFreeEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return { ...env, ...extra };
}

function writeFakeGit(binDir) {
  const gitPath = path.join(binDir, 'git');
  fs.writeFileSync(gitPath, [
    '#!/bin/sh',
    'printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\n" "${GIT_DIR-unset}" "${GIT_COMMON_DIR-unset}" "${GIT_WORK_TREE-unset}" "${GIT_OBJECT_DIRECTORY-unset}" "${GIT_ALTERNATE_OBJECT_DIRECTORIES-unset}" "${GIT_QUARANTINE_PATH-unset}" "${GIT_INDEX_FILE-unset}" "${GIT_PREFIX-unset}" "$*" >> "$FAKE_GIT_LOG"',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(gitPath, 0o755);
}

test('.githooks/pre-commit は最初の git 呼び出しより前に位置系変数を unset し、残すべき変数は残す（フックを実行して確認）', () => {
  const hookPath = path.join(__dirname, '..', '..', '.githooks', 'pre-commit');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-hook-run-'));
  try {
    const binDir = path.join(base, 'bin');
    fs.mkdirSync(binDir);
    writeFakeGit(binDir);
    const logPath = path.join(base, 'git-calls.log');
    const injected = {
      GIT_DIR: path.join(base, 'other', '.git'),
      GIT_COMMON_DIR: path.join(base, 'other', '.git'),
      GIT_WORK_TREE: path.join(base, 'other'),
      GIT_OBJECT_DIRECTORY: path.join(base, 'other', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(base, 'alt'),
      GIT_QUARANTINE_PATH: path.join(base, 'quarantine'),
      GIT_INDEX_FILE: path.join(base, 'keep-index'),
      GIT_PREFIX: 'keep-prefix/',
    };
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const r = spawnSync('sh', [hookPath], {
      cwd: base,
      encoding: 'utf8',
      env: gitFreeEnv({
        ...injected,
        [pathKey]: binDir + path.delimiter + (process.env[pathKey] || ''),
        FAKE_GIT_LOG: logPath,
      }),
    });
    assert.equal(r.status, 0, r.stderr);

    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length >= 1, 'フックが git を1回以上呼ぶこと');
    // 偽 git の printf の並び = HOOK_POSITION_VARS → HOOK_MUST_KEEP_VARS
    const logged = [...HOOK_POSITION_VARS, ...HOOK_MUST_KEEP_VARS];
    for (const line of lines) {
      const fields = line.split('|');
      logged.forEach((name, i) => {
        const expected = HOOK_POSITION_VARS.includes(name) ? 'unset' : injected[name];
        assert.equal(fields[i], expected, `git 呼び出し時点の ${name}（${line}）`);
      });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
