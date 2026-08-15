#!/usr/bin/env node
// gh-maestro per-project setup script
// Validates prerequisites on first run; always applies idempotent setup steps.
// Sentinel (.gh-maestro/setup-ok) only gates expensive environment checks.

const { spawnSync } = require('./child-process');
const { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync, chmodSync } = require('fs');
const { resolve, relative, isAbsolute, sep } = require('path');

const USAGE = `gh-maestro-setup.js — プロジェクトごとの前提条件チェックと初期セットアップ

Usage: node gh-maestro-setup.js [WORKSPACE_ROOT]

Arguments:
  [WORKSPACE_ROOT]  対象プロジェクトのルート（デフォルト CWD）

WezTerm稼働（assistant用）/ git リポジトリ / gh 認証を検証し、.gh-maestro ディレクトリと
.gitignore・dev ブランチ・コミット時の規約同期フックを用意する。フックは git が実際に
使う置き場（core.hooksPath 解決先、未設定なら既定の git ディレクトリ配下）に導入する。
その置き場がプロジェクトの管理対象（共有される）なら書き込まず、必要な呼び出しが既に
存在するかを検証して正直に報告する。初回実行後は sentinel (.gh-maestro/setup-ok) で
環境チェックのみスキップし、冪等なセットアップステップは毎回実行する。通常は
/gh-maestro の起動フックが呼ぶ。`;

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

// フック置き場の判定に使う git の問い合わせ。GIT_* 位置変数の除去は ./child-process の
// 共有ラッパーが実施済み。失敗時は null（呼び出し側がフェイルクローズの判断に使う）。
function gitOutput(args) {
  const r = spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: 'pipe' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

// check-ignore のように exit コードを判定に使う git 呼び出し。`--` で operands を分離し、
// 値が `-` 始まりでもオプションとして解釈されないようにする（git-arg-injection ルール）。
function gitStatus(args) {
  return spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: 'pipe' });
}

function isInsideDir(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
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

/**
 * marker で始まるブロックをフックから削除する（upsertMarkerBlock の逆操作）。
 * ブロック境界の判定は upsertMarkerBlock と同じく「次の空行または EOF まで」。
 * @returns {'absent'|'removed'}
 */
function removeMarkerBlock(hookPath, { markerRe }) {
  if (!existsSync(hookPath)) return 'absent';

  const lines = readFileSync(hookPath, 'utf8').split('\n');
  const markerIdx = lines.findIndex(l => markerRe.test(l.trim()));
  if (markerIdx === -1) return 'absent';

  let blockEnd = markerIdx + 1;
  while (blockEnd < lines.length && lines[blockEnd].trim() !== '') blockEnd++;
  // ブロック直後の空行も1つ畳んで、撤去のたびに空行が溜まらないようにする。
  if (blockEnd < lines.length && lines[blockEnd].trim() === '') blockEnd++;
  lines.splice(markerIdx, blockEnd - markerIdx);

  writeFileSync(hookPath, lines.join('\n'), 'utf8');
  applyExecPermission(hookPath);
  return 'removed';
}

function applyExecPermission(hookPath) {
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    console.warn(`  [warn] ${hookPath} の実行権限設定に失敗しました。手動で chmod +x を実行してください。`);
  }
}

// コミット時の規約同期フック。v2 から「規約文書そのものの同期（sync-agents-md）」と
// 「その結果をコミットに含める処理（git add CLAUDE.md）」も含める。v1 は sync-rules
// のみで、実際に動いているフックと中身が食い違っていた（Issue #282）。
const SYNC_RULES_MARKER = 'gh-maestro:sync-rules:v2';
const SYNC_RULES_MARKER_RE = /^# gh-maestro:sync-rules(:v\d+)?$/;
// Issue #283: フックからのテスト実行は廃止した。git はフック実行時に GIT_DIR 等を
// 環境へ注入し、それを継承したテストが cwd 指定を無視して実リポジトリを破壊しうる。
// フック経由の実行結果がコーダー自身の実行結果と一致する保証が無い以上、
// フックでテストを走らせてはならない。既存の設置済みブロックはここで撤去する。
const CHECKS_MARKER_RE = /^# gh-maestro:checks(:v\d+)?$/;

// 導入の対象になる「git が実際に使うフック置き場」を返す。
// core.hooksPath があればその解決先（相対は git 同様、ワークツリーのトップレベル基準）、
// 無ければ既定の git ディレクトリ配下の hooks。相対解決が cwd ではなくトップレベル
// 基準であることは実地で確認済み。
function resolveHooksDir() {
  const hooksPath = gitOutput(['config', '--get', 'core.hooksPath']);
  if (hooksPath) return resolve(workspaceRoot, hooksPath);

  const gitDir = gitOutput(['rev-parse', '--git-dir']);
  const base = gitDir ? (isAbsolute(gitDir) ? gitDir : resolve(workspaceRoot, gitDir))
                      : resolve(workspaceRoot, '.git');
  return resolve(base, 'hooks');
}

