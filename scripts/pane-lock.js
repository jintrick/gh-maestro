'use strict';
// 同一paneへの並行送信を直列化するためのファイルロック。
//
// send-pane.js は「本文」→「Enter」の2回の wezterm cli send-text 呼び出しに分かれている。
// 同じpaneへ複数プロセス（例: 並列で動く複数ワーカーのpoll-and-notify.jsが同時に
// orchestratorへ報告する）が同時に送ると、各プロセスの本文/Enter呼び出しが入れ替わり、
// メッセージが結合された状態でcomposerに残り、送信（Enter）が効かなくなることを実機で
// 確認した。paneId単位でロックし、送信の2呼び出しをアトミックな単位として直列化する。

const fs = require('fs');
const path = require('path');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// lockDirにロックファイルを作り、fnを排他実行してから削除する。
// 保持プロセスがクラッシュして残ったロックはtimeoutMs経過後に奪う。
function withPaneLock(lockDir, key, timeoutMs, fn) {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `send-pane-${key}.lock`);
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

module.exports = { withPaneLock };
