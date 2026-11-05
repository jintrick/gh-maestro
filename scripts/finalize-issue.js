#!/usr/bin/env node
'use strict';
// finalize-issue.js
// 反省会が完了した後に呼ぶ、決定的な最終後始末。
//   1. 決定事項をIssueへ投稿する
//   2. 指定 Issue に紐づく全ワーカーを remove-worker.js 経由で削除する（取りこぼし防止）
//   3. Issue をクローズする
// 判断（反省会・コーダー意見聴取・ルール提案・承認反映）は orchestrator 側の責務であり、
// このスクリプトは機械的な投稿と後始末だけを担う。反省会が済む前に呼んではならない。
//
// Usage:
//   node finalize-issue.js --issue <N> --decision-file <path> [--repo <owner/repo>] [--workspace <path>]

const path = require('path');
const crypto = require('crypto');
const { readFileSync, existsSync, rmSync, statSync } = require('fs');
const childProcess = require('./shared/child-process');
const { spawnSync } = childProcess;
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { reviewArtifactPath } = require('./shared/review-manager-paths');
const { ARTIFACTS, recordPath } = require('./shared/record-paths');
const { pruneExecutionsForIssue } = require('./shared/execution-registry');
const { readWorkersRaw } = require('./shared/workers-registry');
const { clearPrMonitorTarget } = require('./shared/pr-monitor-target');
const { toWinPath } = require('./shared/win-path');
const { resolveRepo } = require('./shared/repo');
const { reviewResultMarker } = require('./shared/review-result-marker');
const { commentIssueBody } = require('./comment-issue');

const USAGE = `finalize-issue.js — Issue をクローズし、そのIssueの全ワーカーを削除する

Usage: node finalize-issue.js --issue <N> --decision-file <path> [--repo <owner/repo>] [--workspace <path>]

Options:
  --issue <N>          クローズ対象の Issue 番号（正の整数）
  --decision-file <path> Issueへ先に投稿する決定事項本文ファイル（UTF-8、必須、空は禁止）
  --repo <owner/repo>  対象リポジトリ（省略時は workspace の git remote から解決）
  --workspace <path>   ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または CWD から上方探索で解決）

反省会が完了した後にだけ呼ぶこと。決定事項をIssueへ投稿した後、Issueに紐づく全ワーカーを
remove-worker.js 経由で削除し、そのあと Issue をクローズする。コメント投稿失敗時は後始末しない。
実行前に既存コメントを照合し、照合に失敗した場合は投稿も後始末もせず停止する。同じ決定事項の
再実行ではコメントを重複投稿せず、後始末から再開する。投稿済みと認めるのは、ghの認証ユーザーが
マーカーを含む決定事項の全文を投稿した場合だけである。
ワーカー削除は best-effort（一部失敗しても続行し、Issueは閉じる）。

さらに、このIssueの --issue で起動された監視ペインを close-pane 経由で終了する。
worker worktree ごとの終了に失敗した場合は、そのworkerを削除せずIssueのクローズを中止する（非0終了）。
メイン workspace のペインはbest-effortで終了する。別Issueのペインや起動Issueを確認できない旧形式の記録は終了しない。

さらに、ライフサイクル終了後の情報価値のない内部状態を後始末する（Issue #248・すべて best-effort）:
- .gh-maestro/assistant-watch/<N>.json を削除
- このIssueに紐づくPRの .gh-maestro/review-manager-<PR>.incomplete を削除
  （PR発見は gh pr list --search head:issue-<N> --state all → 本文 "#<N>" フォールバック）
- .gh-maestro/executions.json の当該Issueレコードを間引き（ファイル自体は残す）
- 対象PRの records/pr/<PR>/review/manager.json（レビュー結果）は、PRのレビュー本文に
  掲載の印（manager.json のSHA-256を含む）が認証ユーザーの投稿として存在することを確かめられた場合だけ削除する。
  確かめられない場合（未掲載・印の無い旧形式・照合失敗・PR特定失敗）は残し、理由を出す

Output (stdout):
  REVIEW_ARTIFACT_REMOVED:pr=<PR>                 manager.json を削除した（掲載を確認済み）
  REVIEW_ARTIFACT_KEPT:pr=<PR|?> reason=<理由>    manager.json を残した（人間が理由を確認する）
  FINALIZED:<N> removed=<削除成功数>/<対象数> closed=<true|false>`;

