'use strict';
// worker-env.js — ワーカー起動時に注入する環境変数を組み立てる唯一の関数
//
// ワーカー識別（GH_MAESTRO_WORKER / GH_MAESTRO_WORKSPACE）は、初回起動（spawn-worker.js）と
// resume配送（inbox-supervisor.js）の両方で注入される。これらは同じ値でなければならず、
// 片方だけにしか入らないと、resume後のワーカーが自分を識別できず msg-send.js を誤用する。
//
// GH_MAESTRO_BASE_BRANCH も同じ原則に従う。PR作成時（gh-create-pr.js）のベースブランチは
// git upstream tracking ではなくこの環境変数から解決する（Issue #269）。upstream はコーダーの
// 標準的な `git push -u` で自ブランチへ書き換わるため、これに依存するとPR作成が壊れる。
// baseブランチはワーカーごとに異なる値であり、初回起動とresumeで同じ値が注入されなければ
// ならない。呼び出し元は workers.json のワーカーレコード（baseBranch）から渡すこと。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

/**
 * ワーカー起動時に注入する環境変数を組み立てる。
 *
 * @param {object} params
 * @param {string} params.workerName - ワーカー識別名（workers.json のキー）
 * @param {string} params.workspace  - ワークスペースのルートパス
 * @param {string} [params.baseBranch] - PRのベースブランチ名。未指定（null/undefined/空文字）なら
 *   GH_MAESTRO_BASE_BRANCH を注入しない（gh-create-pr.js はフェイルクローズする）。
 * @returns {object} launchAgentHeadless の env へ渡す環境変数オブジェクト
 */
function buildWorkerEnv({ workerName, workspace, baseBranch }) {
  const env = {
    GH_MAESTRO_WORKER: workerName,
    GH_MAESTRO_WORKSPACE: workspace,
  };
  if (baseBranch) {
    env.GH_MAESTRO_BASE_BRANCH = baseBranch;
  }
  return env;
}

module.exports = { buildWorkerEnv };
