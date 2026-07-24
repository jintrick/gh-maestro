'use strict';
// pane-launch.js — WezTermペインでエージェントを起動する共通ロジック
//
// spawn-worker.js（新規ワーカー起動）と inbox-supervisor.js（休止中ワーカーのresume起動）の
// 両方から使われる。ログインシェルラップ → split-pane（フォールバック付き）→ paneId抽出 →
// （send-text-after-launch方式の場合）遅延後のプロンプト送信、までを1つの関数に集約する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { spawnSync } = require('../child-process');
const { buildLoginShellExecArgs } = require('../agent-exec');

// ── wezterm 呼び出し（テストで注入可能） ──────────────────────────────────
// inbox-supervisor.js の _setWeztermListPanes / _setWeztermSendText と同型のパターン。

// ワーカーペインの既定の高さ（行数）。--cells指定なしのwezterm既定（50%分割）だと、
// 直前ワーカーの下へ次々split-paneする現行レイアウトでは新規ペインが幾何級数的に
// 縮んでいく（50%→25%→12.5%...）。固定行数にすることで積み上げても高さが一定になる。
const DEFAULT_WORKER_PANE_ROWS = 5;

let _weztermSplitPane = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });
let _weztermSpawnWindow = (args) => spawnSync('wezterm', args, { encoding: 'utf8' });
let _weztermKillPane = (paneId) =>
  spawnSync('wezterm', ['cli', '--no-auto-start', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8' });
let _weztermSendText = (paneId, text) =>
  spawnSync('wezterm', ['cli', '--no-auto-start', 'send-text', '--pane-id', paneId, '--no-paste', text], { encoding: 'utf8' });
let _sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * argv を実行するWezTermペインを作成する（ログインシェル経由）。
 * splitFromPaneId での分割に失敗し、それが orchPaneId と異なる場合は orchPaneId へのフォールバックを試みる。
 * promptDelivery が send-text-after-launch 方式のエージェント向けに、
 * ペイン作成後の遅延送信（afterLaunchText）にも対応する。
 *
 * @param {object} params
 * @param {string[]} params.argv               - エージェントコマンド + 全引数（buildAgentCommandArgs /
 *   buildAgentResumeCommandArgs の argv）
 * @param {string} params.worktreeDir           - ペインの作業ディレクトリ
 * @param {string} params.splitFromPaneId       - 分割元のペインID
 * @param {string} [params.orchPaneId]          - フォールバック先（orchestratorのペインID）
 * @param {string} [params.direction='bottom']  - 'right' | 'bottom'
 * @param {number|null} [params.splitCells=5]  - 新規ペインの高さ（行数）。nullなら--cellsを付けずwezterm既定（50%分割）を使う
 * @param {string|null} [params.afterLaunchText] - send-text-after-launch方式のプロンプト本文（無ければ送信しない）
 * @param {number} [params.sendTextDelayMs=2000] - afterLaunchText送信前の遅延（TUI初期化待ち）
 * @param {string} [params.enterTerminator='\r'] - afterLaunchText送信後に送る改行シーケンス
 * @param {object} [params.env={}] - 起動プロセスに注入する環境変数（例: { GH_MAESTRO_WORKER, GH_MAESTRO_WORKSPACE }）
 * @returns {{ paneId: string, afterLaunchTextSent: boolean|null }}
 *   afterLaunchTextSent: afterLaunchText未指定ならnull、指定時はsend-textが成功したか
 * @throws {Error} ペイン作成に失敗した場合（フォールバックも失敗した場合を含む）
 */
function launchAgentInPane({
  argv,
  worktreeDir,
  splitFromPaneId,
  orchPaneId,
  direction = 'bottom',
  splitCells = DEFAULT_WORKER_PANE_ROWS,
  afterLaunchText = null,
  sendTextDelayMs = 2000,
  enterTerminator = '\r',
  onExit = null,
  env = {},
}) {
  const loginShellArgs = buildLoginShellExecArgs(argv, process.platform, onExit, env);
  const sizeArgs = splitCells != null ? ['--cells', String(splitCells)] : [];
  const splitArgs = ['cli', '--no-auto-start', 'split-pane', `--${direction}`, ...sizeArgs, '--cwd', worktreeDir, '--pane-id', splitFromPaneId, '--', ...loginShellArgs];

  let split = _weztermSplitPane(splitArgs);
  if (split.status !== 0) {
    if (orchPaneId && splitFromPaneId !== orchPaneId) {
      const fallbackArgs = ['cli', '--no-auto-start', 'split-pane', '--bottom', ...sizeArgs, '--cwd', worktreeDir, '--pane-id', orchPaneId, '--', ...loginShellArgs];
      const split2 = _weztermSplitPane(fallbackArgs);
      if (split2.status !== 0) {
        throw new Error(`WezTermペインの分割に失敗しました（フォールバックも失敗）: ${(split2.stderr || '').toString().trim()}`);
      }
      split = split2;
    } else {
      throw new Error(`WezTermペインの分割に失敗しました: ${(split.stderr || '').toString().trim()}`);
    }
  }

  const paneId = (split.stdout ?? '').toString().trim();
  if (!paneId) {
    throw new Error(
      `wezterm split-pane の pane-id を取得できませんでした（ペインが作成された可能性があります）: ` +
      `stdout=${JSON.stringify(split.stdout)} stderr=${(split.stderr || '').toString().trim()}`
    );
  }

  let afterLaunchTextSent = null;
  if (afterLaunchText) {
    _sleep(sendTextDelayMs);
    const sendResult = _weztermSendText(paneId, afterLaunchText);
    afterLaunchTextSent = sendResult.status === 0;
    if (afterLaunchTextSent) {
      _weztermSendText(paneId, enterTerminator);
    }
    // send-text失敗はペイン起動自体の失敗として扱わない（呼び出し元はpaneIdを受け取って続行できる）
  }

  return { paneId, afterLaunchTextSent };
}

/**
 * argv を実行する新規WezTermウィンドウを作成する（ログインシェル経由）。
 *
 * launchAgentInPane と異なり、分割元ペイン（splitFromPaneId/orchPaneId/direction）という
 * 概念を持たない — 独立したOSウィンドウとして起動するため、他ワーカーのペインレイアウトに
 * 依存・干渉しない（`wezterm cli spawn --new-window`、docs/rag/wezterm/reference/spawn.md 参照）。
 * 返る pane-id は split-pane 由来のものと同様に kill-pane で終了できる。
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

/**
 * ペインをbest-effortで終了する（ロールバック用）。失敗は無視する。
 *
 * @param {string} paneId
 */
function killPaneQuiet(paneId) {
  try {
    _weztermKillPane(paneId);
  } catch {
    // ロールバック処理なのでエラーは無視する
  }
}

module.exports = {
  launchAgentInPane,
  launchAgentInWindow,
  killPaneQuiet,
  DEFAULT_WORKER_PANE_ROWS,
  _setWeztermSplitPane: (fn) => { _weztermSplitPane = fn; },
  _setWeztermSpawnWindow: (fn) => { _weztermSpawnWindow = fn; },
  _setWeztermKillPane: (fn) => { _weztermKillPane = fn; },
  _setWeztermSendText: (fn) => { _weztermSendText = fn; },
  _setSleep: (fn) => { _sleep = fn; },
};