/**
 * workers.json から、指定 Issue に紐づくワーカー名を列挙する（orchestrator 自身は除く）。
 * @param {string} workspace
 * @param {string|number} issue
 * @returns {string[]}
 */
function collectWorkersForIssue(workspace, issue) {
  const workers = readWorkersRaw(workspace);
  if (!workers) return [];
  const target = String(issue);
  const names = [];
  for (const [name, entry] of Object.entries(workers)) {
    if (name === 'orchestrator') continue;
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.issue) === target) names.push(name);
  }
  return names;
}

// 既定の削除処理: remove-worker.js をサブプロセスで呼ぶ（テスト済みの単体削除ロジックを再利用）。
function defaultRemoveWorker(workspace, workerName) {
  const r = spawnSync(process.execPath, [
    path.join(__dirname, 'remove-worker.js'),
    workerName,
    '--workspace', workspace,
  ], { encoding: 'utf8' });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').trim() };
}

// 既定のクローズ処理: gh issue close。
function defaultCloseIssue(issue, repo, workspace) {
  const args = ['issue', 'close', String(issue)];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { cwd: workspace, encoding: 'utf8' });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').trim() };
}

// 既定の監視ペイン終了処理。worker-status.js側で起動時Issueを検証するため、
// finalize-issueがstatus-pane.jsonを直接kill・削除する経路は持たない。
function defaultCloseStatusPane(workspace, issue) {
  const r = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, 'worker-status.js'),
    'close-pane',
    '--workspace', workspace,
    '--issue', String(issue),
  ], { cwd: workspace, encoding: 'utf8' });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').trim() };
}

/**
 * PR本文が特定Issue番号を参照しているかを判定する（`#<issue>` の厳密一致）。
 * 前方一致を防ぐため、`#<issue>` の直後に数字が続かないこと（単語境界）を要求する:
 * 例: `#1` は `#12`・`#123` 等に誤マッチしない（Issue #248レビュー指摘）。
 * @param {unknown} body
 * @param {string|number} issue
 * @returns {boolean}
 */
function bodyReferencesIssue(body, issue) {
  if (typeof body !== 'string') return false;
  return new RegExp(`#${issue}(?![0-9])`).test(body);
}

function decisionCommentMarker(issue, decisionBody) {
  const digest = crypto.createHash('sha256')
    .update(`${issue}\0${decisionBody}`, 'utf8')
    .digest('hex');
  return `<!-- gh-maestro:finalize-decision:v1:${issue}:${digest} -->`;
}

function decisionCommentBody(issue, decisionBody) {
  const body = decisionBody.replace(/\s+$/u, '');
  return `${body}\n\n${decisionCommentMarker(issue, decisionBody)}`;
}

function isGitHubLogin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value);
}

function runGhApiRead(spawnFn, args, workspace, purpose) {
  let result;
  try {
    result = spawnFn('gh', args, { cwd: workspace, encoding: 'utf8', timeout: 30000 });
  } catch (error) {
    throw new Error(`${purpose}: ${error.message}`);
  }
  if (!result || result.error || result.status !== 0) {
    throw new Error(`${purpose}: ${result && result.error && result.error.message || result && result.stderr || 'gh api failed'}`);
  }
  return String(result.stdout || '');
}

// 認証ユーザーの login を取得する（照合の基準。取得できなければ例外）。
// 決定事項コメントの照合とレビュー掲載の照合の両方が共用する。
function readAuthenticatedLogin(spawnFn, workspace) {
  const authOutput = runGhApiRead(spawnFn, ['api', 'user', '--jq', '.login'], workspace, 'GitHub認証ユーザーの取得に失敗しました');
  const authLines = authOutput.trim().split(/\r?\n/);
  const authenticatedLogin = authLines.length === 1 ? authLines[0] : '';
  if (!isGitHubLogin(authenticatedLogin)) {
    throw new Error('GitHub認証ユーザーを取得できないため、投稿を安全に照合できません');
  }
  return authenticatedLogin;
}

