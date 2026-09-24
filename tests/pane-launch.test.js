'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const paneLaunch = require('../scripts/shared/pane-launch');
const { buildLoginShellExecArgs } = require('../scripts/shared/agent-exec');
const { createTempDirScope } = require('../scripts/shared/temp-directory');
const { installWeztermCommandPorts, weztermCall } = require('./_wezterm-command-recorder');
const { launchAgentInWindow } = paneLaunch;

const tempDirScope = createTempDirScope();
test.after(() => tempDirScope.cleanup());

// このモジュールに残るのは assistant（対話型ワーカー）専用の起動経路だけ。
// orchestrator管理下のワーカーの起動は shared/headless-launch.js へ移行した（Issue #151）。
function shellArgs(argv, onExit = null, env = {}) {
  return buildLoginShellExecArgs(argv, process.platform, onExit, env);
}

function spawnArgs(argv, cwd, onExit = null, env = {}) {
  return ['cli', '--no-auto-start', 'spawn', '--new-window', '--cwd', cwd, '--', ...shellArgs(argv, onExit, env)];
}

function splitArgs(argv, cwd, targetPaneId, direction = 'bottom', percent = 15, onExit = null, env = {}) {
  return [
    'cli', '--no-auto-start', 'split-pane',
    '--pane-id', String(targetPaneId),
    `--${direction}`,
    '--percent', String(percent),
    '--cwd', cwd,
    '--',
    ...shellArgs(argv, onExit, env),
  ];
}

function connectionOptions(connection) {
  return {
    env: {
      ...process.env,
      WEZTERM_UNIX_SOCKET: connection.unixSocket,
    },
  };
}

test('launchAgentInWindow: spawn成功でpaneIdを返す', () => {
  installWeztermCommandPorts({
    spawnWindow: [weztermCall(
      spawnArgs(['agy', '--prompt-interactive', 'hello'], '/tmp/ws'),
      { status: 0, stdout: '42', stderr: '' },
    )],
  });
  const result = launchAgentInWindow({
    argv: ['agy', '--prompt-interactive', 'hello'],
    cwd: '/tmp/ws',
  });
  assert.equal(result.paneId, '42');
});

test('launchAgentInWindow: --new-window --cwd を伴う spawn 引数を組み立てる（splitFromPaneId等は不要）', () => {
  installWeztermCommandPorts({
    spawnWindow: [weztermCall(
      spawnArgs(['agy', '--prompt-interactive', 'hi'], '/tmp/ws-2'),
      { status: 0, stdout: '99', stderr: '' },
    )],
  });

  assert.equal(
    launchAgentInWindow({ argv: ['agy', '--prompt-interactive', 'hi'], cwd: '/tmp/ws-2' }).paneId,
    '99',
  );
});

test('launchAgentInWindow: spawn失敗でthrow', () => {
  installWeztermCommandPorts({
    spawnWindow: [weztermCall(
      spawnArgs(['agy'], '/tmp/ws'),
      { status: 1, stdout: '', stderr: 'nope' },
    )],
  });

  assert.throws(
    () => launchAgentInWindow({ argv: ['agy'], cwd: '/tmp/ws' }),
    /WezTermウィンドウの起動に失敗しました: nope/
  );
});

test('launchAgentInWindow: pane-idが空ならthrow', () => {
  installWeztermCommandPorts({
    spawnWindow: [weztermCall(
      spawnArgs(['agy'], '/tmp/ws'),
      { status: 0, stdout: '', stderr: '' },
    )],
  });

  assert.throws(
    () => launchAgentInWindow({ argv: ['agy'], cwd: '/tmp/ws' }),
    /pane-id を取得できませんでした/
  );
});

test('launchInSplitPane: split-pane成功でpaneIdを返す（既定: bottom 15%）', () => {
  installWeztermCommandPorts({
    splitPane: [weztermCall(
      splitArgs(['node', 'worker-status.js', 'watch'], '/tmp/ws', '0'),
      { status: 0, stdout: '55', stderr: '' },
    )],
  });

  const result = paneLaunch.launchInSplitPane({
    argv: ['node', 'worker-status.js', 'watch'],
    cwd: '/tmp/ws',
    targetPaneId: '0',
  });

  assert.equal(result.paneId, '55');
});

