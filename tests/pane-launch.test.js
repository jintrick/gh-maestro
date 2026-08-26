'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const paneLaunch = require('../scripts/shared/pane-launch');
const { launchAgentInWindow } = paneLaunch;

// このモジュールに残るのは assistant（対話型ワーカー）専用の起動経路だけ。
// orchestrator管理下のワーカーの起動は shared/headless-launch.js へ移行した（Issue #151）。
beforeEach(() => {
  paneLaunch._setWeztermSpawnWindow(() => ({ status: 0, stdout: '42', stderr: '' }));
});

test('launchAgentInWindow: spawn成功でpaneIdを返す', () => {
  const result = launchAgentInWindow({
    argv: ['agy', '--prompt-interactive', 'hello'],
    cwd: '/tmp/ws',
  });
  assert.equal(result.paneId, '42');
});

test('launchAgentInWindow: --new-window --cwd を伴う spawn 引数を組み立てる（splitFromPaneId等は不要）', () => {
  let capturedArgs = null;
  paneLaunch._setWeztermSpawnWindow((args) => {
    capturedArgs = args;
    return { status: 0, stdout: '99', stderr: '' };
  });

  launchAgentInWindow({ argv: ['agy', '--prompt-interactive', 'hi'], cwd: '/tmp/ws-2' });

  assert.ok(capturedArgs.includes('spawn'));
  assert.ok(capturedArgs.includes('--new-window'));
  assert.ok(capturedArgs.includes('--cwd'));
  assert.ok(capturedArgs.includes('/tmp/ws-2'));
});

test('launchAgentInWindow: spawn失敗でthrow', () => {
  paneLaunch._setWeztermSpawnWindow(() => ({ status: 1, stdout: '', stderr: 'nope' }));

  assert.throws(
    () => launchAgentInWindow({ argv: ['agy'], cwd: '/tmp/ws' }),
    /WezTermウィンドウの起動に失敗しました: nope/
  );
});

test('launchAgentInWindow: pane-idが空ならthrow', () => {
  paneLaunch._setWeztermSpawnWindow(() => ({ status: 0, stdout: '', stderr: '' }));

  assert.throws(
    () => launchAgentInWindow({ argv: ['agy'], cwd: '/tmp/ws' }),
    /pane-id を取得できませんでした/
  );
});

test('launchInSplitPane: split-pane成功でpaneIdを返す（既定: bottom 15%）', () => {
  let capturedArgs = null;
  paneLaunch._setWeztermSplitPane((args) => {
    capturedArgs = args;
    return { status: 0, stdout: '55', stderr: '' };
  });

  const result = paneLaunch.launchInSplitPane({
    argv: ['node', 'worker-status.js', 'watch'],
    cwd: '/tmp/ws',
  });

  assert.equal(result.paneId, '55');
  assert.ok(capturedArgs.includes('split-pane'));
  assert.ok(capturedArgs.includes('--bottom'));
  assert.ok(capturedArgs.includes('--percent'));
  assert.ok(capturedArgs.includes('15'));
  assert.ok(capturedArgs.includes('--cwd'));
  assert.ok(capturedArgs.includes('/tmp/ws'));
});

test('launchInSplitPane: direction と percent をカスタマイズできる', () => {
  let capturedArgs = null;
  paneLaunch._setWeztermSplitPane((args) => {
    capturedArgs = args;
    return { status: 0, stdout: '56', stderr: '' };
  });

  paneLaunch.launchInSplitPane({
    argv: ['node', 'worker-status.js', 'watch'],
    cwd: '/tmp/ws',
    direction: 'right',
    percent: 25,
  });

  assert.ok(capturedArgs.includes('--right'));
  assert.ok(capturedArgs.includes('25'));
});

test('launchInSplitPane: split-pane失敗でthrow', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 1, stdout: '', stderr: 'split failed' }));

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws' }),
    /WezTermペインの分割起動に失敗しました: split failed/
  );
});

test('launchInSplitPane: pane-idが空ならthrow', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 0, stdout: '', stderr: '' }));

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws' }),
    /pane-id を取得できませんでした/
  );
});

test('getAlivePaneIds: listのJSON出力からSet<string>を構築する', () => {
  paneLaunch._setWeztermListPanes(() => ({
    status: 0,
    stdout: JSON.stringify([{ pane_id: 1 }, { pane_id: '42' }, { pane_id: 99 }]),
    stderr: '',
  }));

  const result = paneLaunch.getAlivePaneIds();
  assert.equal(result.size, 3);
  assert.ok(result.has('1'));
  assert.ok(result.has('42'));
  assert.ok(result.has('99'));
  assert.ok(!result.has('100'));
});

test('getAlivePaneIds: status!=0 の場合はwarnを呼び null を返す（0件生存と区別）', () => {
  let warned = null;
  paneLaunch._setWeztermListPanes(() => ({ status: 1, stdout: '', stderr: 'wezterm not running' }));

  const result = paneLaunch.getAlivePaneIds((msg) => { warned = msg; });
  assert.equal(result, null);
  assert.match(warned, /wezterm cli list 失敗: wezterm not running/);
});

test('getAlivePaneIds: JSONパース失敗時はwarnを呼び null を返す', () => {
  let warned = null;
  paneLaunch._setWeztermListPanes(() => ({ status: 0, stdout: 'not json', stderr: '' }));

  const result = paneLaunch.getAlivePaneIds((msg) => { warned = msg; });
  assert.equal(result, null);
  assert.match(warned, /wezterm cli list の出力パース失敗/);
});

test('isPaneAlive: paneIdの生存を正しく判定する', () => {
  paneLaunch._setWeztermListPanes(() => ({
    status: 0,
    stdout: JSON.stringify([{ pane_id: 10 }]),
    stderr: '',
  }));

  assert.equal(paneLaunch.isPaneAlive('10'), true);
  assert.equal(paneLaunch.isPaneAlive(10), true);
  assert.equal(paneLaunch.isPaneAlive('999'), false);
  assert.equal(paneLaunch.isPaneAlive(''), false);
  assert.equal(paneLaunch.isPaneAlive(null), false);
  assert.equal(paneLaunch.isPaneAlive(undefined), false);

  // 一覧取得失敗時は false
  paneLaunch._setWeztermListPanes(() => ({ status: 1, stdout: '', stderr: 'error' }));
  assert.equal(paneLaunch.isPaneAlive('10'), false);
});

test('killPane: paneIdを指定して正常にkillできる', () => {
  let capturedArgs = null;
  paneLaunch._setWeztermKillPane((args) => {
    capturedArgs = args;
    return { status: 0, stdout: '', stderr: '' };
  });

  const result = paneLaunch.killPane('42');
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.deepEqual(capturedArgs, ['cli', '--no-auto-start', 'kill-pane', '--pane-id', '42']);
});

test('killPane: 空のpaneIdはエラー結果を返す', () => {
  const result = paneLaunch.killPane('');
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /paneId is required/);
});

test('killPane: kill失敗時はステータスとstderrを返す', () => {
  paneLaunch._setWeztermKillPane(() => ({
    status: 1,
    stdout: '',
    stderr: 'pane not found',
  }));

  const result = paneLaunch.killPane('99');
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'pane not found');
});


