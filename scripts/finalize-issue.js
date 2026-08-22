#!/usr/bin/env node
'use strict';
// finalize-issue.js
// 反省会が完了した後に呼ぶ、決定的な最終後始末。
//   1. 指定 Issue に紐づく全ワーカーを remove-worker.js 経由で削除する（取りこぼし防止）
//   2. Issue をクローズする
// 判断（反省会・コーダー意見聴取・ルール提案・承認反映）は orchestrator 側の責務であり、
// このスクリプトは機械的な後始末だけを担う。反省会が済む前に呼んではならない。
//
// Usage:
//   node finalize-issue.js --issue <N> [--repo <owner/repo>] [--workspace <path>]

const path = require('path');
const { readFileSync, existsSync, rmSync } = require('fs');
const { spawnSync } = require('./shared/child-process');
const { parseFlags } = require('./shared/workspace');
const { getAssistant, removeAssistant } = require('./shared/assistants-registry');
const { reviewArtifactPath } = require('./shared/review-manager-paths');
const { ARTIFACTS, recordPath } = require('./shared/record-paths');
const { pruneExecutionsForIssue } = require('./shared/execution-registry');

const USAGE = `finalize-issue.js — Issue をクローズし、そのIssueの全ワーカーを削除する

Usage: node finalize-issue.js --issue <N> [--repo <owner/repo>] [--workspace <path>]

Options:
  --issue <N>          クローズ対象の Issue 番号（正の整数）
  --repo <owner/repo>  対象リポジトリ（省略時は workspace の git remote から解決）
  --workspace <path>   ワークスペース（デフォルト CWD）

反省会が完了した後にだけ呼ぶこと。Issueに紐づく全ワーカーを remove-worker.js 経由で削除し、
そのあと Issue をクローズする。ワーカー削除は best-effort（一部失敗しても続行し、Issueは閉じる）。

このIssueに紐づく対話型ワーカー「assistant」（.gh-maestro/assistants.json に登録。
workers.json とは別管理）が存在すれば、あわせて強制終了（kill-pane）する。assistantが
存在しなくてもエラー扱いにしない。

さらに、ライフサイクル終了後の情報価値のない内部状態を後始末する（Issue #248・すべて best-effort）:
- .gh-maestro/assistant-watch/<N>.json を削除
- このIssueに紐づくPRの .gh-maestro/review-manager-<PR>.incomplete を削除
  （PR発見は gh pr list --search head:issue-<N> --state all → 本文 "#<N>" フォールバック）
- .gh-maestro/executions.json の当該Issueレコードを間引き（ファイル自体は残す）

Output (stdout):
  FINALIZED:<N> removed=<削除成功数>/<対象数> closed=<true|false> assistant=<ok|skipped|failed>`;

/**
 * workers.json から、指定 Issue に紐づくワーカー名を列挙する（orchestrator 自身は除く）。
 * @param {string} workspace
 * @param {string|number} issue
 * @returns {string[]}
 */
function collectWorkersForIssue(workspace, issue) {
  const workersJson = path.join(workspace, '.gh-maestro', 'workers.json');
  if (!existsSync(workersJson)) return [];
  let workers;
  try {
    workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  } catch {
    return [];
  }
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) return [];
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

// 既定のassistant終了処理: assistants.json からpane-idを引いてkill-paneし、エントリを除く。
// workers.json には一切触れない（assistantは元々そこに登録されていない）。
function defaultKillAssistant(workspace, issue) {
  const entry = getAssistant(workspace, issue);
  if (!entry || !entry.paneId) return { ok: true, skipped: true };
  const r = spawnSync('wezterm', ['cli', '--no-auto-start', 'kill-pane', '--pane-id', entry.paneId], { encoding: 'utf8' });
  removeAssistant(workspace, issue);
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
  const ghDir = path.join(workspace, '.gh-maestro');
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

  // item4: 対象PRの .incomplete 削除。reviewArtifactPath が PR の正整数検証 + ghDir封じ込めを担う。
  let prs = [];
  try {
    prs = findReviewPrsFn(issue, repo, workspace) || [];
  } catch (e) {
    process.stderr.write(`finalize-issue: 対象PRの検出に失敗しました（続行します）: ${e.message}\n`);
  }
  for (const pr of prs) {
    let sentinel;
    try {
      sentinel = reviewArtifactPath(ghDir, pr, '.incomplete');
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
 * Issue に紐づく全ワーカーを削除し、Issue をクローズし、対話型ワーカー「assistant」を終了する。
 * あわせて、情報価値のない内部状態（assistant-watch/<issue>.json・対象PRの .incomplete・
 * executions.json の当該issueレコード）を後始末する（Issue #248 項目2/4/7）。
 * @param {{workspace: string, issue: string|number, repo?: string|null}} params
 * @param {{removeWorkerFn?: Function, closeIssueFn?: Function, killAssistantFn?: Function, findReviewPrsFn?: Function}} [deps] テスト用に spawn を注入する
 * @returns {{workers: {name: string, ok: boolean}[], removedCount: number, closed: boolean, assistantKilled: boolean|null, artifacts: object}}
 *   assistantKilled: true=正常終了, false=終了処理に失敗, null=対象となるassistantが無かった（skipped）
 *   artifacts: cleanupIssueArtifacts() の結果（watchRemoved / incompleteRemoved / executionsPruned）
 */
function finalizeIssue({ workspace, issue, repo = null }, deps = {}) {
  const removeWorkerFn = deps.removeWorkerFn || defaultRemoveWorker;
  const closeIssueFn = deps.closeIssueFn || defaultCloseIssue;
  const killAssistantFn = deps.killAssistantFn || defaultKillAssistant;

  const names = collectWorkersForIssue(workspace, issue);
  const workers = [];
  for (const name of names) {
    const result = removeWorkerFn(workspace, name);
    const ok = result && result.ok !== false;
    if (!ok) {
      process.stderr.write(`finalize-issue: ワーカー "${name}" の削除に失敗しました: ${result && result.stderr || 'unknown'}\n`);
    }
    workers.push({ name, ok });
  }

  const close = closeIssueFn(issue, repo, workspace);
  if (!close.ok) {
    process.stderr.write(`finalize-issue: Issue #${issue} のクローズに失敗しました: ${close.stderr || 'unknown'}\n`);
  }

  const assistantResult = killAssistantFn(workspace, issue);
  if (!assistantResult.ok) {
    process.stderr.write(`finalize-issue: assistantペインの終了に失敗しました: ${assistantResult.stderr || 'unknown'}\n`);
  }
  const assistantKilled = assistantResult.skipped ? null : assistantResult.ok;

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
    assistantKilled,
    artifacts,
  };
}

module.exports = { collectWorkersForIssue, finalizeIssue, cleanupIssueArtifacts, bodyReferencesIssue };

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--issue': {}, '--repo': {}, '--workspace': {} },
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
  const repo = values['--repo'] || null;
  const workspace = values['--workspace'] || process.cwd();

  if (!issue) {
    console.error('finalize-issue: --issue が必要です');
    console.error(USAGE);
    process.exit(1);
  }
  if (!/^[1-9][0-9]*$/.test(issue)) {
    console.error('finalize-issue: --issue は正の整数である必要があります');
    process.exit(1);
  }

  const result = finalizeIssue({ workspace, issue, repo });
  const assistantLabel = result.assistantKilled === null ? 'skipped' : (result.assistantKilled ? 'ok' : 'failed');
  console.log(`FINALIZED:${issue} removed=${result.removedCount}/${result.workers.length} closed=${result.closed} assistant=${assistantLabel}`);
  process.exit(result.closed ? 0 : 1);
}
