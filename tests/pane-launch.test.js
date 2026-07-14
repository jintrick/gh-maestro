'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const paneLaunch = require('../scripts/shared/pane-launch');
const { launchAgentInPane, killPaneQuiet } = paneLaunch;

beforeEach(() => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 0, stdout: '42', stderr: '' }));
  paneLaunch._setWeztermKillPane(() => ({ status: 0, stdout: '', stderr: '' }));
  paneLaunch._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));
  paneLaunch._setSleep(() => {});
});

test('launchAgentInPane: split成功でpaneIdを返す', () => {
  const result = launchAgentInPane({
    argv: ['agy', '--continue'],
    worktreeDir: '/tmp/wt',
    splitFromPaneId: '1',
  });
  assert.equal(result.paneId, '42');
  assert.equal(result.afterLaunchTextSent, null);
});

test('launchAgentInPane: splitFromPaneIdでの分割成功時はsplit-pane引数にworktreeDir/paneIdが含まれる', () => {
  let capturedArgs = null;
  paneLaunch._setWeztermSplitPane((args) => {
    capturedArgs = args;
    return { status: 0, stdout: '99', stderr: '' };
  });

  launchAgentInPane({
    argv: ['codex', 'exec'],
    worktreeDir: '/tmp/wt-2',
    splitFromPaneId: '7',
    direction: 'right',
  });

  assert.ok(capturedArgs.includes('--right'));
  assert.ok(capturedArgs.includes('/tmp/wt-2'));
  assert.ok(capturedArgs.includes('7'));
});

test('launchAgentInPane: 分割失敗かつorchPaneIdが異なる場合はフォールバックする', () => {
  let calls = 0;
  paneLaunch._setWeztermSplitPane((args) => {
    calls++;
    if (calls === 1) return { status: 1, stdout: '', stderr: 'split failed' };
    return { status: 0, stdout: '55', stderr: '' };
  });

  const result = launchAgentInPane({
    argv: ['agy', '--continue'],
    worktreeDir: '/tmp/wt',
    splitFromPaneId: '7',
    orchPaneId: '1',
  });

  assert.equal(result.paneId, '55');
  assert.equal(calls, 2);
});

test('launchAgentInPane: 分割失敗かつフォールバックも失敗したらthrow', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 1, stdout: '', stderr: 'nope' }));

  assert.throws(
    () => launchAgentInPane({ argv: ['agy'], worktreeDir: '/tmp/wt', splitFromPaneId: '7', orchPaneId: '1' }),
    /分割に失敗しました（フォールバックも失敗）/
  );
});

test('launchAgentInPane: splitFromPaneIdとorchPaneIdが同一のときフォールバックせず即throw', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 1, stdout: '', stderr: 'nope' }));

  assert.throws(
    () => launchAgentInPane({ argv: ['agy'], worktreeDir: '/tmp/wt', splitFromPaneId: '1', orchPaneId: '1' }),
    /WezTermペインの分割に失敗しました: nope/
  );
});

test('launchAgentInPane: pane-idが空ならthrow', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 0, stdout: '', stderr: '' }));

  assert.throws(
    () => launchAgentInPane({ argv: ['agy'], worktreeDir: '/tmp/wt', splitFromPaneId: '1' }),
    /pane-id を取得できませんでした/
  );
});

test('launchAgentInPane: afterLaunchText指定時はsend-text→terminatorの順に送信し成功を返す', () => {
  const sentTexts = [];
  paneLaunch._setWeztermSendText((paneId, text) => {
    sentTexts.push({ paneId, text });
    return { status: 0, stdout: '', stderr: '' };
  });

  const result = launchAgentInPane({
    argv: ['node', 'reasonix.js'],
    worktreeDir: '/tmp/wt',
    splitFromPaneId: '1',
    afterLaunchText: '新着メッセージ',
    enterTerminator: '\n',
  });

  assert.equal(result.afterLaunchTextSent, true);
  assert.deepEqual(sentTexts, [
    { paneId: '42', text: '新着メッセージ' },
    { paneId: '42', text: '\n' },
  ]);
});

test('launchAgentInPane: afterLaunchTextのsend-text失敗時はafterLaunchTextSent=falseでpaneIdは返す（起動自体は失敗にしない）', () => {
  paneLaunch._setWeztermSendText(() => ({ status: 1, stdout: '', stderr: 'send failed' }));

  const result = launchAgentInPane({
    argv: ['node', 'reasonix.js'],
    worktreeDir: '/tmp/wt',
    splitFromPaneId: '1',
    afterLaunchText: '新着メッセージ',
  });

  assert.equal(result.paneId, '42');
  assert.equal(result.afterLaunchTextSent, false);
});

test('launchAgentInPane: afterLaunchText未指定ならsend-textを呼ばない', () => {
  let called = false;
  paneLaunch._setWeztermSendText(() => { called = true; return { status: 0, stdout: '', stderr: '' }; });

  launchAgentInPane({ argv: ['agy'], worktreeDir: '/tmp/wt', splitFromPaneId: '1' });

  assert.equal(called, false);
});

test('killPaneQuiet: 正常系でkill-paneを呼ぶ', () => {
  let called = null;
  paneLaunch._setWeztermKillPane((paneId) => { called = paneId; return { status: 0 }; });

  killPaneQuiet('42');
  assert.equal(called, '42');
});

test('killPaneQuiet: kill-paneが例外を投げても無視する', () => {
  paneLaunch._setWeztermKillPane(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => killPaneQuiet('42'));
});
