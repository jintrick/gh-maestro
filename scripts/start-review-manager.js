#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
// process-lifecycle への依存は呼び出し時点で解決する（Issue #267）。CLI 主経路
// （require.main === module）から sweepRegistry 経由でこのモジュールが require される
// 可能性を踏まえ、評価時に捕捉すると module.exports 未確定の undefined を掴むため、
// 最初の呼び出し時まで解決を遅らせる。テスト注入（_set*）は注入値が優先される。
let _injectedIsProcessAlive = null;
function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('./process-lifecycle').isProcessAlive;
  return fn(pid);
}
let _injectedVerifyProcessIdentity = null;
function _verifyProcessIdentity(pid, identity, opts) {
  const fn = _injectedVerifyProcessIdentity ?? require('./process-lifecycle').verifyProcessIdentity;
  return fn(pid, identity, opts);
}
let _injectedGetProcessStartTime = null;
function _getProcessStartTime(pid) {
  const fn = _injectedGetProcessStartTime ?? require('./process-lifecycle').getProcessStartTime;
  return fn(pid);
}
const { launchAgentHeadless } = require('./shared/headless-launch');
const { assertValidPr } = require('./shared/review-manager-paths');
const { buildReviewManagerLaunchSpec } = require('./shared/worker-factory');
const { parseFlags } = require('./shared/workspace');
const {
  inspectRunningReviewManager,
  acquireReviewManagerStartup,
  transferReviewManagerStartup,
  releaseReviewManagerStartup,
} = require('./shared/running-review-managers');

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
 * lock ファイルに記録された新形式のPID＋起動時刻が同一プロセスなら true。
 * PIDが死んでいる、またはPID再利用で同一性が不一致な場合は lock ファイルを
 * 内容比較後に削除して false を返す。旧PID-onlyや同一性確認不能なレコードは
 * 削除せず例外（fail-closed）とする。
 *
 * req.13: lock に PID を記録し、生存＋同一性確認で stale 判定
 *
 * @param {string} lockFile
 * @returns {boolean} true = 有効なlock（既に起動済み）, false = stale または lock なし
 */
function isLockValid(lockFile) {
  const result = inspectRunningReviewManager(lockFile, {
    onError: 'throw',
    cleanupStale: true,
    isProcessAliveFn: _isProcessAlive,
    verifyProcessIdentityFn: _verifyProcessIdentity,
  });
  if (result.status === 'legacy-live') {
    throw new Error(
      `既存のmanager.runningが旧形式で生存中のため、Review Managerの同一性を確認できません。` +
      `ファイルを削除せず起動を中止します: ${lockFile}`
    );
  }
  return result.status === 'live';
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

  // manager.runningはReview Manager本体だけが書く。起動側がshimのPIDを
  // manager.runningへ書くと、本体終了時の所有者判定と競合して残留するため、
  // 起動側は隣接するmanager.startingだけを原子的に予約する。
  // manager.runningが本体書き込み前の窓でも、予約を持つ起動だけが先へ進める。
  const startup = acquireReviewManagerStartup(lockFile, {
    pid: process.pid,
    startTime: _getProcessStartTime(process.pid) || null,
    isProcessAliveFn: _isProcessAlive,
    verifyProcessIdentityFn: _verifyProcessIdentity,
  });
  if (!startup.acquired) {
    if (startup.error) throw startup.error;
    return 'REVIEW_MANAGER_ALREADY_RUNNING';
  }

  try {
    // req.13: stale 判定付きで lock チェック
    if (isLockValid(lockFile)) {
      releaseReviewManagerStartup(lockFile, startup.token);
      return 'REVIEW_MANAGER_ALREADY_RUNNING';
    }

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
    env: {
      GH_MAESTRO_WORKER: workerName,
      GH_MAESTRO_WORKSPACE: workspace,
      GH_MAESTRO_REVIEW_MANAGER_STARTUP_TOKEN: startup.token,
    },
    onExit: {
      command: process.execPath,
      args: [path.join(__dirname, 'worker-exit-hook.js'), workspace, ''],
    },
  });

  // manager.runningはここでは書かない。本体が書き込んだ後に起動予約を
  // 解放できるよう、shimのPIDだけをmanager.startingへ引き渡す。
  const transferred = transferReviewManagerStartup(lockFile, startup.token, {
    pid: launched.pid,
    startTime: launched.startTime,
  });
  // 本体が先にmanager.runningを書いて予約を解放した場合はmissingになる。
  // それは正常な並行実行なので、二重起動扱いにはしない。
  if (!transferred.transferred && !transferred.missing) {
    throw new Error(transferred.reason || 'Review Manager起動予約の引き渡しに失敗しました');
  }
  return 'REVIEW_MANAGER_STARTED';
  } catch (e) {
    releaseReviewManagerStartup(lockFile, startup.token);
    throw e;
  }
}

module.exports = {
  startReviewManager,
  isLockValid,
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _injectedVerifyProcessIdentity = fn; },
  _setGetProcessStartTime: (fn) => { _injectedGetProcessStartTime = fn; },
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(args, {
      flags: {},
      booleans: ['--help', '-h'],
      // pr / repo / workspace / issue のちょうど4つの位置引数。未知フラグ・余剰位置引数は
      // パーサ側で拒否される（argv-parsing-pitfalls参照）。
      positionals: { min: 4, max: 4 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`start-review-manager: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
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
