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

// wezterm 呼び出し（テストで注入可能）
let _weztermSpawnWindow = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });

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

module.exports = {
  launchAgentInWindow,
  _setWeztermSpawnWindow: (fn) => { _weztermSpawnWindow = fn; },
};
