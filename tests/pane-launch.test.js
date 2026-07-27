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
