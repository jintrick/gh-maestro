'use strict';
// wezterm-cli.js — WezTerm CLI の共有ランナー
//
// WEZTERM_MOCK env があればモックスクリプトを使い（テスト用）、
// なければ実 wezterm バイナリを呼ぶ。
// spawn-worker.js（ペイン起動）等から使われる。

const { spawnSync } = require('./child-process');

const WEZ_TIMEOUT_MS = 6000;

/**
 * wezterm バイナリ（またはモック）を spawnSync する。
 *
 * @param  {...string} args  wezterm に渡す引数（例: 'cli', 'list', '--format', 'json'）
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function weztermCli(...args) {
  const mock = process.env.WEZTERM_MOCK || null;
  if (mock) {
    return spawnSync(process.execPath, [mock, ...args], { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS });
  }
  // 呼び出し元は既にGUIセッション内で動いている前提の制御プレーン操作のみ。
  // --no-auto-start を付けないと、mux未到達時に新しい wezterm-mux-server.exe を
  // 無限に自動起動してしまう（バックグラウンドの定期ヘルスチェックで特に顕著）。
  const withGuard = args[0] === 'cli' ? [args[0], '--no-auto-start', ...args.slice(1)] : args;
  return spawnSync('wezterm', withGuard, { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS });
}

module.exports = { weztermCli };
