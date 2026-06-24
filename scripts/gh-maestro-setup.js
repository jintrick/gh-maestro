#!/usr/bin/env node
// gh-maestro per-project setup script
// Validates prerequisites on first run; skips on subsequent runs via sentinel file.

const { spawnSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const workspaceRoot = process.argv[2] ?? process.cwd();

function step(msg)  { console.log(`\x1b[36m[gh-maestro] ${msg}\x1b[0m`); }
function ok(msg)    { console.log(`  \x1b[32mv ${msg}\x1b[0m`); }
function fail(msg, ...hints) {
  console.error(`\n  \x1b[31mx ${msg}\x1b[0m`);
  for (const h of hints) console.error(`    ${h}`);
  console.error();
  process.exit(1);
}

function run(cmd, args, { capture } = {}) {
  const r = spawnSync(cmd, args, { cwd: workspaceRoot, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.status !== 0) return null;
  return capture ? r.stdout.trim() : true;
}

function getRemoteRepo() {
  const remoteUrl = run('git', ['config', '--get', 'remote.origin.url'], { capture: true });
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[:/](.+?\/.+?)(\.git)?$/);
  return match ? match[1] : null;
}

// ─── AI Review setup (テンプレートが変わるたびに再デプロイ) ──────────────────

const { createHash } = require('crypto');
const { readdirSync } = require('fs');

// デプロイ対象の全ファイルをハッシュ（reviewer.lock.yml + reviewer*.md + shared/*）
// ソース: scripts/../workflows/  インストール後: ~/.gh-maestro/scripts/../workflows/（同じ相対パス）
const workflowsDir = resolve(__dirname, '..', 'workflows');
const sharedDir = resolve(__dirname, '..', '.github', 'workflows', 'shared');
function computeDeployHash() {
  const h = createHash('sha256');
  // utf8 で読み改行を LF に正規化してからハッシュ化する。
  // Buffer 直読みだと Windows(CRLF)/Unix(LF) でハッシュが変わり毎回再デプロイされる。
  const hashDir = (dir, filter) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter(filter).sort()) {
      h.update(readFileSync(resolve(dir, f), 'utf8').replace(/\r\n/g, '\n'));
    }
  };
  hashDir(workflowsDir, f => f.endsWith('.lock.yml') || (f.endsWith('.md') && f.startsWith('reviewer')));
  hashDir(sharedDir, () => true);
  return h.digest('hex').slice(0, 16);
}

const aiReviewSentinel = resolve(workspaceRoot, '.gh-maestro', 'ai-review-ok');
const currentHash = computeDeployHash();
const savedHash = existsSync(aiReviewSentinel) ? readFileSync(aiReviewSentinel, 'utf8').trim() : null;

if (currentHash !== savedHash) {
  const repoName = getRemoteRepo();
  if (repoName) {
    const setupAiReview = resolve(__dirname, 'setup-ai-review.js');
    if (existsSync(setupAiReview)) {
      const r = spawnSync(process.execPath, [setupAiReview, repoName], { stdio: 'inherit' });
      if (r.status === 0) {
        mkdirSync(resolve(workspaceRoot, '.gh-maestro'), { recursive: true });
        writeFileSync(aiReviewSentinel, currentHash);
      }
    }
  }
}

// ─── Sentinel check ───────────────────────────────────────────────────────────

const sentinelPath = resolve(workspaceRoot, '.gh-maestro', 'setup-ok');
if (existsSync(sentinelPath)) {
  process.exit(0);
}

// ─── 1. 環境チェック ──────────────────────────────────────────────────────────

