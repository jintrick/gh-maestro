'use strict';
// push-and-declare.js — ステージング・コミット・push・PR取得/作成・テスト結果申告を
// 分離できない一つの操作として提供する収束型の単一入口（Issue #374）。
//
// コーダーの「修正push」を、push と申告を分離できない一つの操作に置き換えることで、
// 申告（declare-test-result.js）を省く経路を無くす。素の git commit / git push / gh pr create
// をコーダーが直接実行する必要はない（実行しないこと）。
//
// この一連の操作は「終状態への収束」として定義する（順に実行する命令列ではない）。
// 終状態 = 「作業内容がリモートのブランチに載っており、対応するPRが存在し、そのHEADに
// 対する申告が最新である」。各段は「まだ満たされていなければ実行する」条件付きの手段であり、
// 同じコマンドの再実行だけで回復する（「コミットすべき変更が無い」は失敗ではなく
// 「その段は既に満たされている」）。
//
// Usage:
//   node push-and-declare.js --issue <N> --fail <N> --pass <N> [--workspace <path>]
//
// 実行ディレクトリは作業用worktree（$WORKTREE）。ブランチ名 ^issue-<N> との一致を検証する。
//
// コミットメッセージは `impl(issue-<N>): <Issueタイトル>` で固定（モデル推論を挟まない）。
// PRは get-or-create（既存PRがあれば使用、無ければ作成）。PRタイトルは Issueタイトル、
// PR本文は `関連Issue: #<N>`（GitHubのマージ時自動クローズキーワードを含めない。Issueの
// クローズは finalize-issue.js だけが行う）。

const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { resolveGitHead } = require('./shared/git-head');
const { getCurrentBranch } = require('./shared/git-branch');
const { listPrsByBranch, parsePrListResponse } = require('./shared/gh-pr');
const { createPr } = require('./gh-create-pr');
const { declareTestResult } = require('./declare-test-result');

const USAGE = `push-and-declare.js — ステージング・コミット・push・PR取得/作成・テスト結果申告を一つの操作にまとめる

Usage:
  node push-and-declare.js --issue <N> --fail <N> --pass <N> [--workspace <path>]

Arguments:
  --issue <N>          Issue番号（必須、正の整数。実行ブランチ名 ^issue-<N> と一致する必要がある）
  --fail <N>           失敗テスト数（必須、0以上の整数）
  --pass <N>           成功テスト数（必須、0以上の整数）
  --workspace <path>   ワークスペースのルートパス（省略時は環境変数 WORKSPACE、次に
                       GH_MAESTRO_WORKSPACE、次にCWD上方探索で解決）

動作（終状態への収束。同じコマンドの再実行だけで回復する）:
  1. ブランチ検証（^issue-<N>）・リポジトリ特定・Issueタイトル取得
  2. git add -A で worktree 内の全変更をステージ（常に実行）
  3. ステージ済み変更があればコミット（無ければ空コミットを作らずスキップ）
  4. git push -u origin <ブランチ>（up-to-date なら no-op 成功。upstream を自ブランチへ固定）
  5. 現在のHEADを解決
  6. PRは get-or-create（既存PRがあれば使用、無ければ作成。タイトル=Issueタイトル、
     本文=関連Issue: #<N>）
  7. 解決したHEADに対するテスト結果を申告（declare-test-result.js と同じ形式）

コミットメッセージは \`impl(issue-<N>): <Issueタイトル>\` で固定（モデル推論を挟まない）。
素の git commit / git push / gh pr create を直接実行しないこと（このスクリプトが一括で行う）。

Output (stdout):
  作業ブランチ / コミット対象ファイル一覧 / 申告対象コミット / PR番号と作成・既存使用の別 /
  申告の所在 / コミットが作られなかった場合はその事実

終了コード:
  0 = 終状態に到達（テストが赤でも0）
  1 = 用途エラー（引数不正・ブランチ名不一致・テスト実行中。副作用ゼロ）
  2 = 申告に到達する前の失敗（push失敗等。リモート未変更）
  3 = pushは成功したが申告に到達しなかった（リモートは進んだ。再実行で回復）`;