// 一覧エンドポイント（Issueコメント・PRレビュー等）の { login, body } を全件読む。
// 1件でも解釈できなければ例外（照合の見落としにしない）。
function readPagedLoginBodies(spawnFn, endpoint, workspace, failurePurpose) {
  const commentOutput = runGhApiRead(
    spawnFn,
    ['api', '--paginate', endpoint, '--jq', '.[] | {login: .user.login, body: .body} | @json | @base64'],
    workspace,
    failurePurpose,
  );
  const lines = commentOutput.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    let encoded = line;
    try {
      const parsedLine = JSON.parse(line);
      if (typeof parsedLine === 'string') encoded = parsedLine;
    } catch { /* gh --jq may emit a scalar either raw or JSON-quoted */ }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error(`${failurePurpose}: 照合結果 ${index + 1} 件目が不正なBase64です`);
    }
    let comment;
    try {
      comment = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch (error) {
      throw new Error(`${failurePurpose}: 照合結果 ${index + 1} 件目をJSONとして読めません: ${error.message}`);
    }
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)
      || typeof comment.body !== 'string') {
      throw new Error(`${failurePurpose}: 照合結果 ${index + 1} 件目から本文を取得できません`);
    }
    return { login: comment.login, body: comment.body };
  });
}

function resolveRepoOrThrow(repo, workspace, deps = {}) {
  const resolveRepoFn = deps.resolveRepoFn || resolveRepo;
  const resolvedRepo = resolveRepoFn({ repo, workspace }, deps.repoDeps || {});
  if (!resolvedRepo || !resolvedRepo.ok || !resolvedRepo.repo) {
    throw new Error(`照合に使うリポジトリを解決できません: ${resolvedRepo && resolvedRepo.error || 'unknown'}`);
  }
  return resolvedRepo.repo;
}

function defaultReadIssueComments({ issue, repo, workspace }, deps = {}) {
  const resolvedRepo = resolveRepoOrThrow(repo, workspace, deps);
  const spawnFn = deps.spawnSyncFn || spawnSync;
  const authenticatedLogin = readAuthenticatedLogin(spawnFn, workspace);
  const comments = readPagedLoginBodies(
    spawnFn,
    `repos/${resolvedRepo}/issues/${issue}/comments`,
    workspace,
    'Issueコメントの照合に失敗しました',
  );
  return { authenticatedLogin, comments };
}

/**
 * PRのレビュー本文に掲載の印（reviewResultMarker）が、認証ユーザーの投稿として存在するかを確かめる。
 * 照合できないときは例外を投げる（呼び出し側は「掲載を確かめられない」として manager.json を残す）。
 * @param {{pr: number|string, repo: string|null, workspace: string, marker: string}} params
 * @param {{resolveRepoFn?: Function, repoDeps?: object, spawnSyncFn?: Function}} [deps]
 * @returns {{posted: boolean}}
 */
function defaultFindReviewResultPosted({ pr, repo, workspace, marker }, deps = {}) {
  const resolvedRepo = resolveRepoOrThrow(repo, workspace, deps);
  const spawnFn = deps.spawnSyncFn || spawnSync;
  const authenticatedLogin = readAuthenticatedLogin(spawnFn, workspace).toLowerCase();
  const reviews = readPagedLoginBodies(
    spawnFn,
    `repos/${resolvedRepo}/pulls/${pr}/reviews`,
    workspace,
    'PRレビューの照合に失敗しました',
  );
  return {
    posted: reviews.some((review) => (
      typeof review.login === 'string'
      && review.login.toLowerCase() === authenticatedLogin
      && review.body.includes(marker)
    )),
  };
}