function checkEnvironment() {
  step('Checking prerequisites...');

  if (!process.env.WEZTERM_PANE) {
    fail(
      'WEZTERM_PANE が設定されていません。',
      '→ WezTerm のペイン内から /gh-maestro を実行してください。',
      '→ すでに WezTerm 内にいる場合は WezTerm が古い可能性があります（v20220807 以降で自動設定）。',
      '   インストール: https://wezfurlong.org/wezterm/installation.html',
    );
  }
  ok(`Orchestrator pane-id: ${process.env.WEZTERM_PANE}`);

  if (!run('wezterm', ['--version'], { capture: true })) {
    fail(
      'wezterm CLI が PATH に見つかりません。',
      '→ WezTerm をインストールしてください: https://wezfurlong.org/wezterm/installation.html',
      '→ インストール後はシェルを再起動するか、PATH を再読み込みしてください。',
    );
  }
  ok('wezterm CLI found');

  if (!existsSync(resolve(workspaceRoot, '.git'))) {
    fail(
      `git リポジトリではありません: ${workspaceRoot}`,
      '→ プロジェクトのルートディレクトリに移動してから /gh-maestro を実行してください。',
      '→ 未初期化の場合: git init && git remote add origin https://github.com/<owner>/<repo>.git',
    );
  }

  const remoteUrl = run('git', ['config', '--get', 'remote.origin.url'], { capture: true });
  if (!remoteUrl) {
    fail(
      "git remote 'origin' が設定されていません。",
      '→ git remote add origin https://github.com/<owner>/<repo>.git',
    );
  }
  const match = remoteUrl.match(/github\.com[:/](.+?\/.+?)(\.git)?$/);
  if (!match) {
    fail(
      `remote.origin.url から GitHub の owner/repo を取得できませんでした: ${remoteUrl}`,
      '→ gh-maestro は GitHub.com のリポジトリのみサポートしています。',
      '→ 期待する URL 形式: https://github.com/owner/repo.git または git@github.com:owner/repo.git',
    );
  }
  ok(`Repository: ${match[1]}`);

  if (!run('gh', ['auth', 'status'], { capture: true })) {
    fail(
      'gh CLI が認証されていません。',
      "→ 'gh auth login' を実行して GitHub アカウントを認証してください。",
      '→ gh CLI 未インストールの場合: https://cli.github.com/',
    );
  }
  ok('gh CLI authenticated');
}

// ─── 2. ディレクトリ準備 ──────────────────────────────────────────────────────

function prepareDirectories() {
  mkdirSync(resolve(workspaceRoot, '.gh-maestro', 'worktrees'), { recursive: true });
  ok('.gh-maestro/worktrees directory ready');
}

// ─── 3. .gitignore 確認・追記 ─────────────────────────────────────────────────

function ensureGitIgnore() {
  const gitignore = resolve(workspaceRoot, '.gitignore');
  const entry = '.gh-maestro/';
  if (!existsSync(gitignore)) {
    appendFileSync(gitignore, `${entry}\n`, 'utf8');
    ok(`.gitignore created with ${entry}`);
    return;
  }
  const already = readFileSync(gitignore, 'utf8').split('\n').some(l => l.trim() === entry);
  if (!already) {
    appendFileSync(gitignore, `\n${entry}\n`, 'utf8');
    ok(`.gitignore updated: added ${entry}`);
  } else {
    ok(`.gitignore already contains ${entry}`);
  }
}

// ─── 4. dev ブランチ確認・作成 ────────────────────────────────────────────────

function ensureDevBranch() {
  const devBranch = run('git', ['branch', '--list', 'dev'], { capture: true });
  if (!devBranch) {
    step("Creating 'dev' branch from main...");
    if (!run('git', ['checkout', '-b', 'dev', 'main'])) {
      fail(
        "'dev' ブランチの作成に失敗しました。",
        "→ 'main' ブランチが存在するか確認してください: git branch --list main",
        '→ main が無い場合、デフォルトブランチ名を確認して手動で作成してください:',
        '   git checkout -b dev <デフォルトブランチ名> && git push -u origin dev',
      );
    }
    run('git', ['push', '-u', 'origin', 'dev']);
  }
  ok("Branch 'dev' exists");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

checkEnvironment();
prepareDirectories();
ensureGitIgnore();
ensureDevBranch();

mkdirSync(resolve(workspaceRoot, '.gh-maestro'), { recursive: true });
writeFileSync(sentinelPath, '');
ok('Setup complete (subsequent /gh-maestro invocations will skip this check)');

console.log('\ngh-maestro ready.\n');
