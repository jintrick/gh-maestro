#!/usr/bin/env node
// Usage: node poll-pr.js <ISSUE> [--workspace <path>] [--session-pid <pid>] [--base-branch <branch>] [INTERVAL_SECONDS]
// Polls until a PR for the given issue is found, then launches the reviewer (heavy mode:
// all review aspects, Review Manager自身が実際のdiffを見て判断する — Issueのファイル名
// パターンでオーケストレーターや機械的ロジックが観点を絞り込むことはしない）
// and bridges into poll-reviews.js as a child process. Prints:
//   PR_BASE_MISMATCH:<PR>:<expected>:<actual>  (only when --base-branch and actual base branch mismatch)
//   PR_DETECTED:<number>
//   REVIEW_MANAGER_STARTED:<number> | REVIEW_MANAGER_ALREADY_RUNNING:<number>
//   ...poll-reviews.js の出力がそのまま続く（REVIEW_COMMENT / PR_COMMENT / PR_REVIEW / PR_PUSH / PR_MERGED / POLL_ERROR / POLL_RECOVERED）
'use strict';

const path = require('path');
const { spawnSync } = require('./child-process');
const { startReviewManager } = require('./start-review-manager');
const { resolveWorkspace, parseFlags, hasHelpFlag } = require('./shared/workspace');
const {
  resolveSessionPid,
  createDeadManSwitch,
  registerProcess,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');

const USAGE = `poll-pr.js — Issue に対応する PR を検出し、検出時にレビュアーを起動し、
その後 poll-reviews.js に処理を橋渡ししてレビュー監視を続行する

Usage: node poll-pr.js <ISSUE> [--workspace <path>] [--session-pid <pid>] [--base-branch <branch>] [INTERVAL_SECONDS]

Arguments:
  <ISSUE>             対象の Issue 番号（必須）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Options:
  --no-review-manager        PR検出時に Review Manager を起動せず、レビュー監視だけを再開する。
                             既にレビュー済み／再レビュー不要な状態で poll-pr.js を再起動するときに使う
                             （再起動のたびにレビューを蒸し返すのを防ぐ）。
  --workspace <path>         ワークスペースパス（省略時は環境変数またはCWDから解決）
  --session-pid <pid>        監視対象のセッションPID（dead-man's switch用。省略時は自動検出）
  --base-branch <branch>     期待するベースブランチ名（省略時はベースブランチ検証をスキップ）

Output (stdout):
  PR_BASE_MISMATCH:<PR>:<expected>:<actual>  ベースブランチ不一致を検出（--base-branch指定時のみ）
  PR_DETECTED:<PR>                     PR を検出した
  REVIEW_MANAGER_STARTED:<PR>          Review Manager を起動した
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>  Review Manager は既に稼働中
  以降、poll-reviews.js を子プロセスとして起動し、その標準出力（REVIEW_COMMENT/PR_COMMENT/
  PR_REVIEW/PR_PUSH/PR_MERGED）をそのまま中継する。poll-reviews.js の終了とともに終了する。

PR が見つかるまでブロックし、見つけたら Review Manager(start-review-manager.js)をheavyモード
（全観点。skills/gh-maestro-reviewer/SKILL.md参照）で起動し、続けて poll-reviews.js を
子プロセスとして起動してレビュー監視を引き継いでから終了する。観点を絞り込む判断は
Review Manager自身が実際のdiffを見た上で行う（本スクリプトはファイルパターン等による
機械的な観点選定を一切行わない。ファイル名に基づく自動判定が一部の観点だけに絞り込んでしまい
他の観点のレビューが丸ごと欠落する実障害があったため、この責務はオーケストレーター側からは
完全に排除した）。
ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
消滅時はPID registryを解除して自動exitする。`;

/**
 * poll-reviews.js を子プロセスとして起動し、その標準出力/標準エラーを自プロセスへ
 * 中継しながら終了を待つ。シェルのパイプ+ループではなくNode内の子プロセスとして
 * 起動することで、サブシェルの変数スコープ問題を避ける（Issue #111）。
 *
 * @param {string} pr
 * @param {string} workspace
 * @param {string|number} sessionPid
 * @returns {number} poll-reviews.js の終了コード（不明な場合は1）
 */
function spawnPollReviews(pr, workspace, sessionPid) {
  const args = [path.join(__dirname, 'poll-reviews.js'), pr, workspace, '--session-pid', String(sessionPid)];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  return typeof result.status === 'number' ? result.status : 1;
}


/**
 * gh 経由でPRのベースブランチ名を取得する。
 * @param {string} pr
 * @param {string} repo
 * @returns {string} ベースブランチ名、取得失敗時は空文字列
 */
function getPrBaseBranch(pr, repo) {
  const r = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
    '--json', 'baseRefName', '-q', '.baseRefName'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('poll-pr: PR #' + pr + ' のベースブランチ取得に失敗しました（gh pr view）: ' + (r.stderr || '').toString().trim());
    return '';
  }
  return (r.stdout || '').trim();
}