function defaultFindDecisionPosted({ issue, repo, workspace, decisionBody }, deps = {}) {
  const readCommentsFn = deps.readIssueCommentsFn || defaultReadIssueComments;
  const result = readCommentsFn({ issue, repo, workspace }, deps.readIssueCommentsDeps || {});
  if (!result || !isGitHubLogin(result.authenticatedLogin) || !Array.isArray(result.comments)) {
    throw new Error('GitHub認証ユーザーまたはIssueコメントの照合結果を取得できません');
  }
  if (result.comments.some((comment) => !comment || typeof comment !== 'object'
    || typeof comment.body !== 'string')) {
    throw new Error('Issueコメントの本文を取得できないため、決定事項を安全に照合できません');
  }

  const expectedBody = decisionCommentBody(issue, decisionBody);
  const authenticatedLogin = result.authenticatedLogin.toLowerCase();
  return {
    posted: result.comments.some((comment) => (
      typeof comment.login === 'string'
      && comment.login.toLowerCase() === authenticatedLogin
      && comment.body === expectedBody
    )),
  };
}

// 既定の対象PR発見処理: Issueに紐づくPR番号を列挙する（poll-pr.js / assistant-watch.js と同一の2段構え）。
// 1. head:issue-<N>（worktreeブランチ命名規約による厳密一致。worker-entry.js参照）
// 2. フォールバック: bodyが "#<N>" を参照するもの（#<N> の直後に数字が続かない単語境界で厳密一致。
//    bodyReferencesIssue 参照。GitHub全文検索のあいまい一致は使わない——生の数字だけで検索すると
//    無関係PRの本文中のバージョン番号等に誤マッチしうる）
// --state all でクローズ済みPRも含めて発見する（.incomplete 後始末はクローズ後でも行いたい）。
// 一覧を得られなかった（gh失敗・出力が解釈できない）ときは例外を投げる。空配列は「該当PRが無い」
// という確定した事実だけに使い、検索の失敗を0件と取り違えない（manager.json の残存理由を正しく出すため）。
function defaultFindReviewPrs(issue, repo, workspace, spawnFn = spawnSync) {
  // 2つの検索（head と本文）のどちらかが失敗したら例外にする。片方の失敗を、もう片方の
  // 成功（空配列を含む）で打ち消さない。両方が成功して対象なしのときだけ空配列を返す。
  const prArgs = ['pr', 'list', '--search', `head:issue-${issue}`, '--state', 'all', '--json', 'number'];
  if (repo) prArgs.unshift('--repo', repo);
  const headResult = spawnFn('gh', prArgs, { cwd: workspace, encoding: 'utf8' });
  if (headResult.status !== 0) {
    throw new Error(`head:issue-${issue} のPR検索に失敗しました: ${(headResult.stderr || '').trim() || `gh exit ${headResult.status}`}`);
  }
  let found;
  try {
    found = JSON.parse(headResult.stdout || '[]');
  } catch (error) {
    throw new Error(`head:issue-${issue} のPR検索結果を解釈できません: ${error.message}`);
  }
  if (!Array.isArray(found)) {
    throw new Error(`head:issue-${issue} のPR検索結果の形式が不正です`);
  }
  if (found.length > 0) {
    return found.map((p) => p.number).filter((n) => n != null);
  }

  const bodyArgs = ['pr', 'list', '--state', 'all', '--json', 'number,body'];
  if (repo) bodyArgs.unshift('--repo', repo);
  const bodyResult = spawnFn('gh', bodyArgs, { cwd: workspace, encoding: 'utf8' });
  if (bodyResult.status !== 0) {
    throw new Error(`本文参照のPR一覧を取得できません: ${(bodyResult.stderr || '').trim() || `gh exit ${bodyResult.status}`}`);
  }
  let all;
  try {
    all = JSON.parse(bodyResult.stdout || '[]');
  } catch (error) {
    throw new Error(`本文参照のPR一覧を解釈できません: ${error.message}`);
  }
  if (!Array.isArray(all)) {
    throw new Error('本文参照のPR一覧の形式が不正です');
  }
  return all
    .filter((p) => bodyReferencesIssue(p.body, issue))
    .map((p) => p.number)
    .filter((n) => n != null);
}

