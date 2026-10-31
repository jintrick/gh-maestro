'use strict';

// poll-pr の PR 検出は下書き（isDraft）を除外する（Issue #671 PR#672 3回目指摘1）。
// 申告表を載せるPRは下書きで作られ、申告表投稿後に公開されるため、下書きを検出すると
// 申告表の無いHEADでレビューが始まる。gh 呼び出しは注入し、実プロセスを起動しない。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findReviewablePr } = require('../scripts/poll-pr');

/** gh pr list の -q 出力を、クエリに応じて返すスタブ。 */
function ghStub({ branchOut = '', bodyOut = '' } = {}) {
  const calls = [];
  const spawnSyncFn = (cmd, args) => {
    calls.push({ cmd, args });
    const query = args[args.length - 1];
    const out = query.includes('contains(') ? bodyOut : branchOut;
    return { status: 0, stdout: out };
  };
  return { spawnSyncFn, calls };
}

test('findReviewablePr: 下書きのPRは検出せず、空文字列を返す', () => {
  const { spawnSyncFn, calls } = ghStub({ branchOut: '', bodyOut: '' });
  assert.equal(findReviewablePr({ repo: 'o/r', issue: 671 }, spawnSyncFn), '');
  assert.equal(calls.length, 2, '枝名検索と本文検索の両方を行う');
  for (const call of calls) {
    assert.ok(call.args.includes('number,isDraft') || call.args.includes('number,body,isDraft'), 'isDraft を取得する');
    assert.match(call.args[call.args.length - 1], /isDraft \| not/, '下書きを除外する条件を含む');
  }
});

test('findReviewablePr: 公開済みのPR番号を返す（枝名検索を優先）', () => {
  const { spawnSyncFn } = ghStub({ branchOut: '12\n', bodyOut: '34\n' });
  assert.equal(findReviewablePr({ repo: 'o/r', issue: 671 }, spawnSyncFn), '12');
});

test('findReviewablePr: 枝名検索で見つからなければ本文の関連Issue番号で検索する', () => {
  const { spawnSyncFn } = ghStub({ branchOut: '', bodyOut: '34\n' });
  assert.equal(findReviewablePr({ repo: 'o/r', issue: 671 }, spawnSyncFn), '34');
});
