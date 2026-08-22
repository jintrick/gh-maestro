'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkClosedPr } = require('../scripts/shared/closed-pr-guard');

function result(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' };
}

test('checkClosedPr: CLOSEDをクローズ済みPRとして返す', () => {
  const checked = checkClosedPr({ repo: 'o/r', branch: 'issue-1-coder-fix', listFn: () => result([{ number: 42, state: 'CLOSED' }]) });
  assert.deepEqual(checked, { blocked: true, number: 42 });
});

test('checkClosedPr: OPEN・MERGED・PRなしは許可する', () => {
  for (const prs of [[{ number: 1, state: 'OPEN' }], [{ number: 2, state: 'MERGED' }], []]) {
    const checked = checkClosedPr({ repo: 'o/r', branch: 'issue-1-coder-fix', listFn: () => result(prs) });
    assert.deepEqual(checked, { blocked: false });
  }
});

test('checkClosedPr: 照会失敗は安全側に倒して停止する', () => {
  const checked = checkClosedPr({
    repo: 'o/r', branch: 'issue-1-coder-fix',
    listFn: () => ({ status: 1, stderr: 'network unavailable' }),
  });
  assert.equal(checked.blocked, true);
  assert.match(checked.reason, /network unavailable/);
});

test('checkClosedPr: 不正な応答は安全側に倒して停止する', () => {
  const checked = checkClosedPr({
    repo: 'o/r', branch: 'issue-1-coder-fix',
    listFn: () => ({ status: 0, stdout: '{broken' }),
  });
  assert.equal(checked.blocked, true);
  assert.match(checked.reason, /解釈できません/);
});