const SPEC = {
  flags: {
    '--issue': { required: true },
    '--fail': { required: true },
    '--pass': { required: true },
    '--workspace': {},
  },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

// GitHubのマージ時自動クローズキーワード（close/closes/closed/fix/fixes/fixed/resolve/
// resolves/resolved）に続いて #番号 が並ぶ形。PR本文にこれを含めると、マージの瞬間に
// Issueが自動クローズされる（Issueをクローズする唯一の手段は finalize-issue.js。orchestrator
// SKILL.md の不変条件に反する）。機械生成する本文はこれを満たしてはならない。
const AUTO_CLOSE_KEYWORD_RE = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*#\d+\b/i;

/**
 * PR本文を組み立てる純粋関数。対象Issueへの参照に留め、マージ時にIssueのクローズを
 * 誘発する自動クローズキーワードを含めない（制約11）。gh-maestro-assistant の
 * `in:body` 検索（Issue番号検索）は満たす。
 * @param {number|string} issue
 * @returns {string}
 */
function buildPrBody(issue) {
  return `関連Issue: #${issue}`;
}

/** spawnSync 結果のエラー文言を組み立てる。 */
function errText(r) {
  const stderr = String(r.stderr || '').trim();
  if (stderr) return stderr;
  const stdout = String(r.stdout || '').trim();
  if (stdout) return stdout;
  return (r.error && r.error.message) || 'unknown error';
}

/**
 * 収束型の単一入口。終状態に到達するまで各段を「まだ満たされていなければ実行」で進める。
 * 申告段が成功するまで exit 0 を返さない（最重要不変条件）。
 *
 * @param {object} params
 * @param {number|string} params.issue   Issue番号
 * @param {number|string} params.fail    失敗テスト数
 * @param {number|string} params.pass    成功テスト数
 * @param {string} [params.workspace]    workspace解決の引数（--workspace または環境変数 WORKSPACE の値）
 * @param {string} params.worktree       作業用worktree（git操作の実行ディレクトリ）
 * @param {object} [params.env]          環境変数（createPr の base 解決に使う。既定 process.env）
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function pushAndDeclare({ issue, fail, pass, workspace, worktree, env = process.env }) {
  // テスト実行中は実副作用（git操作・gh操作・投稿）を機械的に拒否する（Issue #202 の構造的対策）。
  // ワーカーenvがテスト配下の子プロセスへ漏れた場合でも、実リポジトリへ誤ってpush/申告されるのを防ぐ。
  if (process.env.NODE_TEST_CONTEXT) {
    return { exitCode: 1, stdout: '', stderr: 'テスト実行中（NODE_TEST_CONTEXT）のため、実際のpush/申告は行いません' };
  }

  const stdoutLines = [];

  // ── 起動時検証（すべて副作用ゼロ。引数不正は exit 1） ──────────────────────────
  const issueNum = parseInt(issue, 10);
  if (isNaN(issueNum) || issueNum <= 0 || String(issueNum) !== String(issue).trim()) {
    return { exitCode: 1, stdout: '', stderr: `--issue は正の整数で指定してください: ${issue}` };
  }
  const failNum = parseInt(fail, 10);
  if (isNaN(failNum) || failNum < 0 || String(failNum) !== String(fail).trim()) {
    return { exitCode: 1, stdout: '', stderr: `--fail は0以上の整数で指定してください: ${fail}` };
  }
  const passNum = parseInt(pass, 10);
  if (isNaN(passNum) || passNum < 0 || String(passNum) !== String(pass).trim()) {
    return { exitCode: 1, stdout: '', stderr: `--pass は0以上の整数で指定してください: ${pass}` };
  }

  const ws = resolveWorkspace(workspace);
  if (!ws) {
    return { exitCode: 1, stdout: '', stderr: 'ワークスペースを解決できません（--workspace または環境変数 WORKSPACE を確認してください）' };
  }

  // ── 作業ツリー検証 ─────────────────────────────────────────────────────────────
  // このスクリプトは作業用worktree（cwd）から実行される前提。cwd のブランチ名が ^issue-<N>
  // と一致することを検証し、誤ったディレクトリ・誤ったIssue番号での実行を防ぐ。
  let branch;
  try {
    branch = getCurrentBranch(worktree);
  } catch (e) {
    return { exitCode: 2, stdout: '', stderr: `現在のブランチを特定できません: ${e.message}` };
  }
  if (!branch) {
    return { exitCode: 2, stdout: '', stderr: '現在のブランチを特定できません: detached HEAD です' };
  }
  // ブランチ名規約: worker-exit-hook.js と同じ `issue-<N>-<スラッグ>` 形式（例:
  // issue-374-senior-coder-test-declaration）。スラッグ部分の有無を許容する。
  const branchMatch = /^issue-(\d+)(?:-.*)?$/.exec(branch);
  if (!branchMatch || branchMatch[1] !== String(issueNum)) {
    return { exitCode: 1, stdout: '', stderr: `ブランチ名がIssue番号と一致しません: ブランチ="${branch}"、--issue=${issueNum}（^issue-<N> 形式のブランチ上で実行してください）` };
  }

  // リポジトリ特定
  const repoRes = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: ws, encoding: 'utf8' });
  if (repoRes.error || repoRes.status !== 0) {
    return { exitCode: 2, stdout: '', stderr: `リポジトリを特定できません: ${errText(repoRes)}` };
  }
  const repo = String(repoRes.stdout || '').trim();
  if (!repo) {
    return { exitCode: 2, stdout: '', stderr: 'リポジトリ名が空です' };
  }

  // Issueタイトル（コミットメッセージ・新規PRタイトルに使う。決定論的な取得でモデル推論を挟まない）
  const titleRes = spawnSync('gh', ['issue', 'view', String(issueNum), '--json', 'title', '--jq', '.title'], { cwd: ws, encoding: 'utf8' });
  if (titleRes.error || titleRes.status !== 0) {
    return { exitCode: 2, stdout: '', stderr: `Issue #${issueNum} のタイトルを取得できません: ${errText(titleRes)}` };
  }
  const issueTitle = String(titleRes.stdout || '').trim();

  // ── ステージング段（常に実行） ─────────────────────────────────────────────────
  const addRes = spawnSync('git', ['add', '-A'], { cwd: worktree, encoding: 'utf8' });
  if (addRes.error || addRes.status !== 0) {
    return { exitCode: 2, stdout: '', stderr: `git add -A に失敗しました: ${errText(addRes)}` };
  }

  // ステージ済みファイル一覧（出力用。コミット前に記録）
  const nameRes = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: worktree, encoding: 'utf8' });
  const stagedFiles = nameRes.status === 0
    ? String(nameRes.stdout || '').split(/\r?\n/).filter(Boolean)
    : [];

  // ── コミット段（ステージ済み変更がある場合のみ。空コミットは作らない） ─────────
  const diffRes = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: worktree, encoding: 'utf8' });
  if (diffRes.error || (diffRes.status !== 0 && diffRes.status !== 1)) {
    return { exitCode: 2, stdout: '', stderr: `ステージ状態の確認に失敗しました: ${errText(diffRes)}` };
  }
  const hasStagedChanges = diffRes.status === 1;

  let commitCreated = false;
  if (hasStagedChanges) {
    const commitMsg = `impl(issue-${issueNum}): ${issueTitle}`;
    const commitRes = spawnSync('git', ['commit', '-m', commitMsg], { cwd: worktree, encoding: 'utf8' });
    if (commitRes.error || commitRes.status !== 0) {
      return { exitCode: 2, stdout: '', stderr: `git commit に失敗しました: ${errText(commitRes)}` };
    }
    commitCreated = true;
  }

  // ── push段 ─────────────────────────────────────────────────────────────────────
  // worktree作成時（spawn-worker.js 経由）の upstream は origin/<base> に設定されているため、
  // 素の git push（simpleモード）はブランチ名不一致で拒否される。明示的に
  // `git push -u origin <branch>` で押すことで、upstream を自ブランチへ固定しながらpushする。
  const pushRes = spawnSync('git', ['push', '-u', 'origin', branch], { cwd: worktree, encoding: 'utf8' });
  if (pushRes.error || pushRes.status !== 0) {
    const detail = errText(pushRes);
    const hint = /non-fast-forward|\[rejected\]|fetch first/i.test(detail)
      ? '（non-fast-forward: リモートが進んでいます。整合を取ってから再実行してください）'
      : '';
    return { exitCode: 2, stdout: '', stderr: `git push に失敗しました: ${detail}${hint}` };
  }
  // 以降の失敗は「pushは成功したが申告に到達していない」= exit 3（リモートは進んだ）

  // ── SHA解決段 ─────────────────────────────────────────────────────────────────
  let sha;
  try {
    sha = resolveGitHead(worktree);
  } catch (e) {
    return { exitCode: 3, stdout: '', stderr: `HEADの解決に失敗しました: ${e.message}` };
  }

  // ── PR段（get-or-create。初回か修正かをコーダーは判定しない） ─────────────────
  const prListRes = listPrsByBranch(repo, branch, {
    state: 'OPEN',
    json: 'number,url',
    cwd: worktree,
  });
  if (prListRes.error || prListRes.status !== 0) {
    return { exitCode: 3, stdout: '', stderr: `既存PRの検索に失敗しました: ${errText(prListRes)}` };
  }
  let existingPr = null;
  const prs = parsePrListResponse(prListRes.stdout);
  if (!prs) {
    return { exitCode: 3, stdout: '', stderr: '既存PRの検索結果のJSON parseに失敗しました' };
  }
  if (prs.length > 0) {
    existingPr = prs[0];
  }

  let prNumber;
  let prUrl;
  let prAction;
  if (existingPr && existingPr.number) {
    prNumber = existingPr.number;
    prUrl = existingPr.url || '';
    prAction = 'reused';
  } else {
    let createResult;
    try {
      createResult = createPr({ title: issueTitle, body: buildPrBody(issueNum), repo, cwd: worktree, env });
    } catch (e) {
      return { exitCode: 3, stdout: '', stderr: `PRの作成に失敗しました: ${e.message}` };
    }
    if (createResult.status !== 0) {
      return { exitCode: 3, stdout: '', stderr: `PRの作成に失敗しました: ${createResult.stderr || '(no stderr)'}` };
    }
    const urlText = String(createResult.url || '').trim();
    const urlMatch = /\/pull\/(\d+)$/.exec(urlText);
    prNumber = urlMatch ? urlMatch[1] : '';
    prUrl = urlText;
    prAction = 'created';
  }

  // ── 申告段（これが成功するまで exit 0 を返さない） ───────────────────────────
  const declResult = declareTestResult({ pr: prNumber, commit: sha, fail: failNum, pass: passNum, repo, workspace: ws });
  if (!declResult.ok) {
    return { exitCode: 3, stdout: '', stderr: `テスト結果の申告に失敗しました: ${declResult.error}` };
  }

  // ── 出力 ───────────────────────────────────────────────────────────────────────
  stdoutLines.push(`ブランチ: ${branch}`);
  stdoutLines.push(commitCreated
    ? `コミット: ${sha}（新規作成）`
    : 'コミット: なし（ステージ済み変更が無いため、コミットは作成されませんでした）');
  stdoutLines.push(`PR: #${prNumber}（${prAction === 'created' ? '新規作成' : '既存を使用'}） ${prUrl}`);
  stdoutLines.push(`申告: ${declResult.url || ''}（対象コミット ${sha}）`);
  if (stagedFiles.length > 0) {
    stdoutLines.push('コミット対象ファイル:');
    for (const f of stagedFiles) stdoutLines.push(`  ${f}`);
  }

  return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
}

// ── CLI エントリポイント ─────────────────────────────────────────────────────────

function main(argv) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      return { exitCode: 0, stdout: USAGE };
    }
    return { exitCode: 1, stderr: `push-and-declare: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) {
    return { exitCode: 0, stdout: USAGE };
  }

  // --workspace 引数 > 環境変数 WORKSPACE（ワーカー起動時に注入）の順で解決し、
  // resolveWorkspace が残りのフォールバック（GH_MAESTRO_WORKSPACE / CWD探索）を担う。
  const workspace = values['--workspace'] || process.env.WORKSPACE || null;
  const result = pushAndDeclare({
    issue: values['--issue'],
    fail: values['--fail'],
    pass: values['--pass'],
    workspace,
    worktree: process.cwd(),
    env: process.env,
  });
  return result;
}

module.exports = { USAGE, SPEC, AUTO_CLOSE_KEYWORD_RE, buildPrBody, pushAndDeclare, main };

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
