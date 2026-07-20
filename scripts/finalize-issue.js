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
const { readFileSync, existsSync } = require('fs');
const { spawnSync } = require('./child-process');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const USAGE = `finalize-issue.js — Issue をクローズし、そのIssueの全ワーカーを削除する

Usage: node finalize-issue.js --issue <N> [--repo <owner/repo>] [--workspace <path>]

Options:
  --issue <N>          クローズ対象の Issue 番号（正の整数）
  --repo <owner/repo>  対象リポジトリ（省略時は workspace の git remote から解決）
  --workspace <path>   ワークスペース（デフォルト CWD）

反省会が完了した後にだけ呼ぶこと。Issueに紐づく全ワーカーを remove-worker.js 経由で削除し、
そのあと Issue をクローズする。ワーカー削除は best-effort（一部失敗しても続行し、Issueは閉じる）。

Output (stdout):
  FINALIZED:<N> removed=<削除成功数>/<対象数> closed=<true|false>`;

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
    '--worker-name', workerName,
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

/**
 * Issue に紐づく全ワーカーを削除し、Issue をクローズする。
 * @param {{workspace: string, issue: string|number, repo?: string|null}} params
 * @param {{removeWorkerFn?: Function, closeIssueFn?: Function}} [deps] テスト用に spawn を注入する
 * @returns {{workers: {name: string, ok: boolean}[], removedCount: number, closed: boolean}}
 */
function finalizeIssue({ workspace, issue, repo = null }, deps = {}) {
  const removeWorkerFn = deps.removeWorkerFn || defaultRemoveWorker;
  const closeIssueFn = deps.closeIssueFn || defaultCloseIssue;

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

  return {
    workers,
    removedCount: workers.filter(w => w.ok).length,
    closed: close.ok,
  };
}

module.exports = { collectWorkersForIssue, finalizeIssue };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--issue', '--repo', '--workspace']);

  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }
  if (hasHelpFlag(rest)) {
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
  console.log(`FINALIZED:${issue} removed=${result.removedCount}/${result.workers.length} closed=${result.closed}`);
  process.exit(result.closed ? 0 : 1);
}