/**
 * PR の manager.json（レビュー結果）を、掲載済みであることを確かめられたときだけ破棄する。
 * 掲載の印（reviewResultMarker）は manager.json のバイト列から作るため、ファイルが書き換わっていれば一致しない。
 * 確かめられない（未掲載・照合失敗・読み取り失敗・削除失敗）ときは残し、理由を返す（ADR 0059）。
 * @returns {{pr: number|string, action: 'none'|'removed'|'kept', reason?: string}}
 */
function cleanupReviewArtifact({ workspace, pr, repo, findReviewResultPostedFn }) {
  let artifactPath;
  try {
    artifactPath = reviewArtifactPath(workspace, pr, '.json');
  } catch (e) {
    return { pr, action: 'kept', reason: `不正なPR番号のため manager.json を特定できません: ${e.message}` };
  }
  let stat;
  try {
    stat = statSync(artifactPath);
  } catch (e) {
    if (e.code === 'ENOENT') return { pr, action: 'none' };
    return { pr, action: 'kept', reason: `manager.json の状態を確認できません: ${e.message}` };
  }
  if (!stat.isFile()) {
    return { pr, action: 'kept', reason: 'manager.json が通常ファイルではありません' };
  }

  let bytes;
  try {
    bytes = readFileSync(artifactPath);
  } catch (e) {
    return { pr, action: 'kept', reason: `manager.json を読めません: ${e.message}` };
  }
  const marker = reviewResultMarker(pr, bytes);

  let posted;
  try {
    posted = findReviewResultPostedFn({ pr, repo, workspace, marker });
    if (!posted || typeof posted.posted !== 'boolean') {
      throw new Error('照合関数が posted の真偽値を返しませんでした');
    }
  } catch (e) {
    return { pr, action: 'kept', reason: `掲載を照合できません: ${e.message}` };
  }
  if (!posted.posted) {
    return { pr, action: 'kept', reason: '掲載の印が PR のレビューに見つかりません（未掲載、または印の無い旧形式）' };
  }

  try {
    rmSync(artifactPath);
  } catch (e) {
    return { pr, action: 'kept', reason: `削除に失敗しました: ${e.message}` };
  }
  return { pr, action: 'removed' };
}

/**
 * Issue ライフサイクル終了時の後始末（best-effort）。
 *
 * - assistant-watch/<issue>.json を削除（Issue #248 項目2）
 * - 対象PRの review-manager-<PR>.incomplete を削除（項目4・終端削除）
 * - 対象PRの records/pr/<PR>/review/manager.json を、PRへの掲載を確かめられたときだけ削除（ADR 0059）。
 *   確かめられない場合は残し、reviewArtifacts に理由を記録する
 * - executions.json の当該issueレコードを間引き（項目7）
 *
 * @param {string} workspace
 * @param {string|number} issue
 * @param {{repo?: string|null, findReviewPrsFn?: Function, findReviewResultPostedFn?: Function}} [opts]
 * @returns {{watchRemoved: boolean, incompleteRemoved: number[], executionsPruned: number, reviewArtifacts: {pr: number|string|null, action: 'removed'|'kept', reason?: string}[]}}
 */
