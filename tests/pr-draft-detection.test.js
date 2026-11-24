'use strict';

// poll-pr の PR 検出は下書き（isDraft）を除外する（Issue #671）。申告表を載せるPRは下書きで作られ、
// 申告表投稿後に公開されるため、下書きを検出すると申告表の無いHEADでレビューが始まる。
// gh 呼び出しは注入し、データ（下書きと公開済みが混ざった一覧）から実際に選ばれる PR 番号を検証する。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findReviewablePr } = require('../scripts/poll-pr');

/**
 * gh pr list の呼び出しを、与えたデータで応答するスタブ。
 * head 検索（--search）と、全件（検索なし）で別々の一覧を返す。
 */
function ghListStub({ byHead = [], all = [] } = {}) {
  const calls = [];
  const spawnSyncFn = (cmd, args) => {
    calls.push({ cmd, args });
    const isHeadSearch = args.includes('--search');
    return { status: 0, stdout: JSON.stringify(isHeadSearch ? byHead : all) };
  };
  return { spawnSyncFn, calls };
}

const DRAFT_WITH_BODY = { number: 5, isDraft: true, body: '関連Issue: #671' };
const PUBLIC_WITH_BODY = { number: 6, isDraft: false, body: '関連Issue: #671' };

test('gh の一覧取得が失敗したら検出しない（空文字列。例外にしない）', () => {
  const spawnSyncFn = () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.equal(findReviewablePr({ repo: 'o/r', issue: 671 }, spawnSyncFn), '');
});