// 「そのフック置き場に書き込むと共有物（コミットされうるファイル）を汚すか」を判定する。
// true なら書き込まず検証報告のみにする。判定は「今追跡ファイルがあるか」ではなく
// 「ワークツリーの内側か（かつ無視対象でないか）」で行う（新規プロジェクトの空ディレクトリ
// でも絶対パス入りファイルのコミット事故を防ぐ）。git 実行が失敗したら安全側（true）に倒す。
function hooksDirNeedsVerification(dir) {
  const toplevel = gitOutput(['rev-parse', '--show-toplevel']);
  if (!toplevel) return true; // フェイルクローズ: 共有されないと確認できなければ書かない

  // ワークツリー外（`..` 始まり・別ドライブの絶対パス）→ コミットされない → 書き込み可。
  const rel = relative(toplevel, dir);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;

  // git ディレクトリ配下（既定 .git/hooks を含む）→ コミットされない → 書き込み可。
  const gitDirs = [gitOutput(['rev-parse', '--absolute-git-dir']),
                   gitOutput(['rev-parse', '--git-common-dir'])];
  for (const g of gitDirs) {
    if (!g) continue;
    const abs = isAbsolute(g) ? g : resolve(toplevel, g);
    if (isInsideDir(abs, dir)) return false;
  }

  // ここまで残った dir はワークツリー内・git ディレクトリ外 → 共有リスク。
  // 無視対象（.gitignore）ならコミットされないので書き込み可、それ以外は書かない。
  const r = gitStatus(['check-ignore', '-q', '--', dir]);
  return !(r.status === 0);
}

