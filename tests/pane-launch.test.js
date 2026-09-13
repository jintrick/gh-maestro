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
    targetPaneId: '0',
  });

  assert.equal(result.paneId, '55');
  assert.ok(capturedArgs.includes('split-pane'));
  assert.ok(capturedArgs.includes('--bottom'));
  assert.ok(capturedArgs.includes('--percent'));
  assert.ok(capturedArgs.includes('15'));
  assert.ok(capturedArgs.includes('--cwd'));
  assert.ok(capturedArgs.includes('/tmp/ws'));
  assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--pane-id'), capturedArgs.indexOf('--pane-id') + 2), [
    '--pane-id', '0',
  ]);
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
    targetPaneId: 'base-1',
  });

  assert.ok(capturedArgs.includes('--right'));
  assert.ok(capturedArgs.includes('25'));
});

test('launchInSplitPane: split-pane失敗でthrow', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 1, stdout: '', stderr: 'split failed' }));

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws', targetPaneId: '0' }),
    /WezTermペインの分割起動に失敗しました: split failed/
  );
});

test('launchInSplitPane: pane-idが空ならthrow', () => {
  paneLaunch._setWeztermSplitPane(() => ({ status: 0, stdout: '', stderr: '' }));

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws', targetPaneId: '0' }),
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

test('pane操作: 記録済み接続先をWezTermコマンドの環境へ渡す', () => {
  const connection = { unixSocket: 'C:\\wezterm\\socket-A', targetPaneId: 'base-A' };
  const captured = [];
  paneLaunch._setWeztermListPanes((args, options) => {
    captured.push({ kind: 'list', args, options });
    return { status: 0, stdout: JSON.stringify([{ pane_id: '77' }]), stderr: '' };
  });
  paneLaunch._setWeztermKillPane((args, options) => {
    captured.push({ kind: 'kill', args, options });
    return { status: 0, stdout: '', stderr: '' };
  });
  paneLaunch._setWeztermSplitPane((args, options) => {
    captured.push({ kind: 'split', args, options });
    return { status: 0, stdout: '88', stderr: '' };
  });

  try {
    assert.equal(paneLaunch.isPaneAlive('77', undefined, connection), true);
    assert.equal(paneLaunch.killPane('77', connection).ok, true);
    assert.equal(paneLaunch.launchInSplitPane({
      argv: ['node'],
      cwd: '/tmp/ws',
      targetPaneId: connection.targetPaneId,
      connection,
    }).paneId, '88');

    for (const call of captured) {
      assert.equal(call.options.env.WEZTERM_UNIX_SOCKET, connection.unixSocket);
      assert.equal(call.options.env.WEZTERM_PANE, process.env.WEZTERM_PANE);
    }
    assert.deepEqual(captured.at(-1).args.slice(captured.at(-1).args.indexOf('--pane-id'), captured.at(-1).args.indexOf('--pane-id') + 2), [
      '--pane-id', 'base-A',
    ]);
  } finally {
    paneLaunch._setWeztermListPanes(null);
    paneLaunch._setWeztermKillPane(null);
    paneLaunch._setWeztermSplitPane(null);
  }
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

  // 一覧取得失敗時は死亡へ縮退せず判定不能としてthrow
  paneLaunch._setWeztermListPanes(() => ({ status: 1, stdout: '', stderr: 'error' }));
  assert.throws(
    () => paneLaunch.isPaneAlive('10'),
    /外部コマンドの照会失敗.*wezterm cli list --format json/,
  );
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

// ── テスト中の実プロセス・ペイン起動ガード (Issue #425) ──────────────────────────

test('launchAgentInWindow: 未注入時に NODE_TEST_CONTEXT があると claude / agy / codex の実起動を拒否する (Issue #430)', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, '前提: テストランナー配下で実行されている');
  paneLaunch._setWeztermSpawnWindow(null);

  for (const command of ['claude', 'agy', 'codex']) {
    assert.throws(
      () => launchAgentInWindow({ argv: [command], cwd: '/tmp/ws' }),
      /WezTermウィンドウを起動しません.*NODE_TEST_CONTEXT/,
    );
  }
});

test('launchInSplitPane: 未注入時に NODE_TEST_CONTEXT があると実起動を拒否する (Issue #425)', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, '前提: テストランナー配下で実行されている');
  paneLaunch._setWeztermSplitPane(null);

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws', targetPaneId: '0' }),
    /WezTermペインを起動しません.*NODE_TEST_CONTEXT/,
  );
});

test('launchInSplitPane: 未注入時に NODE_TEST_CONTEXT があると claude / agy / codex の実起動を拒否する (Issue #430)', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, '前提: テストランナー配下で実行されている');
  paneLaunch._setWeztermSplitPane(null);

  try {
    for (const command of ['claude', 'agy', 'codex']) {
      assert.throws(
        () => paneLaunch.launchInSplitPane({ argv: [command], cwd: '/tmp/ws', targetPaneId: '0' }),
        /WezTermペインを起動しません.*NODE_TEST_CONTEXT/,
      );
    }
  } finally {
    paneLaunch._setWeztermSplitPane(null);
  }
});

test('launchAgentInWindow / launchInSplitPane: GH_MAESTRO_DISABLE_REAL_SPAWN で実起動を拒否する (Issue #425)', () => {
  paneLaunch._setWeztermSpawnWindow(null);
  paneLaunch._setWeztermSplitPane(null);
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedDisabled = process.env.GH_MAESTRO_DISABLE_REAL_SPAWN;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.GH_MAESTRO_DISABLE_REAL_SPAWN = '1';
  try {
    assert.throws(
      () => launchAgentInWindow({ argv: ['agy'], cwd: '/tmp/ws' }),
      /GH_MAESTRO_DISABLE_REAL_SPAWN/,
    );
    assert.throws(
      () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws', targetPaneId: '0' }),
      /GH_MAESTRO_DISABLE_REAL_SPAWN/,
    );
  } finally {
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
    else delete process.env.NODE_TEST_CONTEXT;
    if (savedDisabled !== undefined) process.env.GH_MAESTRO_DISABLE_REAL_SPAWN = savedDisabled;
    else delete process.env.GH_MAESTRO_DISABLE_REAL_SPAWN;
  }
});



