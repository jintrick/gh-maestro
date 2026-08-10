#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
let _isProcessAlive = require('./process-lifecycle').isProcessAlive;
const { launchAgentHeadless } = require('./shared/headless-launch');
const { assertValidPr } = require('./shared/review-manager-paths');
const { buildReviewManagerLaunchSpec } = require('./shared/worker-factory');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const USAGE = `start-review-manager.js — PRに対してReview Managerを起動する

Usage: node start-review-manager.js <PR> <REPO> <WORKSPACE> <ISSUE>

Arguments:
  <PR>         レビュー対象の PR 番号
  <REPO>       GitHub リポジトリ（owner/repo）
  <WORKSPACE>  ワークスペースの絶対パス
  <ISSUE>      アンカー Issue 番号（起動直後クラッシュ等の異常終了通知の投稿先）

Review Managerは7葉のレビュー基準を評価し、PR diffに基づいて関連する葉を adopted /
excluded に分類した上で、採用葉のレビュージョブを動的に分割・並列実行する。
Node.jsの決定論的ツール（run-review-jobs.js / finalize-review.js）がジョブの起動・
状態記録・完全性ゲート検証・成果物書き出しを機械的に行う（skills/gh-maestro-reviewer/SKILL.md参照）。

Output:
  REVIEW_MANAGER_STARTED:<PR>
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>

起動要求そのものの失敗（ロック解放済み・入力不正等）以外は、この時点で成否を判定しない。
Review Managerは通常ワーカーと同じ起動基盤（shared/headless-launch.js）・同じ終了フック
（worker-exit-hook.js）で起動する。エージェントCLIの起動失敗やレビュー実行中のクラッシュ
（非ゼロ終了）は、通常ワーカーと同様、終了フックが <ISSUE> へのIssueコメントとして
非同期に通知する。この通知はログインシェルのコマンド連鎖自体に組み込まれているため、
呼び出し元（poll-pr.js）が何をしていても（poll-reviews.jsをブロッキング起動中でも）
確実に発火する。呼び出し元はこの通知を待つ必要がなく、PR/レビューコメント監視を
中断せずに継続できる。`;

/**
 * lock ファイルが有効かチェックする。
 * lock ファイルに記録されたPIDが生存していれば true（既に起動済み）。
 * PIDが死んでいる（stale）場合は lock ファイルを削除して false を返す。
 *
 * req.13: lock に PID を記録し、生存＋同一性確認で stale 判定
 *
 * @param {string} lockFile
 * @returns {boolean} true = 有効なlock（既に起動済み）, false = stale または lock なし
 */
function isLockValid(lockFile) {
  if (!fs.existsSync(lockFile)) return false;

  let lockPid;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    lockPid = parseInt(raw, 10);
  } catch {
    // lock ファイル破損 → stale 扱い
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  if (!Number.isFinite(lockPid) || lockPid <= 0) {
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  if (_isProcessAlive(lockPid)) return true;

  // プロセスは死んでいる → stale lock
  try { fs.unlinkSync(lockFile); } catch {}
  return false;
}

/**
 * @param {string} pr
 * @param {string} repo
 * @param {string} workspace
 * @param {string|number} issue アンカーIssue番号。異常終了通知の投稿先として終了フックへ渡す。
 */
function startReviewManager(pr, repo, workspace, issue) {
  // 副作用（lock書き込み）の前に入力を検証する（fail-closed）。
  // pr はファイルパス構成要素として使われるため、厳密な正整数であることを
  // ここで確定させる（PR #84 Review指摘: pathトラバーサル対策）。
  assertValidPr(pr);

  // Phase 5: パス計算を factory（buildReviewManagerLaunchSpec）に一元化する。
  // workerName・ログパス・leaseパスの一貫性が保証され、
  // 「識別子がファイルごとに別々に手書きされる」不具合パターンを防ぐ。
  // assertValidIssue は factory 内部で検証される。
  const spec = buildReviewManagerLaunchSpec({ issue, pr, repo, workspace });
  const workerName = spec.workerName;
  const lockFile = spec.leaseStore;
  const logPath = spec.logPath;

  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });

  // req.13: stale 判定付きで lock チェック
  if (isLockValid(lockFile)) return 'REVIEW_MANAGER_ALREADY_RUNNING';

  // 通常ワーカーと同じ execution registry（.gh-maestro/executions.json）には乗せない。
  // registryの'completed'はmarkCommentResult（msg-send.js --execution-id経由の投稿成功）
  // でのみ到達する契約だが、Review Managerはfindings JSONを書いて終了するだけでこの
  // 投稿を一度も行わない。executionIdを渡すとworker-exit-hook.jsが終了コードに関係なく
  // markProcessExitを呼び、成功終了（exit 0）でも'process_failed'に誤記録される
  // （PRレビュー指摘）。onExitへexecutionIdを渡さない（空文字）ことでこの記録処理自体を
  // スキップする。クラッシュ通知（下記onExitの2.）はexecutionIdに依存しないため影響しない。
  // 通常ワーカーと同じ起動基盤（ログインシェル経由・onExitフック）で起動する。
  // PR #172時点ではここで独自にdetached spawnし、起動直後の生存を時間ベースの
  // ヒューリスティックで確認していたが、レビュー評価の指摘の通りこれは本質的に脆い
  // （worktree構築時間がリポジトリごとに変わるため、猶予をどう設定しても取りこぼしうる）。
  // 通常ワーカーが既に使っている、ログインシェルのコマンド連鎖自体に組み込まれた
  // onExitフック（呼び出し元の状態に一切依存せず確実に発火する）に乗せることで、
  // タイムアウトに頼らず起動直後から実行完了までの全期間のクラッシュを検出できる。
  const launched = launchAgentHeadless({
    // Phase 5: ISSUE を run-review-manager.js へ構造化引数として渡す。
    // shell文字列の再構築を避け、argv配列で直接渡す（argv-parsing-pitfalls ルール準拠）。
    argv: [process.execPath, path.join(__dirname, 'run-review-manager.js'), pr, repo, workspace, String(issue)],
    cwd: workspace,
    logPath,
    env: { GH_MAESTRO_WORKER: workerName, GH_MAESTRO_WORKSPACE: workspace },
    onExit: {
      command: process.execPath,
      args: [path.join(__dirname, 'worker-exit-hook.js'), workspace, ''],
    },
  });

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(launched.pid));
  return 'REVIEW_MANAGER_STARTED';
}

module.exports = {
  startReviewManager,
  isLockValid,
  _setIsProcessAlive: (fn) => { _isProcessAlive = fn; },
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const { rest, exitFlagMiss } = parseFlags(args, []);

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

  const [pr, repo, workspace, issue] = rest;
  if (!pr || !repo || !workspace || !issue || rest.length > 4) {
    console.error(USAGE);
    process.exit(1);
  }

  try {
    process.stdout.write(`${startReviewManager(pr, repo, workspace, issue)}:${pr}\n`);
  } catch (e) {
    console.error(`start-review-manager: ${e.message}`);
    process.exit(1);
  }
}
