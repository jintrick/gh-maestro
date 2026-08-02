'use strict';
// 実プロセス（サブプロセス）を起動するテストのための共通環境ヘルパー。
//
// ワーカー起動コンテキスト（GH_MAESTRO_WORKER / GH_MAESTRO_WORKSPACE 等が注入された状態）で
// npm test を実行すると、spawn した子プロセスがこれらの環境変数を継承し、msg-send.js が
// 実ワークスペース・実Issueを解決して本物のGitHub Issueへ投稿する事故が起きる
// （実障害: worker-exit-hook.js の実spawnテストが偽の異常終了通知を投稿した、Issue #202）。
// 実spawnを行うテストは必ずこの関数の戻り値を spawnSync 等の env に渡し、
// ワーカー文脈の環境変数を子プロセスから除去する。
//
// テスト側の適用漏れに依存しない多層防御として、msg-send.js 本体にも NODE_TEST_CONTEXT
// 検出ガードがある（scripts/msg-send.js の testContextPostBlockReason 参照）。

const WORKER_CONTEXT_ENV_VARS = [
  'GH_MAESTRO_WORKSPACE', // resolveWorkspace が --workspace 引数より優先する（実ワークスペース解決の要）
  'GH_MAESTRO_WORKER',    // msg-send.js が「ワーカー扱い」にし、worker-exit-hook.js の通知分岐を発火させる要
  'GH_MAESTRO_ISSUE',     // 将来のIssue番号注入用（予約）
  'ISSUE',                // msg-send.js が --issue 未指定時のフォールバックに使う
];

/**
 * ワーカー文脈の環境変数を除去した env を返す。
 *
 * GH_MAESTRO_RUNTIME_DIR は除去しない（tests/_env-setup.js が設定するテスト隔離用の
 * 一時runtime rootであり、除去するとサブプロセスが実 runtime root を汚染する）。
 *
 * @returns {Record<string, string|undefined>}
 */
function cleanSpawnEnv() {
  const env = { ...process.env };
  for (const key of WORKER_CONTEXT_ENV_VARS) {
    delete env[key];
  }
  return env;
}

module.exports = { cleanSpawnEnv };
