'use strict';
// child_process ラッパー
// Windows では spawn / spawnSync / execSync に自動的に windowsHide: true を注入する。
// これにより子プロセス生成時のコンソールウィンドウポップアップを防止する。

const { spawn: _spawn, spawnSync: _spawnSync, execSync: _execSync } = require('child_process');

const injectHide = (opts) =>
  process.platform === 'win32' ? { windowsHide: true, ...opts } : opts;

const spawn    = (cmd, args, opts)  => _spawn(cmd, args, injectHide(opts));
const spawnSync = (cmd, args, opts) => _spawnSync(cmd, args, injectHide(opts));
const execSync  = (cmd, opts)       => _execSync(cmd, injectHide(opts));

module.exports = { spawn, spawnSync, execSync };
