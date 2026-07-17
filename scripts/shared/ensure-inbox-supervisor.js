'use strict';
// ensure-inbox-supervisor.js
//
// inbox-supervisor.js（セッション再開系ワーカーへの配送を担う常駐プロセス）が
// 稼働していなければ、detachedプロセスとして自動起動する。
//
// 背景: 従来はorchestrator（LLMエージェント）がSKILL.mdの指示を読んで自分でBashツールを
// 呼び出し手動起動する設計だった。これは「起動を怠ると配送が一切行われない」という
// 決定的でない（エージェントの記憶に依存する）弱点があり、実際に起動されないまま
// ワーカーへの追加指示が永久に届かない実障害が発生した。この関数を
// spawn-worker.js（ワーカー作成時）とmsg-send.js（ワーカー宛て送信時）の両方から
// 呼ぶことで、エージェントの記憶に頼らず決定的に起動を保証する。
//
// inbox-supervisor.js自身がstartup時に多重起動防止のロックを持つため
// （acquireStartupLock、scripts/process-lifecycle.js）、ここでは事前チェックをせず
// 常にspawnを試みてよい。既に稼働中ならinbox-supervisor.js自身のロックが検知して
// 即exitするため、二重起動にはならない。この関数はbest-effortのfire-and-forgetであり、
// 起動の成否を待たず・呼び出し元をブロックしない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('../child-process');

let _spawn = (cmd, args, opts) => spawn(cmd, args, opts);

/**
 * inbox-supervisor.js が稼働していなければ、detachedプロセスとして自動起動を試みる。
 * best-effort。失敗しても例外を投げず、呼び出し元の処理を継続させる。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - inbox-supervisor.js が置かれているディレクトリ
 */
function ensureInboxSupervisorRunning({ workspace, scriptsPath }) {
  if (!workspace || !scriptsPath) return;
  let logFd;
  try {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    logFd = fs.openSync(path.join(ghDir, 'inbox-supervisor-autostart.log'), 'a');
    const child = _spawn(process.execPath, [
      path.join(scriptsPath, 'inbox-supervisor.js'),
      '--workspace', workspace,
    ], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best-effort起動なので失敗しても呼び出し元の処理は継続する
  } finally {
    if (logFd !== undefined) {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

module.exports = {
  ensureInboxSupervisorRunning,
  _setSpawn: (fn) => { _spawn = fn; },
};
