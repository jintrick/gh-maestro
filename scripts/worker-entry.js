'use strict';
// workers.json のエントリを正規化する。
//
// 新形式: { paneId, agentId }。agentId はエージェントごとに異なる挙動
// （例: sendEnter のterminator選択）を後段で切り替えられるようにするための情報。
// 旧形式（pane_id文字列のみ）で書かれた既存の workers.json とも後方互換に読める。

function normalizeWorkerEntry(v) {
  if (v && typeof v === 'object') {
    return { paneId: v.paneId != null ? String(v.paneId) : null, agentId: v.agentId ?? null };
  }
  return { paneId: v != null ? String(v) : null, agentId: null };
}

module.exports = { normalizeWorkerEntry };
