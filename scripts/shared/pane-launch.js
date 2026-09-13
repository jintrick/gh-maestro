'use strict';
// pane-launch.js — assistant を新規WezTermウィンドウで起動する
//
// かつては全ワーカーの起動基盤（split-paneによるペイン生成）だったが、Issue #151 で
// orchestrator 管理下のワーカーは shared/headless-launch.js による headless 起動へ移行した。
// ここに残るのは assistant 専用の経路だけである。
//
// assistant（`spawn-assistant.js`）は headless 化しない。人間が直接そのウィンドウに
// 話しかける対話型ワーカーであり、画面があること自体が機能だからである。
// orchestrator の管理対象外で、Issue とともに生まれ Issue とともに消える。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { spawnSync, realSpawnDisabledReason } = require('./child-process');
const { buildLoginShellExecArgs } = require('./agent-exec');

const WEZTERM_PANE_ENV = 'WEZTERM_PANE';
const WEZTERM_UNIX_SOCKET_ENV = 'WEZTERM_UNIX_SOCKET';

// テスト中に実WezTermペイン・ウィンドウを起動してしまう事故を構造的に防ぐガード。
// 抑止判定の正本は child-process.js::realSpawnDisabledReason を利用する。

const defaultWeztermSpawnWindow = (args, options = {}) => spawnSync('wezterm', args, { encoding: 'utf8', ...options });
const defaultWeztermSplitPane = (args, options = {}) => spawnSync('wezterm', args, { encoding: 'utf8', ...options });
const defaultWeztermListPanes = (args, options = {}) => spawnSync('wezterm', args, { encoding: 'utf8', ...options });
const defaultWeztermKillPane = (args, options = {}) => spawnSync('wezterm', args, { encoding: 'utf8', ...options });

// wezterm 呼び出し（テストで注入可能）
let _weztermSpawnWindow = defaultWeztermSpawnWindow;
let _weztermSplitPane = defaultWeztermSplitPane;
let _weztermListPanes = defaultWeztermListPanes;
let _weztermKillPane = defaultWeztermKillPane;

function hasValue(value) {
  return value !== null && value !== undefined && String(value) !== '';
}

/**
 * 現在の WezTerm CLI 接続先と split の基準ペインを返す。
 *
 * `WEZTERM_PANE` だけでは別の WezTerm mux/server と区別できないため、
 * `WEZTERM_UNIX_SOCKET` と組にして保存する。どちらかが無い環境では、
 * 呼び出し元を推測して別の window に作ることを避けるため null を返す。
 *
 * @returns {{unixSocket: string, targetPaneId: string}|null}
 */
function getCurrentPaneTarget() {
  const unixSocket = process.env[WEZTERM_UNIX_SOCKET_ENV];
  const targetPaneId = process.env[WEZTERM_PANE_ENV];
  if (!hasValue(unixSocket) || !hasValue(targetPaneId)) return null;
  return {
    unixSocket: String(unixSocket),
    targetPaneId: String(targetPaneId),
  };
}

function commandOptionsForConnection(connection) {
  if (connection === null || connection === undefined) return {};
  const unixSocket = connection && typeof connection === 'object'
    ? connection.unixSocket
    : connection;
  if (!hasValue(unixSocket)) {
    throw new Error('WezTermの接続先（unixSocket）が記録されていません');
  }
  return {
    env: {
      ...process.env,
      [WEZTERM_UNIX_SOCKET_ENV]: String(unixSocket),
    },
  };
}

/**
 * argv を実行する新規WezTermウィンドウを作成する（ログインシェル経由）。
 *
 * 独立したOSウィンドウとして起動するため、他の何のレイアウトにも依存・干渉しない
 * （`wezterm cli spawn --new-window`、docs/rag/wezterm/reference/spawn.md 参照）。
 * 返る pane-id は kill-pane で終了できる（`finalize-issue.js` が Issue クローズ時に使う）。
 *
 * @param {object} params
 * @param {string[]} params.argv    - エージェントコマンド + 全引数
 * @param {string} params.cwd       - ウィンドウの作業ディレクトリ
 * @param {object} [params.env={}]  - 起動プロセスに注入する環境変数
 * @param {object} [params.onExit=null] - agent-exec.js の buildLoginShellExecArgs に渡す終了フック
 * @returns {{ paneId: string }}
 * @throws {Error} ウィンドウ作成に失敗した場合
 */