test('launchInSplitPane: direction と percent をカスタマイズできる', () => {
  installWeztermCommandPorts({
    splitPane: [weztermCall(
      splitArgs(['node', 'worker-status.js', 'watch'], '/tmp/ws', 'base-1', 'right', 25),
      { status: 0, stdout: '56', stderr: '' },
    )],
  });

  paneLaunch.launchInSplitPane({
    argv: ['node', 'worker-status.js', 'watch'],
    cwd: '/tmp/ws',
    direction: 'right',
    percent: 25,
    targetPaneId: 'base-1',
  });

});

test('launchInSplitPane: split-pane失敗でthrow', () => {
  installWeztermCommandPorts({
    splitPane: [weztermCall(
      splitArgs(['node'], '/tmp/ws', '0'),
      { status: 1, stdout: '', stderr: 'split failed' },
    )],
  });

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws', targetPaneId: '0' }),
    /WezTermペインの分割起動に失敗しました: split failed/
  );
});

test('launchInSplitPane: pane-idが空ならthrow', () => {
  installWeztermCommandPorts({
    splitPane: [weztermCall(
      splitArgs(['node'], '/tmp/ws', '0'),
      { status: 0, stdout: '', stderr: '' },
    )],
  });

  assert.throws(
    () => paneLaunch.launchInSplitPane({ argv: ['node'], cwd: '/tmp/ws', targetPaneId: '0' }),
    /pane-id を取得できませんでした/
  );
});

test('getAlivePaneIds: listのJSON出力からSet<string>を構築する', () => {
  installWeztermCommandPorts({
    listPanes: [weztermCall(
      ['cli', '--no-auto-start', 'list', '--format', 'json'],
      {
        status: 0,
        stdout: JSON.stringify([{ pane_id: 1 }, { pane_id: '42' }, { pane_id: 99 }]),
        stderr: '',
      },
    )],
  });

  const result = paneLaunch.getAlivePaneIds();
  assert.equal(result.size, 3);
  assert.ok(result.has('1'));
  assert.ok(result.has('42'));
  assert.ok(result.has('99'));
  assert.ok(!result.has('100'));
});

test('getAlivePaneIds: status!=0 の場合はwarnを呼び null を返す（0件生存と区別）', () => {
  let warned = null;
  installWeztermCommandPorts({
    listPanes: [weztermCall(
      ['cli', '--no-auto-start', 'list', '--format', 'json'],
      { status: 1, stdout: '', stderr: 'wezterm not running' },
    )],
  });

  const result = paneLaunch.getAlivePaneIds((msg) => { warned = msg; });
  assert.equal(result, null);
  assert.match(warned, /wezterm cli list 失敗: wezterm not running/);
});

test('pane操作: 記録済み接続先をWezTermコマンドの環境へ渡す', () => {
  const connection = { unixSocket: 'C:\\wezterm\\socket-A', targetPaneId: 'base-A' };
  const options = connectionOptions(connection);
  installWeztermCommandPorts({
    listPanes: [weztermCall(
      ['cli', '--no-auto-start', 'list', '--format', 'json'],
      { status: 0, stdout: JSON.stringify([{ pane_id: '77' }]), stderr: '' },
      options,
    )],
    killPane: [weztermCall(
      ['cli', '--no-auto-start', 'kill-pane', '--pane-id', '77'],
      { status: 0, stdout: '', stderr: '' },
      options,
    )],
    splitPane: [weztermCall(
      splitArgs(['node'], '/tmp/ws', connection.targetPaneId),
      { status: 0, stdout: '88', stderr: '' },
      options,
    )],
  });

  assert.equal(paneLaunch.isPaneAlive('77', undefined, connection), true);
  assert.equal(paneLaunch.killPane('77', connection).ok, true);
  assert.equal(paneLaunch.launchInSplitPane({
    argv: ['node'],
    cwd: '/tmp/ws',
    targetPaneId: connection.targetPaneId,
    connection,
  }).paneId, '88');
});