/**
 * PR検出時にベースブランチの不一致を検出する（純粋関数）。
 * @param {string} expectedBaseBranch --base-branch で指定された想定ブランチ
 * @param {string} actualBaseBranch   PRの実際のベースブランチ
 * @param {string} pr                 PR番号
 * @returns {string|null} 不一致時は PR_BASE_MISMATCH 行、一致時は null
 */
function formatBaseBranchMismatch(expectedBaseBranch, actualBaseBranch, pr) {
  if (!expectedBaseBranch) return null;
  // 実際のベースブランチが取得できない場合は (unknown) として報告（fail-closed）
  if (!actualBaseBranch) return 'PR_BASE_MISMATCH:' + pr + ':' + expectedBaseBranch + ':(unknown)';
  if (expectedBaseBranch === actualBaseBranch) return null;
  return 'PR_BASE_MISMATCH:' + pr + ':' + expectedBaseBranch + ':' + actualBaseBranch;
}

module.exports = { getPrBaseBranch, formatBaseBranchMismatch, spawnPollReviews };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--workspace', '--session-pid', '--base-branch'], ['--no-review-manager']);

  // exitFlagMiss（値欠落）を先に判定する。未消費の値トークンが rest に残るため、
  // それがたまたま "--help" と一致すると後段の hasHelpFlag が誤検出しうる。
  // 値欠落は常にエラー優先（フェイルクローズ）とする。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  const workspaceArg = values['--workspace'];
  const sessionPidArg = values['--session-pid'];
  const baseBranch = values['--base-branch'];
  const noReviewManager = values['--no-review-manager'] === true;

  const [issue, intervalArg] = rest;

  if (!issue) {
    console.error(USAGE);
    process.exit(1);
  }

  const interval = parseInt(intervalArg || '30') * 1000;

  const workspace = resolveWorkspace(workspaceArg);
  if (!workspace) {
    console.error('poll-pr: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    process.exit(1);
  }

  const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', cwd: workspace }).stdout.trim();

  // ── ライフサイクル管理 ─────────────────────────────────────────────────

  const sessionPid = resolveSessionPid(sessionPidArg);
  const checkParent = createDeadManSwitch(sessionPid);

  // PID registry に自己登録
  registerProcess(workspace, { script: 'poll-pr.js' });

  // cleanup: registry 解除 + exit
  function cleanup(code = 0) {
    lifecycleCleanup(workspace);
    process.exit(code);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  function findPR() {
    let r = spawnSync('gh', ['pr', 'list', '--repo', repo,
      '--search', `head:issue-${issue}`, '--state', 'open',
      '--json', 'number', '-q', '.[0].number'], { encoding: 'utf8' });
    const pr = r.stdout.trim();
    if (pr) return pr;

    r = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open',
      '--json', 'number,body', '-q',
      `.[] | select(.body | strings | contains("#${issue}")) | .number`],
      { encoding: 'utf8' });
    return r.stdout.trim().split('\n').find(s => s.trim()) || '';
  }

  (async () => {
    while (true) {
      // dead-man's switch: 親セッション生存確認
      if (!checkParent()) {
        console.error(`poll-pr: parent session (pid ${sessionPid}) is dead — exiting`);
        cleanup();
        return; // unreachable（cleanup が process.exit する）
      }

      const pr = findPR();
      if (pr) {
        // ベースブランチ検証: --base-branch が指定されていれば検出したPRの
        // 実際のベースブランチと比較し、不一致なら警告を出力する（処理は継続）。
        if (baseBranch) {
          const actualBase = getPrBaseBranch(pr, repo);
          const mismatch = formatBaseBranchMismatch(baseBranch, actualBase, pr);
          if (mismatch) {
            process.stdout.write(mismatch + "\n");
          }
        }

        process.stdout.write(`PR_DETECTED:${pr}\n`);

        // --no-review-manager のときは Review Manager を起動せず、レビュー監視だけを再開する。
        if (!noReviewManager) {
          // 常にheavyモード（全観点）で起動する。観点を絞り込むかどうかの判断は
          // Review Manager自身が実際のdiffを見た上で行う（skills/gh-maestro-reviewer/SKILL.md参照）。
          // オーケストレーター側・本スクリプト側でファイルパターン等から機械的に観点を
          // 決定することは行わない。
          const reviewStatus = startReviewManager(pr, repo, workspace);
          process.stdout.write(`${reviewStatus}:${pr}\n`);
        }

        // poll-pr.js と poll-reviews.js は内部ロジックを統合せず、それぞれ独立に保つ。
        // 代わりにここで poll-reviews.js を子プロセスとして起動し、終了まで中継する（Issue #111）。
        const exitCode = spawnPollReviews(pr, workspace, sessionPid);
        cleanup(exitCode);
        return; // unreachable
      }
      await new Promise(r => setTimeout(r, interval));
    }
  })();
}