function cleanupIssueArtifacts(workspace, issue, {
  repo = null,
  findReviewPrsFn = defaultFindReviewPrs,
  findReviewResultPostedFn = defaultFindReviewResultPosted,
} = {}) {
  const result = { watchRemoved: false, incompleteRemoved: [], executionsPruned: 0, reviewArtifacts: [] };

  // item2: assistant-watch/<issue>.json 削除。issue はファイル名に使うため正整数検証してから
  // パス構築する（path-confinement ルール）。
  if (/^[1-9]\d*$/.test(String(issue))) {
    const watchFile = recordPath(workspace, {
      ownerKind: 'issue', ownerId: issue, artifact: ARTIFACTS.ASSISTANT_WATCH,
    });
    try {
      if (existsSync(watchFile)) {
        rmSync(watchFile);
        result.watchRemoved = true;
      }
    } catch (e) {
      process.stderr.write(`finalize-issue: assistant-watch/${issue}.json の削除に失敗しました（続行します）: ${e.message}\n`);
    }
  }

  // item4: 対象PRの .incomplete 削除。reviewArtifactPath が PR の正整数検証 + workspace封じ込めを担う。
  let prs = [];
  let prDetectionFailed = false;
  try {
    prs = findReviewPrsFn(issue, repo, workspace) || [];
  } catch (e) {
    prDetectionFailed = true;
    process.stderr.write(`finalize-issue: 対象PRの検出に失敗しました（続行します）: ${e.message}\n`);
    result.reviewArtifacts.push({
      pr: null,
      action: 'kept',
      reason: `Issueに紐づくPRを特定できないため manager.json を確認できません: ${e.message}`,
    });
  }
  for (const pr of prs) {
    let sentinel;
    try {
      sentinel = reviewArtifactPath(workspace, pr, '.incomplete');
    } catch (e) {
      process.stderr.write(`finalize-issue: 不正なPR番号 ${JSON.stringify(pr)} はスキップします: ${e.message}\n`);
      continue;
    }
    try {
      if (existsSync(sentinel)) {
        rmSync(sentinel);
        result.incompleteRemoved.push(Number(pr));
      }
    } catch (e) {
      process.stderr.write(`finalize-issue: review-manager-${pr}.incomplete の削除に失敗しました（続行します）: ${e.message}\n`);
    }
  }

  // manager.json（レビュー結果）は、PRへの掲載を確かめられたときだけ破棄する（ADR 0059）。
  // 検出に失敗した場合は、対象PRが分からないため確かめられない（上で kept を記録済み）。
  if (!prDetectionFailed) {
    for (const pr of prs) {
      const outcome = cleanupReviewArtifact({ workspace, pr, repo, findReviewResultPostedFn });
      if (outcome.action !== 'none') result.reviewArtifacts.push(outcome);
    }
  }

  // item7: executions.json の当該issueレコード間引き（ファイル自体は残す）。
  try {
    result.executionsPruned = pruneExecutionsForIssue(workspace, issue);
  } catch (e) {
    process.stderr.write(`finalize-issue: executions.json の間引きに失敗しました（続行します）: ${e.message}\n`);
  }

  return result;
}

/**
 * Issue に紐づく全ワーカーの worktree 監視ペインを終了してからワーカーを削除し、Issue をクローズする。
 * あわせて、情報価値のない内部状態（assistant-watch/<issue>.json・対象PRの .incomplete・
 * executions.json の当該issueレコード）を後始末する（Issue #248 項目2/4/7）。
 * @param {{workspace: string, issue: string|number, repo?: string|null, decisionBody: string}} params
 * @param {{removeWorkerFn?: Function, closeIssueFn?: Function, closeStatusPaneFn?: Function, findReviewPrsFn?: Function}} [deps] テスト用に処理を注入する
 * @returns {{workers: {name: string, ok: boolean}[], removedCount: number, closed: boolean, statusPaneClosed: boolean, workerStatusPaneFailures: {name:string, reason:string}[], artifacts: object|null, decisionPosted: boolean, decisionAlreadyPosted: boolean, decisionUrl: string|null}}
 *   artifacts: cleanupIssueArtifacts() の結果（worker pane終了失敗時は後続cleanupを行わないため null）
 */
