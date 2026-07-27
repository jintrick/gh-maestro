'use strict';
// inbox-adapters/index.js
// InboxAdapter 統合API。
//
// このモジュールは以下を提供する:
//   - resolveAdapter(agentConfig) → エージェント設定から Adapter インスタンスを返す
//   - Adapter インターフェース（adapter-base.js）の再エクスポート
//
// かつては能力宣言（asynchronousNotification / sessionResume）から2つの配送戦略
// （"monitor" / "session-resume"）を選ぶ strategy-selector.js が存在した。しかし
// 全エージェントが session-resume 側に固定され、"monitor" 戦略に該当するエージェントは
// 1つも実在しなかったため、選択の余地が無い抽象として撤去した（保留#10/#11）。
// 将来ふたたび複数戦略が必要になったら、その時点で実在する2例目とともに再導入する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { createSessionResumeAdapter } = require('./session-resume-adapter');

/**
 * エージェント設定から InboxAdapter を解決して返す。
 *
 * 全エージェントはセッション再開方式（1回の作業ごとに自然終了し、次の指示は
 * `--continue` 等でセッションを再開して配送する）である。
 *
 * @param {object} agentConfig - resolveAgentConfig() で解決済みのエージェント設定
 * @returns {object} InboxAdapter インターフェースを満たすオブジェクト
 * @throws {Error} agentConfig が不正な場合
 */
function resolveAdapter(agentConfig) {
  return createSessionResumeAdapter(agentConfig);
}

module.exports = {
  // Adapter 解決
  resolveAdapter,

  // Adapter ファクトリ（テスト用）
  createSessionResumeAdapter,

  // インターフェース検証（adapter-base.js の再エクスポート）
  ...require('./adapter-base'),
};
