'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractIssueNumber,
  fetchAcceptanceCriteria,
} = require('../scripts/shared/review-acceptance');

test('extractIssueNumber: worker branch conventionからIssue番号を抽出する', () => {
  assert.equal(extractIssueNumber('issue-260-senior-coder-review-acceptance-criteria'), '260');
  assert.equal(extractIssueNumber('issue-7-coder-fix'), '7');
  assert.equal(extractIssueNumber('feature/issue-260-fix'), null);
  assert.equal(extractIssueNumber('issue-0-coder-fix'), null);
  assert.equal(extractIssueNumber(''), null);
});

test('fetchAcceptanceCriteria: PR headからIssueを特定し、本文を一度取得する', () => {
  const calls = [];
  const body = '## 受け入れ条件\n\n- 成功すること';
  const result = fetchAcceptanceCriteria({
    pr: 42,
    repo: 'owner/repo',
    runGh: (args) => {
      calls.push(args);
      if (args[0] === 'pr') return { status: 0, stdout: 'issue-260-senior-coder-fix\n' };
      return { status: 0, stdout: body };
    },
  });

  assert.equal(result, body);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 5), ['issue', 'view', '260', '--repo', 'owner/repo']);
});

test('fetchAcceptanceCriteria: 特定または取得に失敗した場合はnullへフォールバックする', () => {
  let issueCallCount = 0;
  assert.equal(fetchAcceptanceCriteria({
    pr: 1, repo: 'o/r', runGh: () => ({ status: 0, stdout: 'feature/no-issue\n' }),
  }), null);
  assert.equal(fetchAcceptanceCriteria({
    pr: 1,
    repo: 'o/r',
    runGh: (args) => {
      if (args[0] === 'pr') return { status: 0, stdout: 'issue-12-coder-fix\n' };
      issueCallCount++;
      return { status: 1, stdout: '', stderr: 'not found' };
    },
  }), null);
  assert.equal(issueCallCount, 1);
});
