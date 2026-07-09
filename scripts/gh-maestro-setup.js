#!/usr/bin/env node
// gh-maestro per-project setup script
// Validates prerequisites on first run; always applies idempotent setup steps.
// Sentinel (.gh-maestro/setup-ok) only gates expensive environment checks.

const { spawnSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync, chmodSync } = require('fs');
const { resolve } = require('path');

const USAGE = `gh-maestro-setup.js — プロジェクトごとの前提条件チェックと初期セットアップ

Usage: node gh-maestro-setup.js [WORKSPACE_ROOT]

Arguments:
  [WORKSPACE_ROOT]  対象プロジェクトのルート（デフォルト CWD）

WEZTERM_PANE / wezterm CLI / git リポジトリ / gh 認証を検証し、.gh-maestro ディレクトリと
.gitignore・dev ブランチ・pre-commit フックを用意する。初回実行後は sentinel
(.gh-maestro/setup-ok) で環境チェックのみスキップし、冪等なセットアップステップは
毎回実行する。通常は /gh-maestro の起動フックが呼ぶ。`;

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  console.log(USAGE);
  process.exit(0);
}

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

// ─── GitHub Actions AI Review CI 退役クリーンアップ ─────────────────────────
// 旧バージョンは setup-ai-review.js で CI をデプロイしていた。
// ローカル spawn 方式に移行したため、デプロイ済みファイルを削除する。
// sentinel (.gh-maestro/ai-review-ok) が存在するプロジェクトが対象。

const aiReviewSentinel = resolve(workspaceRoot, '.gh-maestro', 'ai-review-ok');
if (existsSync(aiReviewSentinel)) {
  const repoName = getRemoteRepo();
  if (repoName) {
    step('Retiring GitHub Actions AI Review CI...');
    const RETIRE_BRANCHES = ['main', 'dev'];
    const RETIRE_PATHS = [
      '.github/workflows/reviewer.lock.yml',
      '.github/workflows/reviewer.md',
      '.github/workflows/shared/reviewer-output-policy.md',
    ];
    for (const branch of RETIRE_BRANCHES) {
      for (const filePath of RETIRE_PATHS) {
        const get = spawnSync('gh', ['api', `repos/${repoName}/contents/${filePath}?ref=${branch}`, '--jq', '.sha'],
          { encoding: 'utf8', stdio: 'pipe' });
        const sha = get.stdout.trim();
        if (!sha) continue;
        const del = spawnSync('gh', ['api', `repos/${repoName}/contents/${filePath}`, '--method', 'DELETE', '--input', '-'],
          { encoding: 'utf8', stdio: 'pipe',
            input: JSON.stringify({ message: 'ci: retire AI Review CI (replaced by local reviewer)', sha, branch }) });
        del.status === 0
          ? ok(`removed ${filePath} from ${branch}`)
          : console.warn(`  [warn] failed to remove ${filePath} from ${branch}: ${del.stderr.trim()}`);
      }
    }
    unlinkSync(aiReviewSentinel);
    ok('AI Review CI retired');
  }
}

// ─── 1. 環境チェック ──────────────────────────────────────────────────────────

const sentinelPath = resolve(workspaceRoot, '.gh-maestro', 'setup-ok');
const isFirstRun = !existsSync(sentinelPath);

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

// ─── 5. pre-commit フック設置 ─────────────────────────────────────────────────

const CURRENT_MARKER = 'gh-maestro:sync-rules:v1';
const MARKER_RE = /^# gh-maestro:sync-rules(:v\d+)?$/;

function ensurePreCommitHook() {
  const hooksDir = resolve(workspaceRoot, '.git', 'hooks');
  const hookPath = resolve(hooksDir, 'pre-commit');
  const syncScript = resolve(require('os').homedir(), '.gh-maestro', 'scripts', 'sync-rules.js');

  const entry = [
    `# ${CURRENT_MARKER}`,
    `if git diff --cached --name-only | grep -q '^\\.claude/rules/'; then`,
    `  node "${syncScript}"`,
    `fi`,
  ];

  mkdirSync(hooksDir, { recursive: true });

  if (existsSync(hookPath)) {
    const lines = readFileSync(hookPath, 'utf8').split('\n');

    // Check for existing gh-maestro:sync-rules block
    const markerIdx = lines.findIndex(l => MARKER_RE.test(l.trim()));

    if (markerIdx !== -1) {
      const markerLine = lines[markerIdx].trim();

      if (markerLine === `# ${CURRENT_MARKER}`) {
        ok('pre-commit hook already contains sync-rules entry (current version)');
        return;
      }

      // Old version found — replace from marker line through the fi line
      let endIdx = -1;
      for (let i = markerIdx; i < lines.length; i++) {
        if (/^fi(\b|;|$)/.test(lines[i].trim())) {
          endIdx = i;
          break;
        }
      }

      if (endIdx === -1) {
        // fi 行が見つからなければ安全側に倒し、末尾に追記する
        appendFileSync(hookPath, `\n${entry.join('\n')}\n`, 'utf8');
        try { chmodSync(hookPath, 0o755); } catch {}
        ok('pre-commit hook updated: block appended (no fi found for old marker)');
        return;
      }

      lines.splice(markerIdx, endIdx - markerIdx + 1, ...entry);
      writeFileSync(hookPath, lines.join('\n'), 'utf8');
      try { chmodSync(hookPath, 0o755); } catch {}
      ok('pre-commit hook updated: sync-rules entry upgraded');
      return;
    }

    // No marker found, append
    appendFileSync(hookPath, `\n${entry.join('\n')}\n`, 'utf8');
  } else {
    writeFileSync(hookPath, `#!/bin/sh\n${entry.join('\n')}\n`, 'utf8');
  }
  try { chmodSync(hookPath, 0o755); } catch {}
  ok(`pre-commit hook installed: ${hookPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Sentinel gates only expensive environment checks.
// Idempotent setup steps (ensure*) run every invocation so new steps
// apply automatically to existing projects.
if (isFirstRun) {
  checkEnvironment();
}

prepareDirectories();
ensureGitIgnore();
ensureDevBranch();
ensurePreCommitHook();

if (isFirstRun) {
  mkdirSync(resolve(workspaceRoot, '.gh-maestro'), { recursive: true });
  writeFileSync(sentinelPath, '');
  ok('Setup complete (subsequent /gh-maestro invocations will skip environment checks)');
  console.log('\ngh-maestro ready.\n');
}