// フック本文が「実行される内容」として規約同期を満たしているかを検証し、
// 欠けている項目のラベルを返す。マーカーの有無やパス形式（絶対/相対）は問わず、
// 実際の呼び出しが存在するかで判定する（追跡下の手書きフックはマーカー無し・相対パス）。
// 文字列の部分一致だけでなく、コメント行（# 始まり・シバン）を除外したうえで各呼び出しが
// 「行頭の実行コマンド」として存在するかを確認する。部分一致だけだと、コメントや
// `echo sync-rules.js` のような実行されない文でも「導入済み」と誤報告してしまう
// （この Issue が直そうとしている欠陥を、検証側で別の形で再現しないため）。
function verifySyncInvocations(content) {
  const checks = [
    { label: 'sync-rules 呼び出し', re: /^\s*node\s+["']?[^"'\n]*sync-rules\.js\b/ },
    { label: 'sync-agents-md 呼び出し', re: /^\s*node\s+["']?[^"'\n]*sync-agents-md\.js\b/ },
    { label: '同期結果のコミット反映（git add CLAUDE.md）', re: /^\s*git\s+add\s+CLAUDE\.md\b/ },
  ];
  const executableLines = content.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith('#'));
  return checks.filter(c => !executableLines.some(l => c.re.test(l))).map(c => c.label);
}

// シバン行を除いて本文が空白のみ（実コマンドが1行も無い）なら、廃止後に残った抜け殻と判定。
function isEffectivelyEmptyHook(content) {
  return content.replace(/^#!.*\n?/, '').trim() === '';
}

// 追跡下（共有リスク）のフックに絶対パスを書き込まないために、人間が手動追記すべき
// ブロックを repo-relative パスで提示する（絶対パスは共有物を汚すため使わない）。
function reportManualSyncBlock(hookPath) {
  const toplevel = gitOutput(['rev-parse', '--show-toplevel']) || workspaceRoot;
  let rel = relative(toplevel, hookPath).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  console.warn(
    `\n  [warn] フック置き場がプロジェクトの管理対象のため、setup は書き込みません。` +
    `\n         手動で ${rel} に以下を追記してください（同期の規約がコーダーに届くようにします）:`,
  );
  console.warn(
    '         ```sh\n' +
    '         # gh-maestro:sync-rules:v2\n' +
    `         if git diff --cached --name-only | grep -q '^\\.claude/rules/'; then\n` +
    `           node "scripts/sync-rules.js"\n` +
    '         fi\n' +
    `         if git diff --cached --name-only | grep -q '^AGENTS\\.md$'; then\n` +
    `           node "scripts/sync-agents-md.js"\n` +
    '           git add CLAUDE.md\n' +
    '         fi\n' +
    '         ```',
  );
}

function ensureSyncHook(hooksDir, verifyOnly) {
  const hookPath = resolve(hooksDir, 'pre-commit');

  if (verifyOnly) {
    // 共有リスク → 書き込まず、実行される内容として必要な呼び出しが揃っているかを検証報告。
    if (!existsSync(hookPath)) {
      console.warn('  [warn] pre-commit hook (sync): 未導入です（ファイルがありません）。');
      reportManualSyncBlock(hookPath);
      return;
    }
    const missing = verifySyncInvocations(readFileSync(hookPath, 'utf8'));
    if (missing.length === 0) {
      ok('pre-commit hook (sync): 既に必要な同期の呼び出しが揃っています（tracked; untouched）');
    } else {
      console.warn(`  [warn] pre-commit hook (sync): 未導入: ${missing.join(', ')}`);
      reportManualSyncBlock(hookPath);
    }
    return;
  }

  // 共有リスクなし → 従来どおり設置（v1 ブロックは v2 へ自動置換される）。
  const homedir = require('os').homedir();
  const syncScript = resolve(homedir, '.gh-maestro', 'scripts', 'sync-rules.js');
  const syncAgentsMdScript = resolve(homedir, '.gh-maestro', 'scripts', 'sync-agents-md.js');
  const entryLines = [
    `if git diff --cached --name-only | grep -q '^\\.claude/rules/'; then`,
    `  node "${syncScript}"`,
    `fi`,
    `if git diff --cached --name-only | grep -q '^AGENTS\\.md$'; then`,
    `  node "${syncAgentsMdScript}"`,
    `  git add CLAUDE.md`,
    `fi`,
  ];
  const syncResult = upsertMarkerBlock(hookPath, {
    marker: SYNC_RULES_MARKER,
    markerRe: SYNC_RULES_MARKER_RE,
    entryLines,
  });
  reportHookResult('pre-commit hook (sync)', syncResult);

  if (removeMarkerBlock(hookPath, { markerRe: CHECKS_MARKER_RE }) === 'removed') {
    ok('pre-commit hook (checks): 廃止したため撤去しました');
  }
}

// 実効フック置き場の pre-push から廃止済みの checks ブロックを撤去する（冪等）。
// 撤去後に実コマンドが残らなければ抜け殻なのでファイルごと削除する。
function retireChecksHooks(hooksDir) {
  const prePush = resolve(hooksDir, 'pre-push');
  if (!existsSync(prePush)) return;
  const removed = removeMarkerBlock(prePush, { markerRe: CHECKS_MARKER_RE });
  if (removed === 'removed') ok('pre-push hook (checks): 廃止したため撤去しました');
  if (isEffectivelyEmptyHook(readFileSync(prePush, 'utf8'))) {
    unlinkSync(prePush);
    ok('pre-push hook: 抜け殻（実コマンド無し）のため削除しました');
  }
}

// 実効フック置き場が既定と異なるとき、死んだ既定 .git/hooks/{pre-commit,pre-push} を後始末する。
// gh-maestro マーカー付きブロックを撤去し、実コマンドが残らなければファイルごと削除する。
// 無関係なユーザーフックの中身は残す。
function removeStaleDefaultHooks(hooksDir) {
  const defaultHooks = resolve(workspaceRoot, '.git', 'hooks');
  if (resolve(hooksDir) === resolve(defaultHooks)) return;

  for (const name of ['pre-commit', 'pre-push']) {
    const hookPath = resolve(defaultHooks, name);
    if (!existsSync(hookPath)) continue;
    removeMarkerBlock(hookPath, { markerRe: SYNC_RULES_MARKER_RE });
    removeMarkerBlock(hookPath, { markerRe: CHECKS_MARKER_RE });
    if (isEffectivelyEmptyHook(readFileSync(hookPath, 'utf8'))) {
      unlinkSync(hookPath);
      ok(`default ${name} hook: 実行されない置き場の残骸のため削除しました`);
    }
  }
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
  // 実効フック置き場を一度だけ解決し、設置・撤去・後始末の各処理が同じ場所を扱う。
  // 管理対象（書き込まない契約）の置き場では retireChecksHooks も実行しない——
  // 追跡対象の pre-push を書き換え・削除してはいけない（レビュー指摘への対応）。
  const hooksDir = resolveHooksDir();
  const verifyOnly = hooksDirNeedsVerification(hooksDir);
  ensureSyncHook(hooksDir, verifyOnly);
  if (!verifyOnly) retireChecksHooks(hooksDir);
  removeStaleDefaultHooks(hooksDir);

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