function finalizeIssue({ workspace, issue, repo = null, decisionBody }, deps = {}) {
  if (typeof decisionBody !== 'string' || decisionBody.trim() === '') {
    throw new Error('決定事項本文は空でない文字列が必要です');
  }
  const postDecisionFn = deps.postDecisionFn || ((body) => commentIssueBody({
    issue,
    body,
    repo,
    workspace,
  }));
  const findDecisionPostedFn = deps.findDecisionPostedFn || ((params) => defaultFindDecisionPosted(params, {
    readIssueCommentsFn: deps.readIssueCommentsFn,
    readIssueCommentsDeps: deps.readIssueCommentsDeps,
  }));
  let existingDecision;
  try {
    existingDecision = findDecisionPostedFn({ issue, repo, workspace, decisionBody });
    if (!existingDecision || typeof existingDecision.posted !== 'boolean') {
      throw new Error('照合関数がpostedの真偽値を返しませんでした');
    }
  } catch (error) {
    process.stderr.write(`finalize-issue: 既存の決定事項を照合できないため投稿と後始末を中止しました: ${error.message}\n`);
    return {
      workers: [], removedCount: 0, closed: false, statusPaneClosed: false,
      monitorTarget: null, workerStatusPaneFailures: [], artifacts: null,
      decisionPosted: false, decisionAlreadyPosted: false, decisionUrl: null,
    };
  }

  let decision;
  if (existingDecision.posted) {
    decision = { ok: true, alreadyPosted: true, url: existingDecision.url || null };
  } else {
    try {
      decision = postDecisionFn(decisionCommentBody(issue, decisionBody), issue, repo, workspace);
    } catch (error) {
      decision = { ok: false, stderr: error.message };
    }
  }
  if (!decision || !decision.ok) {
    const reason = String(decision && decision.stderr || 'unknown');
    process.stderr.write(`finalize-issue: 決定事項コメントを投稿できないため後始末を中止しました: ${reason}\n`);
    return {
      workers: [], removedCount: 0, closed: false, statusPaneClosed: false,
      monitorTarget: null, workerStatusPaneFailures: [], artifacts: null,
      decisionPosted: false, decisionAlreadyPosted: false, decisionUrl: null,
    };
  }

  const removeWorkerFn = deps.removeWorkerFn || defaultRemoveWorker;
  const closeIssueFn = deps.closeIssueFn || defaultCloseIssue;
  const closeStatusPaneFn = deps.closeStatusPaneFn || defaultCloseStatusPane;
  const clearTargetFn = deps.clearPrMonitorTargetFn || clearPrMonitorTarget;

  let monitorTarget;
  try {
    monitorTarget = {
      cleared: Boolean(clearTargetFn(workspace, { issue })),
    };
  } catch (error) {
    monitorTarget = { cleared: false, error: error.message };
    process.stderr.write(`finalize-issue: PR monitor target の終了に失敗しました（続行します）: ${error.message}\n`);
  }

  const names = collectWorkersForIssue(workspace, issue);
  const workers = [];
  const workerStatusPaneFailures = [];
  for (const name of names) {
    const workerWorkspace = path.resolve(workspace, '.gh-maestro', 'worktrees', name);
    let workerStatusPaneResult;
    try {
      workerStatusPaneResult = closeStatusPaneFn(workerWorkspace, issue);
    } catch (error) {
      workerStatusPaneResult = { ok: false, stderr: error.message };
    }
    if (!workerStatusPaneResult || !workerStatusPaneResult.ok) {
      const reason = String(workerStatusPaneResult && workerStatusPaneResult.stderr || 'unknown');
      workerStatusPaneFailures.push({ name, reason });
      process.stderr.write(
        `finalize-issue: ワーカー "${name}" の監視ペイン終了に失敗しました: `
        + `${reason}\n`,
      );
      workers.push({ name, ok: false });
      continue;
    }

    const result = removeWorkerFn(workspace, name);
    const ok = result && result.ok !== false;
    if (!ok) {
      process.stderr.write(`finalize-issue: ワーカー "${name}" の削除に失敗しました: ${result && result.stderr || 'unknown'}\n`);
    }
    workers.push({ name, ok });
  }

  if (workerStatusPaneFailures.length > 0) {
    // worktree 側 watch を閉じられないと remove-worker 後に再試行で見つけられない。
    // worker state と Issue を残し、監視 pane の終了を回復してから再実行できるようにする。
    return {
      workers,
      removedCount: workers.filter(w => w.ok).length,
      closed: false,
      statusPaneClosed: false,
      monitorTarget,
      workerStatusPaneFailures,
      artifacts: null,
      decisionPosted: true,
      decisionAlreadyPosted: decision.alreadyPosted === true,
      decisionUrl: decision.url || null,
    };
  }

  const close = closeIssueFn(issue, repo, workspace);
  if (!close.ok) {
    process.stderr.write(`finalize-issue: Issue #${issue} のクローズに失敗しました: ${close.stderr || 'unknown'}\n`);
  }

  let statusPaneResult;
  try {
    statusPaneResult = closeStatusPaneFn(workspace, issue);
  } catch (error) {
    statusPaneResult = { ok: false, stderr: error.message };
  }
  if (!statusPaneResult || !statusPaneResult.ok) {
    process.stderr.write(`finalize-issue: 監視ペインの終了に失敗しました: ${statusPaneResult && statusPaneResult.stderr || 'unknown'}\n`);
  }

  // 情報価値のない内部状態の後始末（best-effort）。テストでは findReviewPrsFn を注入し、
  // gh spawn が実環境で走らないようにする。
  const artifacts = cleanupIssueArtifacts(workspace, issue, {
    repo,
    findReviewPrsFn: deps.findReviewPrsFn || defaultFindReviewPrs,
    findReviewResultPostedFn: deps.findReviewResultPostedFn || defaultFindReviewResultPosted,
  });

  return {
    workers,
    removedCount: workers.filter(w => w.ok).length,
    closed: close.ok,
    statusPaneClosed: Boolean(statusPaneResult && statusPaneResult.ok),
    monitorTarget,
    workerStatusPaneFailures,
    artifacts,
    decisionPosted: true,
    decisionAlreadyPosted: decision.alreadyPosted === true,
    decisionUrl: decision.url || null,
  };
}

