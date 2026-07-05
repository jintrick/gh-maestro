'use strict';
// wezterm-cli.js — WezTerm CLI の共有ランナー
//
// WEZTERM_MOCK env があればモックスクリプトを使い（テスト用）、
// なければ実 wezterm バイナリを呼ぶ。
// queue-poller.js（mux 到達性チェック）と pane-notify.js（通知送信）の
// 両方から使われる。

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
  return mock
    ? spawnSync(process.execPath, [mock, ...args], { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS })
    : spawnSync('wezterm', args, { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS });
}

module.exports = { weztermCli };