test('getAlivePaneIds: JSONパース失敗時はwarnを呼び null を返す', () => {
  let warned = null;
  installWeztermCommandPorts({
    listPanes: [weztermCall(
      ['cli', '--no-auto-start', 'list', '--format', 'json'],
      { status: 0, stdout: 'not json', stderr: '' },
    )],
  });

  const result = paneLaunch.getAlivePaneIds((msg) => { warned = msg; });
  assert.equal(result, null);
  assert.match(warned, /wezterm cli list の出力パース失敗/);
});

test('isPaneAlive: paneIdの生存を正しく判定する', () => {
  const listArgs = ['cli', '--no-auto-start', 'list', '--format', 'json'];
  const aliveResult = { status: 0, stdout: JSON.stringify([{ pane_id: 10 }]), stderr: '' };
  installWeztermCommandPorts({
    listPanes: [
      weztermCall(listArgs, aliveResult),
      weztermCall(listArgs, aliveResult),
      weztermCall(listArgs, aliveResult),
      weztermCall(listArgs, { status: 1, stdout: '', stderr: 'error' }),
    ],
  });

  assert.equal(paneLaunch.isPaneAlive('10'), true);
  assert.equal(paneLaunch.isPaneAlive(10), true);
  assert.equal(paneLaunch.isPaneAlive('999'), false);
  assert.equal(paneLaunch.isPaneAlive(''), false);
  assert.equal(paneLaunch.isPaneAlive(null), false);
  assert.equal(paneLaunch.isPaneAlive(undefined), false);

  // 一覧取得失敗時は死亡へ縮退せず判定不能としてthrow
  assert.throws(
    () => paneLaunch.isPaneAlive('10'),
    /外部コマンドの照会失敗.*wezterm cli list --format json/,
  );
});

test('isPaneAlive: 消滅した接続先へのlist失敗は stale 接続として分類する', () => {
  const connection = { unixSocket: `${__filename}.missing-stale-socket`, targetPaneId: '0' };
  installWeztermCommandPorts({
    listPanes: [weztermCall(
      ['cli', '--no-auto-start', 'list', '--format', 'json'],
      { status: 1, stdout: '', stderr: 'failed to connect' },
      connectionOptions(connection),
    )],
  });

  assert.throws(
    () => paneLaunch.isPaneAlive('10', undefined, connection),
    (error) => {
      assert.equal(error.code, paneLaunch.WEZTERM_CONNECTION_GONE_CODE);
      assert.match(error.message, /connection=/);
      return true;
    },
  );
});

test('isPaneAlive: 接続先が存在するlist失敗は stale と判定せず判定不能のまま止める', () => {
  const connection = { unixSocket: __filename, targetPaneId: '0' };
  installWeztermCommandPorts({
    listPanes: [weztermCall(
      ['cli', '--no-auto-start', 'list', '--format', 'json'],
      { status: 1, stdout: '', stderr: 'temporary failure' },
      connectionOptions(connection),
    )],
  });

  assert.throws(
    () => paneLaunch.isPaneAlive('10', undefined, connection),
    (error) => {
      assert.notEqual(error.code, paneLaunch.WEZTERM_CONNECTION_GONE_CODE);
      assert.match(error.message, /外部コマンドの照会失敗/);
      return true;
    },
  );
});

