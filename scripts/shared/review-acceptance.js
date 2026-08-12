'use strict';

const { spawnSync } = require('../child-process');

const ISSUE_BRANCH_RE = /^issue-([1-9][0-9]*)-/;

/**
 * Extract the issue number from the convention used by worker branches.
 * @param {string} branchName
 * @returns {string|null}
 */
function extractIssueNumber(branchName) {
  const match = typeof branchName === 'string' ? branchName.match(ISSUE_BRANCH_RE) : null;
  return match ? match[1] : null;
}

function runGh(args) {
  return spawnSync('gh', args, { encoding: 'utf8', timeout: 30000 });
}

/**
 * Fetch the acceptance criteria once for a review run.
 * A missing branch convention or any GitHub lookup failure deliberately falls
 * back to null so review remains compatible with older/non-standard branches.
 * @param {{pr: string|number, repo: string, runGh?: Function}} params
 * @returns {string|null}
 */
function fetchAcceptanceCriteria({ pr, repo, runGh: gh = runGh }) {
  try {
    const branch = gh([
      'pr', 'view', String(pr), '--repo', repo,
      '--json', 'headRefName', '--jq', '.headRefName',
    ]);
    if (!branch || branch.status !== 0) return null;

    const issue = extractIssueNumber(String(branch.stdout || '').trim());
    if (!issue) return null;

    const body = gh([
      'issue', 'view', issue, '--repo', repo,
      '--json', 'body', '--jq', '.body',
    ]);
    if (!body || body.status !== 0 || typeof body.stdout !== 'string') return null;
    return body.stdout;
  } catch {
    return null;
  }
}

module.exports = { extractIssueNumber, fetchAcceptanceCriteria };