/**
 * manager.json の後始末結果を、stdout の機械可読な行に整形する。
 * @param {{pr: number|string|null, action: 'removed'|'kept', reason?: string}[]} reviewArtifacts
 * @returns {string[]}
 */
function formatReviewArtifactLines(reviewArtifacts) {
  return (reviewArtifacts || []).map((entry) => {
    const pr = entry.pr === null || entry.pr === undefined ? '?' : entry.pr;
    if (entry.action === 'removed') return `REVIEW_ARTIFACT_REMOVED:pr=${pr}`;
    const reason = String(entry.reason || 'unknown').replace(/\s+/g, ' ').trim();
    return `REVIEW_ARTIFACT_KEPT:pr=${pr} reason=${reason}`;
  });
}

module.exports = {
  collectWorkersForIssue,
  finalizeIssue,
  cleanupIssueArtifacts,
  formatReviewArtifactLines,
  defaultFindReviewResultPosted,
  defaultFindReviewPrs,
  bodyReferencesIssue,
  decisionCommentMarker,
  decisionCommentBody,
  defaultReadIssueComments,
  defaultFindDecisionPosted,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--issue': { required: true }, '--decision-file': { required: true }, '--repo': {}, '--workspace': {} },
      booleans: ['--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`finalize-issue: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }

  const issue = values['--issue'];
  const decisionFileArg = values['--decision-file'];
  const repo = values['--repo'] || null;
  const workspace = resolveWorkspace(values['--workspace']);

  if (!issue) {
    console.error('finalize-issue: --issue が必要です');
    console.error(USAGE);
    process.exit(1);
  }
  if (!/^[1-9][0-9]*$/.test(issue)) {
    console.error('finalize-issue: --issue は正の整数である必要があります');
    process.exit(1);
  }
  if (!workspace) {
    console.error('finalize-issue: ワークスペースを解決できません。--workspace を指定するか、GH_MAESTRO_WORKSPACE または .gh-maestro/ のあるディレクトリで実行してください');
    process.exit(1);
  }

  const decisionFile = path.resolve(toWinPath(decisionFileArg));
  let decisionBody;
  try {
    decisionBody = readFileSync(decisionFile, 'utf8');
  } catch (error) {
    console.error(`finalize-issue: 決定事項ファイルを読めません: ${decisionFile}: ${error.message}`);
    process.exit(1);
  }
  if (decisionBody.trim() === '') {
    console.error(`finalize-issue: 決定事項ファイルが空です: ${decisionFile}`);
    process.exit(1);
  }

  const result = finalizeIssue({ workspace, issue, repo, decisionBody });
  if (result.artifacts) {
    for (const line of formatReviewArtifactLines(result.artifacts.reviewArtifacts)) console.log(line);
  }
  console.log(`FINALIZED:${issue} removed=${result.removedCount}/${result.workers.length} closed=${result.closed}`);
  process.exit(result.closed ? 0 : 1);
}
