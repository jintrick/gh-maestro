#!/usr/bin/env node
'use strict';
// resident-parent-death.js
// dead-man's switch が親セッションの死を検出したとき、常駐プロセスが終了前に
// 実行する共通処理。
//
// 呼び出し元（msg-poll.js / inbox-supervisor.js）は、scanOnce / runOnce 内で
// checkParent() が false を返したとき次の順で処理する:
//   1. lifecycleCleanup(workspace)           — PID registry からの解除
//   2. handleParentSessionDeath(...)          — role lease 解放 + stderr に理由出力
//   3. process.exit(PARENT_DEATH_EXIT_CODE)   — 非ゼロで終了（Monitor 異常終了アラーム経路）
//
// exit は呼び出し元が行う（終了コードを呼び出し元が指定するため、この関数は exit を呼ばない）。

const { releaseResidentLease } = require('./worker-lease');

/**
 * 親セッションの死を検出した常駐プロセスの終了前処理。
 *
 * role lease を best-effort で解放し（例外は捕捉して throw しない）、終了理由を
 * stderr に出力する。lease を解放しないまま exit すると stale lease が残り、次の起動が
 * --force なしでは拒否されるため、終了コード指定より先に必ず呼ぶ。
 *
 * @param {object} params
 * @param {string} params.workspace
 * @param {string} params.scriptName この常駐プロセスのスクリプト名（stderr 理由文用）
 * @param {string} params.role       このプロセスが保持する role lease 名
 * @param {number} params.sessionPid 監視していた親セッションのPID
 */
function handleParentSessionDeath({ workspace, scriptName, role, sessionPid }) {
  try {
    releaseResidentLease({ workspace, role, pid: process.pid });
  } catch (e) {
    // lease 解放は best-effort。失敗しても終了を妨げない（残った stale lease は
    // 次の起動の stale 回収で処理される）。
    process.stderr.write(`${scriptName}: role lease (${role}) の解放に失敗しました: ${e.message}\n`);
  }
  process.stderr.write(`${scriptName}: parent session (pid ${sessionPid}) is dead — exiting\n`);
}

module.exports = { handleParentSessionDeath };
