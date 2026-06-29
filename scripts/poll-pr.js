#!/usr/bin/env node
// Usage: node poll-pr.js <ISSUE> [INTERVAL_SECONDS]
// Polls until a PR for the given issue is found, then launches the reviewer and prints:
//   PR_DETECTED:<number>
//   REVIEW_STARTED:<number> | REVIEW_ALREADY_RUNNING:<number>
'use strict';

const { spawnSync } = require('child_process');
const { startReview } = require('./start-review');

const USAGE = `poll-pr.js — Issue に対応する PR を検出し、検出時にレビュアーを起動する

Usage: node poll-pr.js <ISSUE> [INTERVAL_SECONDS]

Arguments:
  <ISSUE>             対象の Issue 番号
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Output (stdout):
  PR_DETECTED:<PR>             PR を検出した
  REVIEW_STARTED:<PR>          レビュアーを起動した
  REVIEW_ALREADY_RUNNING:<PR>  レビュアーは既に稼働中

PR が見つかるまでブロックし、見つけたらレビュアー(start-review.js)を起動して終了する。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const [issue, intervalArg] = argv;
const interval = parseInt(intervalArg || '30') * 1000;

if (!issue) {
  console.error(USAGE);
  process.exit(1);
}

const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  { encoding: 'utf8' }).stdout.trim();

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
    const pr = findPR();
    if (pr) {
      const workspace = process.cwd();
      // PR 検出のついでにレビュアーを起動するが、その起動結果も併せて報告する。
      // これにより orchestrator は「レビュアーが起動済みである」ことを把握できる。
      const reviewStatus = startReview(pr, repo, workspace);
      process.stdout.write(`PR_DETECTED:${pr}\n`);
      process.stdout.write(`${reviewStatus}:${pr}\n`);
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, interval));
  }
})();
