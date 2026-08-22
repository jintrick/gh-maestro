'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ghPr = require('../scripts/shared/gh-pr');
const { listPrsByBranch, parsePrListResponse } = ghPr;

describe('gh-pr: listPrsByBranch', () => {
  afterEach(() => {
    ghPr._resetSpawnSync();
    ghPr._resetListPrsByBranch();
  });

  test('既定オプションで正しく gh pr list の引数が組み立てられる', () => {
    let capturedCmd, capturedArgs, capturedOpts;
    ghPr._setSpawnSync((cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return { status: 0, stdout: '[]', stderr: '' };
    });

    const res = listPrsByBranch('owner/repo', 'issue-1-fix');
    assert.equal(res.status, 0);
    assert.equal(capturedCmd, 'gh');
    assert.deepEqual(capturedArgs, [
      'pr', 'list',
      '--repo', 'owner/repo',
      '--head', 'issue-1-fix',
      '--state', 'open',
      '--json', ghPr.DEFAULT_JSON_FIELDS,
    ]);
    assert.equal(capturedOpts.encoding, 'utf8');
    assert.equal(capturedOpts.timeout, 30000);
  });

  test('カスタムオプション（state, json, limit, cwd, timeout）が反映される', () => {
    let capturedArgs, capturedOpts;
    ghPr._setSpawnSync((cmd, args, opts) => {
      capturedArgs = args;
      capturedOpts = opts;
      return { status: 0, stdout: '[]', stderr: '' };
    });

    listPrsByBranch('owner/repo', 'issue-1-fix', {
      state: 'all',
      json: ['number', 'state'],
      limit: 5,
      cwd: '/custom/cwd',
      timeout: 10000,
    });

    assert.deepEqual(capturedArgs, [
      'pr', 'list',
      '--repo', 'owner/repo',
      '--head', 'issue-1-fix',
      '--state', 'all',
      '--json', 'number,state',
      '--limit', '5',
    ]);
    assert.equal(capturedOpts.cwd, '/custom/cwd');
    assert.equal(capturedOpts.timeout, 10000);
  });

  test('必須引数欠落時に throw する（拒否・失敗側）', () => {
    assert.throws(() => listPrsByBranch('', 'issue-1'), /有効な repo が必要です/);
    assert.throws(() => listPrsByBranch(null, 'issue-1'), /有効な repo が必要です/);
    assert.throws(() => listPrsByBranch('owner/repo', ''), /有効な branch が必要です/);
    assert.throws(() => listPrsByBranch('owner/repo', null), /有効な branch が必要です/);
  });

  test('_setListPrsByBranch によるモック差し替えとリセット', () => {
    ghPr._setListPrsByBranch(() => ({ status: 0, stdout: 'mocked', stderr: '' }));
    assert.equal(listPrsByBranch('o/r', 'b').stdout, 'mocked');

    ghPr._resetListPrsByBranch();
    ghPr._setSpawnSync(() => ({ status: 0, stdout: 'via-spawn', stderr: '' }));
    assert.equal(listPrsByBranch('o/r', 'b').stdout, 'via-spawn');
  });
});

describe('gh-pr: parsePrListResponse', () => {
  test('正常な JSON 配列をパースする', () => {
    const json = JSON.stringify([{ number: 1, title: 'PR 1' }, { number: 2, title: 'PR 2' }]);
    const parsed = parsePrListResponse(json);
    assert.deepEqual(parsed, [{ number: 1, title: 'PR 1' }, { number: 2, title: 'PR 2' }]);
  });

  test('空文字は空配列を返す', () => {
    assert.deepEqual(parsePrListResponse(''), []);
    assert.deepEqual(parsePrListResponse(null), []);
  });

  test('不正な JSON は null を返す（拒否・失敗側）', () => {
    assert.equal(parsePrListResponse('{invalid json'), null);
  });

  test('配列以外の JSON は null を返す（拒否・失敗側）', () => {
    assert.equal(parsePrListResponse('{"number": 1}'), null);
    assert.equal(parsePrListResponse('"string"'), null);
    assert.equal(parsePrListResponse('123'), null);
  });
});
