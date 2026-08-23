'use strict';
// worker-env.js — ワーカー起動時に注入する環境変数を組み立てる唯一の関数
//
// ワーカー識別（GH_MAESTRO_WORKER / GH_MAESTRO_WORKSPACE）は、初回起動（spawn-worker.js）と
// resume配送（worker-supervisor.js）の両方で注入される。これらは同じ値でなければならず、
// 片方だけにしか入らないと、resume後のワーカーが自分を識別できず msg-send.js を誤用する。
//
// GH_MAESTRO_BASE_BRANCH も同じ原則に従う。PR作成時（gh-create-pr.js）のベースブランチは
// git upstream tracking ではなくこの環境変数から解決する（Issue #269）。upstream はコーダーの
// 標準的な `git push -u` で自ブランチへ書き換わるため、これに依存するとPR作成が壊れる。
// baseブランチはワーカーごとに異なる値であり、初回起動とresumeで同じ値が注入されなければ
// ならない。呼び出し元は workers.json のワーカーレコード（baseBranch）から渡すこと。
//
// 重要: 起動環境は launchAgentHeadless が `{ ...process.env, ...launchEnv }` として構築するため、
// この返り値から「キーを省く」だけでは、親プロセスから継承した値（例: 報告のために msg-send.js
// を呼んだワーカーの値が、その子として起動される worker-supervisor 経由で混入する）を消せない。
// そこで baseBranch 未指定時は明示的に空文字で上書きし、後段の gh-create-pr.js が
// フェイルクローズするようにする（起動境界での除去 = マージ入力に含めることで除去を実現）。
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
 *   GH_MAESTRO_BASE_BRANCH を空文字で上書きする（親envから継承した値を消し、
 *   gh-create-pr.js をフェイルクローズさせる）。
 * @returns {object} launchAgentHeadless の env へ渡す環境変数オブジェクト
 */
function buildWorkerEnv({ workerName, workspace, baseBranch }) {
  const env = {
    GH_MAESTRO_WORKER: workerName,
    GH_MAESTRO_WORKSPACE: workspace,
    // 常にキーを置く（値は baseBranch または空文字）。キーを省略すると
    // `{ ...process.env, ...env }` のマージで親の値が残り、base を持たないワーカーが
    // 無関係なブランチを base にPRを作りかねない（Issue #269 レビュー指摘）。
    GH_MAESTRO_BASE_BRANCH: baseBranch || '',
  };
  return env;
}

module.exports = { buildWorkerEnv };