function launchAgentInWindow({ argv, cwd, env = {}, onExit = null }) {
  const disabledReason = _weztermSpawnWindow === defaultWeztermSpawnWindow ? realSpawnDisabledReason() : null;
  if (disabledReason) {
    throw new Error(
      `WezTermウィンドウを起動しません: ${disabledReason}。` +
      `起動経路をテストから検証する場合は _setWeztermSpawnWindow で注入してください。`
    );
  }

  const loginShellArgs = buildLoginShellExecArgs(argv, process.platform, onExit, env);
  const spawnArgs = ['cli', '--no-auto-start', 'spawn', '--new-window', '--cwd', cwd, '--', ...loginShellArgs];

  const result = _weztermSpawnWindow(spawnArgs);
  if (result.status !== 0) {
    throw new Error(`WezTermウィンドウの起動に失敗しました: ${(result.stderr || '').toString().trim()}`);
  }

  const paneId = (result.stdout ?? '').toString().trim();
  if (!paneId) {
    throw new Error(
      `wezterm cli spawn の pane-id を取得できませんでした（ウィンドウが作成された可能性があります）: ` +
      `stdout=${JSON.stringify(result.stdout)} stderr=${(result.stderr || '').toString().trim()}`
    );
  }

  return { paneId };
}

/**
 * argv を実行するWezTermスプリットペインを作成する（ログインシェル経由）。
 *
 * @param {object} params
 * @param {string[]} params.argv           - 実行コマンド + 全引数
 * @param {string} params.cwd              - ペインの作業ディレクトリ
 * @param {string} [params.direction='bottom'] - 分割方向 ('bottom' | 'right' | 'top' | 'left')
 * @param {number} [params.percent=15]     - 画面占有率（%）
 * @param {string|number} params.targetPaneId - 分割元の基準ペイン
 * @param {{unixSocket: string}} [params.connection] - 接続先（省略時は現在の環境）
 * @param {object} [params.env={}]         - 起動プロセスに注入する環境変数
 * @param {object} [params.onExit=null]    - agent-exec.js の buildLoginShellExecArgs に渡す終了フック
 * @returns {{ paneId: string }}
 * @throws {Error} ペイン作成に失敗した場合
 */
function launchInSplitPane({
  argv,
  cwd,
  direction = 'bottom',
  percent = 15,
  targetPaneId,
  connection = null,
  env = {},
  onExit = null,
}) {
  const disabledReason = _weztermSplitPane === defaultWeztermSplitPane ? realSpawnDisabledReason() : null;
  if (disabledReason) {
    throw new Error(
      `WezTermペインを起動しません: ${disabledReason}。` +
      `起動経路をテストから検証する場合は _setWeztermSplitPane で注入してください。`
    );
  }

  if (!hasValue(targetPaneId)) {
    throw new Error('WezTerm split-pane の基準pane-idが必要です');
  }

  const loginShellArgs = buildLoginShellExecArgs(argv, process.platform, onExit, env);
  const validDirections = new Set(['bottom', 'right', 'top', 'left']);
  const dir = validDirections.has(direction) ? direction : 'bottom';
  const pct = Number.isFinite(Number(percent)) && Number(percent) > 0 && Number(percent) < 100 ? Number(percent) : 15;

  const spawnArgs = [
    'cli', '--no-auto-start', 'split-pane',
    '--pane-id', String(targetPaneId),
    `--${dir}`,
    '--percent', String(pct),
    '--cwd', cwd,
    '--',
    ...loginShellArgs,
  ];

  const result = _weztermSplitPane(spawnArgs, commandOptionsForConnection(connection));
  if (result.status !== 0) {
    throw new Error(`WezTermペインの分割起動に失敗しました: ${(result.stderr || '').toString().trim()}`);
  }

  const paneId = (result.stdout ?? '').toString().trim();
  if (!paneId) {
    throw new Error(
      `wezterm cli split-pane の pane-id を取得できませんでした（ペインが作成された可能性があります）: ` +
      `stdout=${JSON.stringify(result.stdout)} stderr=${(result.stderr || '').toString().trim()}`
    );
  }

  return { paneId };
}

