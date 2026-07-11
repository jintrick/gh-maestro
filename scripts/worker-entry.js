'use strict';
// workers.json のエントリを正規化・構築する。
//
// 新形式: { paneId, agentId, issue, notifierPid }。agentId はエージェントごとに異なる挙動
// （例: sendEnter のterminator選択）を後段で切り替えられるようにするための情報。
// issue はワーカーのアンカーIssue番号。notifierPid はレガシー後方互換用（後述）。
// 旧形式（pane_id文字列のみ）で書かれた既存の workers.json とも後方互換に読める。
//
// spawn-worker.js が新規ワーカーを登録する際も、この関数に候補値を渡して
// 正規化済みエントリを構築する（生成用の別関数を持たず、正規化ロジックを一本化する）。

function normalizeWorkerEntry(v) {
  if (v && typeof v === 'object') {
    return {
      paneId: v.paneId != null ? String(v.paneId) : null,
      agentId: v.agentId ?? null,
      issue: v.issue != null ? Number(v.issue) : null,
      notifierPid: v.notifierPid ?? null,
    };
  }
  return { paneId: v != null ? String(v) : null, agentId: null, issue: null, notifierPid: null };
}

module.exports = { normalizeWorkerEntry };
