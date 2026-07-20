#!/usr/bin/env node
'use strict';
// worker-exit-hook.js
// 全ワーカーの onExit フック（spawn-worker.js / inbox-supervisor.js が起動コマンド末尾に仕込む）。
// エージェントプロセスが終了した直後に、その終了コードを引数末尾に付けて呼ばれる。
//   1. execution-id 付き（architect 等）なら executions.json に終了を記録する
//   2. 非ゼロ終了なら orchestrator へ「異常終了」を通知する（サイレント失敗を潰す）
//
// このフックは GH_MAESTRO_WORKER 環境変数のワーカーコンテキストで走るため、msg-send.js は
// 自動的に from=ワーカー / to=orchestrator として投稿する（成りすまし・宛先誤りは起きない）。
//
// Usage (フック側が仕込む固定形): node worker-exit-hook.js <workspace> <execution-id|""> <exit-code>

const path = require('path');
const { spawnSync } = require('child_process');

const [workspace, executionId, exitCodeRaw] = process.argv.slice(2);
const exitCode = parseInt(exitCodeRaw, 10);
const workerName = process.env.GH_MAESTRO_WORKER || null;

// 1. execution 記録（--execution-id 付きの起動のときだけ）
if (workspace && executionId) {
  try {
    const { markProcessExit } = require('./shared/execution-registry');
    markProcessExit(workspace, executionId, exitCodeRaw);
  } catch (error) {
    process.stderr.write(`worker-exit-hook: execution 記録失敗: ${error.message}\n`);
  }
}

// 2. 非ゼロ終了は orchestrator へ通知する。正常終了（exit 0。セッション再開系ワーカーの
//    1ターン完了を含む）は通知しない。
if (Number.isFinite(exitCode) && exitCode !== 0 && workerName && workspace) {
  const body = `⚠️ 起動失敗または異常終了: exit code ${exitCode}。このワーカーのプロセスが正常に完了せず終了しました（起動時のエラーの可能性）。`;
  const r = spawnSync(process.execPath, [
    path.join(__dirname, 'msg-send.js'),
    body,
    '--workspace', workspace,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`worker-exit-hook: 異常終了通知の投稿に失敗: ${(r.stderr || '').trim()}\n`);
  }
}