test('killPane: paneIdを指定して正常にkillできる', () => {
  installWeztermCommandPorts({
    killPane: [weztermCall(
      ['cli', '--no-auto-start', 'kill-pane', '--pane-id', '42'],
      { status: 0, stdout: '', stderr: '' },
    )],
  });

  const result = paneLaunch.killPane('42');
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test('killPane: 空のpaneIdはエラー結果を返す', () => {
  const result = paneLaunch.killPane('');
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /paneId is required/);
});

test('killPane: kill失敗時はステータスとstderrを返す', () => {
  installWeztermCommandPorts({
    killPane: [weztermCall(
      ['cli', '--no-auto-start', 'kill-pane', '--pane-id', '99'],
      { status: 1, stdout: '', stderr: 'pane not found' },
    )],
  });

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

test('WezTerm差し替え口: plain Function は拒否し null は本番実装へ戻す', () => {
  const setters = [
    '_setWeztermSpawnWindow',
    '_setWeztermSplitPane',
    '_setWeztermListPanes',
    '_setWeztermKillPane',
  ];
  for (const setter of setters) {
    assert.throws(
      () => paneLaunch[setter](() => ({ status: 0, stdout: '', stderr: '' })),
      /command port または null/,
    );
    paneLaunch[setter](null);
  }
});

test('WezTerm command port: argv または環境が期待と異なる呼び出しを拒否する', () => {
  const expectedArgs = ['cli', '--no-auto-start', 'list', '--format', 'json'];
  const argvPort = paneLaunch._createWeztermCommandPort('list-panes', [weztermCall(
    expectedArgs,
    { status: 0, stdout: '[]', stderr: '' },
  )]);
  assert.throws(
    () => argvPort.invoke(['cli', '--no-auto-start', 'list'], {}),
    /呼び出し引数が期待と異なります: argv/,
  );

  const port = paneLaunch._createWeztermCommandPort('list-panes', [weztermCall(
    expectedArgs,
    { status: 0, stdout: '[]', stderr: '' },
    { env: { WEZTERM_UNIX_SOCKET: 'expected' } },
  )]);

  paneLaunch._setWeztermListPanes(port);
  assert.throws(() => paneLaunch.getAlivePaneIds(), /呼び出し引数が期待と異なります: environment/);
  paneLaunch._setWeztermListPanes(null);
});

test('WezTerm command port: 空の期待呼び出しは外部コマンドなしを許可する', () => {
  installWeztermCommandPorts({ listPanes: [] });
  assert.equal(paneLaunch.isPaneAlive('', undefined), false);
});

test('WezTerm command port: 期待より多い呼び出しを拒否する', () => {
  const port = paneLaunch._createWeztermCommandPort('list-panes', []);
  paneLaunch._setWeztermListPanes(port);
  assert.throws(() => paneLaunch.getAlivePaneIds(), /宣言されていない呼び出し/);
  paneLaunch._setWeztermListPanes(null);
});

test('WezTerm command port: 未消費の期待呼び出しを完了確認で拒否する', () => {
  const port = paneLaunch._createWeztermCommandPort('list-panes', [weztermCall(
    ['cli', '--no-auto-start', 'list', '--format', 'json'],
    { status: 0, stdout: '[]', stderr: '' },
  )]);
  assert.throws(() => port.assertComplete(), /期待呼び出しが未消費/);
});

test('WezTerm command recorder: 完了確認を明示的に呼ばなくても afterEach が未消費期待を拒否する', () => {
  const fixtureDir = tempDirScope.mkdtemp('ghm-wezterm-recorder-');
  const fixturePath = path.join(fixtureDir, 'after-each.test.js');
  const helperPath = path.join(__dirname, '_wezterm-command-recorder.js');
  const fixture = [
    "'use strict';",
    "const { test } = require('node:test');",
    `const { installWeztermCommandPorts, weztermCall } = require(${JSON.stringify(helperPath)});`,
    "test('未消費の期待呼び出しを残したテスト', () => {",
    '  installWeztermCommandPorts({',
    '    listPanes: [weztermCall(',
    "      ['cli', '--no-auto-start', 'list', '--format', 'json'],",
    "      { status: 0, stdout: '[]', stderr: '' },",
    '    )],',
    '  });',
    '});',
  ].join('\n');
  fs.writeFileSync(fixturePath, fixture, 'utf8');

  try {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', fixturePath], {
      cwd: path.join(__dirname, '..'),
      env: childEnv,
      encoding: 'utf8',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /期待呼び出しが未消費/);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});



