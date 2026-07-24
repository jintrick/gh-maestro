#!/usr/bin/env node
// gh-maestro per-project setup script
// Validates prerequisites on first run; always applies idempotent setup steps.
// Sentinel (.gh-maestro/setup-ok) only gates expensive environment checks.

const { spawnSync } = require('./child-process');
const { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync, chmodSync } = require('fs');
const { resolve } = require('path');

const USAGE = `gh-maestro-setup.js — プロジェクトごとの前提条件チェックと初期セットアップ

Usage: node gh-maestro-setup.js [WORKSPACE_ROOT]

Arguments:
  [WORKSPACE_ROOT]  対象プロジェクトのルート（デフォルト CWD）

WEZTERM_PANE / wezterm CLI / git リポジトリ / gh 認証を検証し、.gh-maestro ディレクトリと
.gitignore・dev ブランチ・pre-commit/pre-push フック（sync-rules同期・lint/format/typecheck/test
検証）を用意する。初回実行後は sentinel (.gh-maestro/setup-ok) で環境チェックのみスキップし、
冪等なセットアップステップは毎回実行する。通常は /gh-maestro の起動フックが呼ぶ。`;

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
    let allDeleted = true;
    for (const branch of RETIRE_BRANCHES) {
      for (const filePath of RETIRE_PATHS) {
        let sha;
        try {
          const get = spawnSync('gh', ['api', `repos/${repoName}/contents/${filePath}?ref=${branch}`, '--jq', '.sha'],
            { encoding: 'utf8', stdio: 'pipe' });
          sha = get.stdout.trim();
        } catch (e) {
          console.warn(`  [warn] failed to query ${filePath} on ${branch}: ${e.message}`);
          allDeleted = false;
          continue;
        }
        if (!sha) continue;
        try {
          const del = spawnSync('gh', ['api', `repos/${repoName}/contents/${filePath}`, '--method', 'DELETE', '--input', '-'],
            { encoding: 'utf8', stdio: 'pipe',
              input: JSON.stringify({ message: 'ci: retire AI Review CI (replaced by local reviewer)', sha, branch }) });
          if (del.status === 0) {
            ok(`removed ${filePath} from ${branch}`);
          } else {
            console.warn(`  [warn] failed to remove ${filePath} from ${branch}: ${(del.stderr || '').trim()}`);
            allDeleted = false;
          }
        } catch (e) {
          console.warn(`  [warn] failed to remove ${filePath} from ${branch}: ${e.message}`);
          allDeleted = false;
        }
      }
    }
    if (allDeleted) {
      unlinkSync(aiReviewSentinel);
      ok('AI Review CI retired');
    } else {
      console.warn('  [warn] AI Review CI retirement incomplete; sentinel kept for retry on next run');
    }
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
  }

  // ローカルに dev ブランチがあっても origin/dev が無いことがある
  // （初回セットアップ時の push 失敗・オフライン実行等）。毎回リモートの
  // 存在を確認し、無ければ再度 push を試みる。
  const remoteDev = run('git', ['ls-remote', '--heads', 'origin', 'dev'], { capture: true });
  if (!remoteDev) {
    if (!run('git', ['push', '-u', 'origin', 'dev'])) {
      console.warn("  [warn] 'dev' ブランチのリモートへのpushに失敗しました。手動で実行してください: git push -u origin dev");
    }
  }

  ok("Branch 'dev' exists");
}

// ─── 5. git フック設置 ────────────────────────────────────────────────────────
//
// 複数のフック（sync-rules用pre-commit、checks用pre-commit/pre-push）が同じ
// 「マーカーコメント検出→バージョン一致なら何もしない→旧バージョンなら固定行数
// splice置換→無ければ追記/新規作成」パターンを踏むため、upsertMarkerBlockに集約する。

/**
 * hookPath内の、marker/markerReで識別されるブロックをentryLinesへ収束させる
 * （新規作成/追記/バージョンアップグレード/既に最新なら何もしない、を冪等に行う）。
 *
 * @param {string} hookPath
 * @param {{marker: string, markerRe: RegExp, entryLines: string[]}} block
 * @returns {'unchanged'|'created'|'updated'|'appended'}
 */
