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

WezTerm稼働（assistant用）/ git リポジトリ / gh 認証を検証し、.gh-maestro ディレクトリと
.gitignore・dev ブランチ・pre-commit/pre-push フック（sync-rules同期・lint/format/typecheck/test
検証）を用意する。初回実行後は sentinel (.gh-maestro/setup-ok) で環境チェックのみスキップし、
冪等なセットアップステップは毎回実行する。通常は /gh-maestro の起動フックが呼ぶ。`;

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

function retireAiReviewCi() {
  const aiReviewSentinel = resolve(workspaceRoot, '.gh-maestro', 'ai-review-ok');
  if (!existsSync(aiReviewSentinel)) return;

  const repoName = getRemoteRepo();
  if (repoName) {
    if (process.env.NODE_TEST_CONTEXT) {
      // テスト実行中（node --test が自動設定し子プロセスへ継承する環境変数）は、
      // GitHub API の DELETE（外部システムへの副作用）を実行しない。
      // Issue #151 の launchAgentHeadless / #202 の msg-send.js と同じフェイルクローズ。
      // フック環境の GIT_* がテストへ漏れて実リポジトリのリモートを解決した場合も、
      // この経路で DELETE に到達しうるため、ここで確実に拒否する（Issue #283）。
      console.warn('  [warn] NODE_TEST_CONTEXT 検出のため GitHub Actions AI Review CI の退役（GitHub API DELETE）をスキップしました。テスト実行中は外部システムへの副作用を実行しません。');
      return;
    }
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
const isFirstRun = () => !existsSync(sentinelPath);

function checkEnvironment() {
  step('Checking prerequisites...');

  // WezTerm はワーカーの起動には使わない（Issue #151 でheadless実行へ移行済み）。
  // 依然として必要なのは assistant（Issue起票と同時に自動起動する対話型ワーカー）だけで、
  // これは `wezterm cli spawn --new-window` で独立ウィンドウとして起動する。
  // WEZTERM_PANE の値自体はもうどこも読まないが、「WezTermが稼働中である」ことの
  // 代理指標として確認する（mux未起動だと --no-auto-start 付きの spawn が失敗するため）。
  if (!process.env.WEZTERM_PANE) {
    fail(
      'WEZTERM_PANE が設定されていません（WezTermが稼働中か確認できません）。',
      '→ WezTerm のペイン内から /gh-maestro を実行してください。',
      '→ すでに WezTerm 内にいる場合は WezTerm が古い可能性があります（v20220807 以降で自動設定）。',
      '   インストール: https://wezfurlong.org/wezterm/installation.html',
      '※ ワーカーはWezTermを使わずバックグラウンドで動きます。WezTermが要るのは',
      '   Issueごとに自動起動する対話型ワーカー assistant のウィンドウのためです。',
    );
  }
  ok('WezTerm session detected (assistant のウィンドウ起動に使用)');

  if (!run('wezterm', ['--version'], { capture: true })) {
    fail(
      'wezterm CLI が PATH に見つかりません（assistant の起動に必要です）。',
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

      // Old version found — replace the block from the marker up to (but
      // excluding) the next blank line or EOF. Blocks written by this
      // function are always blank-line-delimited (created: trailing
      // newline acts as the delimiter; appended: leading '\n' before the
      // new block), so scanning for a blank line finds the real boundary
      // of the OLD block regardless of how many lines the NEW entry has —
      // unlike splicing by entry.length, which silently drifts if the
      // block's line count changes across versions.
      let blockEnd = markerIdx + 1;
      while (blockEnd < lines.length && lines[blockEnd].trim() !== '') blockEnd++;
      lines.splice(markerIdx, blockEnd - markerIdx, ...entry);
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

function ensurePreCommitHook() {
  const hookPath = resolve(workspaceRoot, '.git', 'hooks', 'pre-commit');
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

function ensurePrePushHook() {
  const hookPath = resolve(workspaceRoot, '.git', 'hooks', 'pre-push');

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

/**
 * セットアップ本体。
 *
 * このスクリプトの副作用（git hooks の書き換え・.gitignore 追記・dev ブランチ作成・
 * GitHub API での旧CIファイル削除）は、すべてこの関数の内側に閉じている。
 * かつては全てがトップレベルにあり、`require('./gh-maestro-setup')` するだけで
 * これらが実行された——実際に動作確認のつもりで require され、git hooks が
 * 書き換わる事故が起きた（gh api DELETE まで走りうる状態だった）。
 */
function main() {
  if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  retireAiReviewCi();

  // Sentinel gates only expensive environment checks.
  // Idempotent setup steps (ensure*) run every invocation so new steps
  // apply automatically to existing projects.
  const firstRun = isFirstRun();
  if (firstRun) {
    checkEnvironment();
  }

  prepareDirectories();
  ensureGitIgnore();
  ensureDevBranch();
  ensurePreCommitHook();
  ensurePrePushHook();

  if (firstRun) {
    mkdirSync(resolve(workspaceRoot, '.gh-maestro'), { recursive: true });
    writeFileSync(sentinelPath, '');
    ok('Setup complete (subsequent /gh-maestro invocations will skip environment checks)');
    console.log('\ngh-maestro ready.\n');
  }
}

module.exports = { main };

if (require.main === module) {
  main();
}
