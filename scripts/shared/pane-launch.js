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

const { spawnSync } = require('./child-process');
const { buildLoginShellExecArgs } = require('./agent-exec');

// テスト中に実WezTermペイン・ウィンドウを起動してしまう事故を構造的に防ぐガード。
// 「実spawnをenvフラグでゲートする」の
// 実装であり、headless-launch.js と同型のガード。
const REAL_SPAWN_DISABLED_ENV = 'GH_MAESTRO_DISABLE_REAL_SPAWN';

function realSpawnDisabledReason() {
  if (process.env.NODE_TEST_CONTEXT) return 'テスト実行中（NODE_TEST_CONTEXT が設定されています）';
  if (process.env[REAL_SPAWN_DISABLED_ENV]) return `${REAL_SPAWN_DISABLED_ENV} が設定されています`;
  return null;
}

const defaultWeztermSpawnWindow = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });
const defaultWeztermSplitPane = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });
const defaultWeztermListPanes = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });
const defaultWeztermKillPane = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });

// wezterm 呼び出し（テストで注入可能）
let _weztermSpawnWindow = defaultWeztermSpawnWindow;
let _weztermSplitPane = defaultWeztermSplitPane;
let _weztermListPanes = defaultWeztermListPanes;
let _weztermKillPane = defaultWeztermKillPane;

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
 * @param {object} [params.env={}]         - 起動プロセスに注入する環境変数
 * @param {object} [params.onExit=null]    - agent-exec.js の buildLoginShellExecArgs に渡す終了フック
 * @returns {{ paneId: string }}
 * @throws {Error} ペイン作成に失敗した場合
 */
function launchInSplitPane({ argv, cwd, direction = 'bottom', percent = 15, env = {}, onExit = null }) {
  const disabledReason = _weztermSplitPane === defaultWeztermSplitPane ? realSpawnDisabledReason() : null;
  if (disabledReason) {
    throw new Error(
      `WezTermペインを起動しません: ${disabledReason}。` +
      `起動経路をテストから検証する場合は _setWeztermSplitPane で注入してください。`
    );
  }

  const loginShellArgs = buildLoginShellExecArgs(argv, process.platform, onExit, env);
  const validDirections = new Set(['bottom', 'right', 'top', 'left']);
  const dir = validDirections.has(direction) ? direction : 'bottom';
  const pct = Number.isFinite(Number(percent)) && Number(percent) > 0 && Number(percent) < 100 ? Number(percent) : 15;

  const spawnArgs = [
    'cli', '--no-auto-start', 'split-pane',
    `--${dir}`,
    '--percent', String(pct),
    '--cwd', cwd,
    '--',
    ...loginShellArgs,
  ];

  const result = _weztermSplitPane(spawnArgs);
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
 * @returns {Set<string>|null}
 */
function getAlivePaneIds(warn = () => {}) {
  const r = _weztermListPanes(['cli', '--no-auto-start', 'list', '--format', 'json']);
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
    return new Set(list.map(p => String(p.pane_id)));
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
 * @returns {boolean}
 */
function isPaneAlive(paneId, warn = () => {}) {
  if (paneId === null || paneId === undefined || paneId === '') return false;
  const alivePanes = getAlivePaneIds(warn);
  if (alivePanes === null) return false;
  return alivePanes.has(String(paneId));
}

/**
 * 指定した paneId の WezTerm ペインを終了する。
 *
 * @param {string|number} paneId
 * @returns {{ ok: boolean, status: number, stderr: string, stdout: string }}
 */
function killPane(paneId) {
  if (paneId === null || paneId === undefined || paneId === '') {
    return { ok: false, status: 1, stderr: 'paneId is required', stdout: '' };
  }
  const r = _weztermKillPane(['cli', '--no-auto-start', 'kill-pane', '--pane-id', String(paneId)]);
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
  REAL_SPAWN_DISABLED_ENV,
  _setWeztermSpawnWindow: (fn) => { _weztermSpawnWindow = fn ?? defaultWeztermSpawnWindow; },
  _setWeztermSplitPane: (fn) => { _weztermSplitPane = fn ?? defaultWeztermSplitPane; },
  _setWeztermListPanes: (fn) => { _weztermListPanes = fn ?? defaultWeztermListPanes; },
  _setWeztermKillPane: (fn) => { _weztermKillPane = fn ?? defaultWeztermKillPane; },
};
