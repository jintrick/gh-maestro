'use strict';
// kill-tree.js
// pid とその子孫プロセスをまとめて終了する。
// Windows は親子関係を辿らない SIGTERM 相当（process.kill）では子孫が孤児化するため
// taskkill /T を使う。Unix は detached spawn によるプロセスグループを前提に
// 負のpidでグループ全体へ送る。

const { spawnSync } = require('./child-process');

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* プロセスグループ無し等 */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* 既に終了済み */ }
}

module.exports = { killProcessTree };