function upsertMarkerBlock(hookPath, { marker, markerRe, entryLines }) {
  const hooksDir = resolve(hookPath, '..');
  mkdirSync(hooksDir, { recursive: true });

  const entry = [`# ${marker}`, ...entryLines];

  if (existsSync(hookPath)) {
    const lines = readFileSync(hookPath, 'utf8').split('\n');
    const markerIdx = lines.findIndex(l => markerRe.test(l.trim()));

    if (markerIdx !== -1) {
      const markerLine = lines[markerIdx].trim();

      if (markerLine === `# ${marker}`) {
        return 'unchanged';
      }

      // Old version found — replace the fixed-length gh-maestro block.
      // The block has a known structure (marker + entryLines) so we use the
      // exact line count rather than scanning for a matching terminator,
      // which could match an unrelated block ahead of the correct one.
      lines.splice(markerIdx, entry.length, ...entry);
      writeFileSync(hookPath, lines.join('\n'), 'utf8');
      applyExecPermission(hookPath);
      return 'updated';
    }

    appendFileSync(hookPath, `\n${entry.join('\n')}\n`, 'utf8');
    applyExecPermission(hookPath);
    return 'appended';
  }

  writeFileSync(hookPath, `#!/bin/sh\n${entry.join('\n')}\n`, 'utf8');
  applyExecPermission(hookPath);
  return 'created';
}

function applyExecPermission(hookPath) {
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    console.warn(`  [warn] ${hookPath} の実行権限設定に失敗しました。手動で chmod +x を実行してください。`);
  }
}

const SYNC_RULES_MARKER = 'gh-maestro:sync-rules:v1';
const SYNC_RULES_MARKER_RE = /^# gh-maestro:sync-rules(:v\d+)?$/;
const CHECKS_MARKER = 'gh-maestro:checks:v1';
const CHECKS_MARKER_RE = /^# gh-maestro:checks(:v\d+)?$/;

function runChecksScriptPath() {
  return resolve(require('os').homedir(), '.gh-maestro', 'scripts', 'hooks', 'run-checks.js');
}

function ensurePreCommitHook(root = workspaceRoot) {
  const hookPath = resolve(root, '.git', 'hooks', 'pre-commit');
  const syncScript = resolve(require('os').homedir(), '.gh-maestro', 'scripts', 'sync-rules.js');

  const syncResult = upsertMarkerBlock(hookPath, {
    marker: SYNC_RULES_MARKER,
    markerRe: SYNC_RULES_MARKER_RE,
    entryLines: [
      `if git diff --cached --name-only | grep -q '^\\.claude/rules/'; then`,
      `  node "${syncScript}"`,
      `fi`,
    ],
  });
  reportHookResult('pre-commit hook (sync-rules)', syncResult);

  const checksResult = upsertMarkerBlock(hookPath, {
    marker: CHECKS_MARKER,
    markerRe: CHECKS_MARKER_RE,
    entryLines: [`node "${runChecksScriptPath()}" precommit || exit 1`],
  });
  reportHookResult('pre-commit hook (checks)', checksResult);
}

function ensurePrePushHook(root = workspaceRoot) {
  const hookPath = resolve(root, '.git', 'hooks', 'pre-push');

  const checksResult = upsertMarkerBlock(hookPath, {
    marker: CHECKS_MARKER,
    markerRe: CHECKS_MARKER_RE,
    entryLines: [`node "${runChecksScriptPath()}" prepush || exit 1`],
  });
  reportHookResult('pre-push hook (checks)', checksResult);
}

function reportHookResult(label, result) {
  switch (result) {
    case 'unchanged': ok(`${label}: already current`); break;
    case 'updated': ok(`${label}: upgraded`); break;
    case 'appended': ok(`${label}: entry appended`); break;
    case 'created': ok(`${label}: installed`); break;
  }
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
ensurePrePushHook();

if (isFirstRun) {
  mkdirSync(resolve(workspaceRoot, '.gh-maestro'), { recursive: true });
  writeFileSync(sentinelPath, '');
  ok('Setup complete (subsequent /gh-maestro invocations will skip environment checks)');
  console.log('\ngh-maestro ready.\n');
}
