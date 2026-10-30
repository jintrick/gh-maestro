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
const { readFileSync, existsSync, rmSync } = require('fs');
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

Output (stdout):
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

function defaultReadIssueComments({ issue, repo, workspace }, deps = {}) {
  const resolveRepoFn = deps.resolveRepoFn || resolveRepo;
  const resolvedRepo = resolveRepoFn({ repo, workspace }, deps.repoDeps || {});
  if (!resolvedRepo || !resolvedRepo.ok || !resolvedRepo.repo) {
    throw new Error(`Issueコメントの照合に使うリポジトリを解決できません: ${resolvedRepo && resolvedRepo.error || 'unknown'}`);
  }

  const spawnFn = deps.spawnSyncFn || spawnSync;
  const authOutput = runGhApiRead(spawnFn, ['api', 'user', '--jq', '.login'], workspace, 'GitHub認証ユーザーの取得に失敗しました');
  const authLines = authOutput.trim().split(/\r?\n/);
  const authenticatedLogin = authLines.length === 1 ? authLines[0] : '';
  if (!isGitHubLogin(authenticatedLogin)) {
    throw new Error('GitHub認証ユーザーを取得できないため、決定事項の投稿を安全に照合できません');
  }

  const endpoint = `repos/${resolvedRepo.repo}/issues/${issue}/comments`;
  const commentOutput = runGhApiRead(
    spawnFn,
    ['api', '--paginate', endpoint, '--jq', '.[] | {login: .user.login, body: .body} | @json | @base64'],
    workspace,
    'Issueコメントの照合に失敗しました',
  );
  const lines = commentOutput.split(/\r?\n/).filter((line) => line.trim() !== '');
  const comments = lines.map((line, index) => {
    let encoded = line;
    try {
      const parsedLine = JSON.parse(line);
      if (typeof parsedLine === 'string') encoded = parsedLine;
    } catch { /* gh --jq may emit a scalar either raw or JSON-quoted */ }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error(`Issueコメントの照合結果 ${index + 1} 件目が不正なBase64です`);
    }
    let comment;
    try {
      comment = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch (error) {
      throw new Error(`Issueコメントの照合結果 ${index + 1} 件目をJSONとして読めません: ${error.message}`);
    }
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)
      || !isGitHubLogin(comment.login) || typeof comment.body !== 'string') {
      throw new Error(`Issueコメントの照合結果 ${index + 1} 件目から投稿者または本文を取得できません`);
    }
    return { login: comment.login, body: comment.body };
  });

  return { authenticatedLogin, comments };
}

function defaultFindDecisionPosted({ issue, repo, workspace, decisionBody }, deps = {}) {
  const readCommentsFn = deps.readIssueCommentsFn || defaultReadIssueComments;
  const result = readCommentsFn({ issue, repo, workspace }, deps.readIssueCommentsDeps || {});
  if (!result || !isGitHubLogin(result.authenticatedLogin) || !Array.isArray(result.comments)) {
    throw new Error('GitHub認証ユーザーまたはIssueコメントの照合結果を取得できません');
  }
  if (result.comments.some((comment) => !comment || typeof comment !== 'object'
    || !isGitHubLogin(comment.login) || typeof comment.body !== 'string')) {
    throw new Error('Issueコメントの投稿者または本文を取得できないため、決定事項を安全に照合できません');
  }

  const expectedBody = decisionCommentBody(issue, decisionBody);
  const authenticatedLogin = result.authenticatedLogin.toLowerCase();
  return {
    posted: result.comments.some((comment) => (
      comment.login.toLowerCase() === authenticatedLogin && comment.body === expectedBody
    )),
  };
}

// 既定の対象PR発見処理: Issueに紐づくPR番号を列挙する（poll-pr.js / assistant-watch.js と同一の2段構え）。
// 1. head:issue-<N>（worktreeブランチ命名規約による厳密一致。worker-entry.js参照）
// 2. フォールバック: bodyが "#<N>" を参照するもの（#<N> の直後に数字が続かない単語境界で厳密一致。
//    bodyReferencesIssue 参照。GitHub全文検索のあいまい一致は使わない——生の数字だけで検索すると
//    無関係PRの本文中のバージョン番号等に誤マッチしうる）
// --state all でクローズ済みPRも含めて発見する（.incomplete 後始末はクローズ後でも行いたい）。
// gh が失敗したら空配列を返す（best-effort。削除漏れは許容し、後続のクローズを阻害しない）。
function defaultFindReviewPrs(issue, repo, workspace) {
  const prArgs = ['pr', 'list', '--search', `head:issue-${issue}`, '--state', 'all', '--json', 'number'];
  if (repo) prArgs.unshift('--repo', repo);
  const headResult = spawnSync('gh', prArgs, { cwd: workspace, encoding: 'utf8' });
  if (headResult.status === 0) {
    try {
      const found = JSON.parse(headResult.stdout || '[]');
      if (Array.isArray(found) && found.length > 0) {
        return found.map((p) => p.number).filter((n) => n != null);
      }
    } catch { /* フォールバックへ */ }
  }

  const bodyArgs = ['pr', 'list', '--state', 'all', '--json', 'number,body'];
  if (repo) bodyArgs.unshift('--repo', repo);
  const bodyResult = spawnSync('gh', bodyArgs, { cwd: workspace, encoding: 'utf8' });
  if (bodyResult.status !== 0) return [];
  try {
    const all = JSON.parse(bodyResult.stdout || '[]');
    if (!Array.isArray(all)) return [];
    return all
      .filter((p) => bodyReferencesIssue(p.body, issue))
      .map((p) => p.number)
      .filter((n) => n != null);
  } catch {
    return [];
  }
}

/**
 * Issue ライフサイクル終了時の、情報価値のない内部状態の後始末（best-effort）。
 * 価値ある記録（records/pr/<PR>/review/manager.json 等）は対象にしない（受理基準c）。
 *
 * - assistant-watch/<issue>.json を削除（Issue #248 項目2）
 * - 対象PRの review-manager-<PR>.incomplete を削除（項目4・終端削除）
 * - executions.json の当該issueレコードを間引き（項目7）
 *
 * @param {string} workspace
 * @param {string|number} issue
 * @param {{repo?: string|null, findReviewPrsFn?: Function}} [opts]
 * @returns {{watchRemoved: boolean, incompleteRemoved: number[], executionsPruned: number}}
 */
function cleanupIssueArtifacts(workspace, issue, { repo = null, findReviewPrsFn = defaultFindReviewPrs } = {}) {
  const result = { watchRemoved: false, incompleteRemoved: [], executionsPruned: 0 };

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
  try {
    prs = findReviewPrsFn(issue, repo, workspace) || [];
  } catch (e) {
    process.stderr.write(`finalize-issue: 対象PRの検出に失敗しました（続行します）: ${e.message}\n`);
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

module.exports = {
  collectWorkersForIssue,
  finalizeIssue,
  cleanupIssueArtifacts,
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
  console.log(`FINALIZED:${issue} removed=${result.removedCount}/${result.workers.length} closed=${result.closed}`);
  process.exit(result.closed ? 0 : 1);
}