/**
 * 現在 WezTerm に存在する pane_id の Set<string> を返す。
 * 取得に失敗した場合は warn を呼び null を返す（0件存在とは区別する）。
 *
 * @param {Function} [warn]
 * @param {{unixSocket: string}} [connection]
 * @returns {Set<string>|null}
 */
function getAlivePaneIds(warn = () => {}, connection = null) {
  const r = _weztermListPanes(
    ['cli', '--no-auto-start', 'list', '--format', 'json'],
    commandOptionsForConnection(connection),
  );
  if (r.status !== 0) {
    warn(`wezterm cli list 失敗: ${(r.stderr || '').toString().trim()} — pane生存確認をスキップします`);
    return null;
  }
  try {
    const list = JSON.parse((r.stdout || '').toString());
    if (!Array.isArray(list)) {
      warn(`wezterm cli list の出力が配列ではありません — pane生存確認をスキップします`);
      return null;
    }
    return new Set(list.filter((pane) => pane && hasValue(pane.pane_id)).map((pane) => String(pane.pane_id)));
  } catch (e) {
    warn(`wezterm cli list の出力パース失敗: ${e.message} — pane生存確認をスキップします`);
    return null;
  }
}

/**
 * 指定した paneId が生存しているかを判定する。
 *
 * @param {string|number} paneId
 * @param {Function} [warn]
 * @param {{unixSocket: string}} [connection]
 * @returns {boolean}
 * @throws {Error} WezTerm の pane 一覧を照会できない場合
 */
function isPaneAlive(paneId, warn = () => {}, connection = null) {
  if (paneId === null || paneId === undefined || paneId === '') return false;
  let warning = '';
  const alivePanes = getAlivePaneIds((message) => {
    warning = message;
    warn(message);
  }, connection);
  if (alivePanes === null) {
    throw new Error(
      `WezTerm pane一覧の外部コマンドの照会失敗（wezterm cli list --format json）: `
      + (warning || 'pane生存確認を判定できません'),
    );
  }
  return alivePanes.has(String(paneId));
}

/**
 * 指定した paneId の WezTerm ペインを終了する。
 *
 * @param {string|number} paneId
 * @param {{unixSocket: string}} [connection]
 * @returns {{ ok: boolean, status: number, stderr: string, stdout: string }}
 */
function killPane(paneId, connection = null) {
  if (paneId === null || paneId === undefined || paneId === '') {
    return { ok: false, status: 1, stderr: 'paneId is required', stdout: '' };
  }
  const r = _weztermKillPane(
    ['cli', '--no-auto-start', 'kill-pane', '--pane-id', String(paneId)],
    commandOptionsForConnection(connection),
  );
  return {
    ok: r.status === 0,
    status: r.status ?? (r.status === 0 ? 0 : 1),
    stderr: (r.stderr || '').toString().trim(),
    stdout: (r.stdout || '').toString().trim(),
  };
}

module.exports = {
  launchAgentInWindow,
  launchInSplitPane,
  getAlivePaneIds,
  isPaneAlive,
  killPane,
  getCurrentPaneTarget,
  WEZTERM_PANE_ENV,
  WEZTERM_UNIX_SOCKET_ENV,
  _setWeztermSpawnWindow: (fn) => { _weztermSpawnWindow = fn ?? defaultWeztermSpawnWindow; },
  _setWeztermSplitPane: (fn) => { _weztermSplitPane = fn ?? defaultWeztermSplitPane; },
  _setWeztermListPanes: (fn) => { _weztermListPanes = fn ?? defaultWeztermListPanes; },
  _setWeztermKillPane: (fn) => { _weztermKillPane = fn ?? defaultWeztermKillPane; },
};
