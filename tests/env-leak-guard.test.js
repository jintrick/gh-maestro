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

const { worktreeAdd } = require('../scripts/shared/git-worktree');
const { spawnSync: wrappedSpawnSync } = require('../scripts/shared/child-process');
const { superviseReviewManager } = require('../scripts/run-review-manager');

const SETUP_SCRIPT = path.join(__dirname, '..', 'scripts', 'gh-maestro-setup.js');

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


// ── 受け入れ条件: GIT_DIR 注入下で worktreeAdd → victim 無傷 ─────────────────

test('GIT_DIR 注入下で worktreeAdd を呼んでも victim リポジトリが無傷である', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envleak-wta-'));
  try {
    const victim = path.join(base, 'victim');
    const cwdRepo = path.join(base, 'cwd');
    makeRepo(victim);
    makeRepo(cwdRepo);
    const before = snapshotVictim(victim);

    const worktreeDir = path.join(base, 'env-leak-wt');
    process.env.GIT_DIR = path.join(victim, '.git');
    try {
      worktreeAdd(worktreeDir, 'env-leak-branch', null, cwdRepo);
    } finally {
      delete process.env.GIT_DIR;
    }

    assert.equal(snapshotVictim(victim), before, 'GIT_DIR 注入下でも victim リポジトリは無傷であること');
    // 正の対照: 操作自体は呼び出し元（cwd）のリポジトリに対して成功している。
    assert.match(refsOf(cwdRepo), /refs\/heads\/env-leak-branch/, 'worktreeAdd は cwd のリポジトリに worktree を作る');
    assert.doesNotMatch(refsOf(victim), /env-leak-branch/, 'victim に branch が作られていない');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── 受け入れ条件: GIT_DIR 注入下で superviseReviewManager → victim 無傷 ──────

test('GIT_DIR 注入下で superviseReviewManager を呼んでも victim リポジトリが無傷である', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envleak-sv-'));
  try {
    const victim = path.join(base, 'victim');
    const workspace = path.join(base, 'workspace');
    makeRepo(victim);
    makeRepo(workspace);

    const ghDir = path.join(workspace, '.gh-maestro');
    const logFile = path.join(base, 'rm.log');
    const promptFile = path.join(base, 'prompt.md');
    const lockFile = path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.running');
    const outputFile = path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.json');
    const logs = [];
    const before = snapshotVictim(victim);

    process.env.GIT_DIR = path.join(victim, '.git');
    let result;
    try {
      result = await superviseReviewManager({
        pr: '999', repo: 'o/r', workspace,
        ghDir, lockFile, logFile, outputFile, promptFile,
        deadlineMs: 5000, log: (m) => logs.push(m), signal: { aborted: false },
      });
    } finally {
      delete process.env.GIT_DIR;
    }

    // workspace に origin が無いため PR head の fetch に失敗し setup-failed で停止する
    // （この手前の worktreeAdd が被害の発生源。無傷であることが検証対象）。
    assert.equal(result.outcome, 'setup-failed');
    assert.equal(snapshotVictim(victim), before, 'GIT_DIR 注入下でも victim リポジトリは無傷であること');
    // 正の対照: workspace（cwd）にだけ review worktree の branch が作られている。
    assert.match(refsOf(workspace), /refs\/heads\/review-pr-999/, 'setup は workspace に review worktree を作る');
    assert.doesNotMatch(refsOf(victim), /review-pr-999/, 'victim に review-pr-* branch が作られていない');
    assert.ok(fs.existsSync(lockFile), 'lock file は setup 失敗前に作成されている');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── 受け入れ条件: GIT_DIR 注入下で gh-maestro-setup → victim 無傷 ────────────


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

test('.githooks/pre-commit は最初の git 呼び出しより前にリポジトリ位置系の変数を unset する', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', '.githooks', 'pre-commit'), 'utf8');
  const unsetIdx = content.indexOf('unset GIT_DIR');
  assert.notEqual(unsetIdx, -1, 'pre-commit: unset 行が必要');
  assert.ok(unsetIdx < content.indexOf('git diff --cached'), 'pre-commit: unset が最初の git 呼び出しより前にあること');
  const unsetStmt = content.slice(unsetIdx, content.indexOf('|| true', unsetIdx));
  for (const v of HOOK_POSITION_VARS) {
    assert.ok(unsetStmt.includes(v), `pre-commit は ${v} を unset に含むこと`);
  }
  for (const v of HOOK_MUST_KEEP_VARS) {
    assert.ok(!unsetStmt.includes(v), `pre-commit は ${v} を unset してはならない`);
  }
});

// ── 2層目: tests/_env-setup.js プリロードの除去 ───────────────────────────────



test('package.jsonの全テスト入口が成果物生成runnerを経由し、runnerが_env-setup.jsをプリロードする', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const scriptName of ['test', 'test:slow']) {
    const command = packageJson.scripts?.[scriptName];
    assert.equal(typeof command, 'string', `${scriptName} スクリプトが必要`);
    assert.match(command, /node scripts\/run-tests\.js (?:full|slow)/, `${scriptName} は run-tests.js を経由すること`);
  }
  // Issue #454 でテストコマンドの記述先が scripts/run-tests.js から resolve-config.js へ移った。
  const { createBuiltinTestConfig } = require('../scripts/shared/resolve-config');
  const config = createBuiltinTestConfig();
  for (const layerName of ['full', 'slow']) {
    assert.deepEqual(
      config.layers?.[layerName]?.command?.slice(1),
      ['--require', './tests/_env-setup.js', '--test'],
      `${layerName} 層は _env-setup.js を --test より前に渡すこと`,
    );
  }
});
