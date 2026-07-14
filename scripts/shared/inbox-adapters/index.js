'use strict';
// inbox-adapters/index.js
// InboxAdapter 統合API。
//
// このモジュールは以下を提供する:
//   - selectStrategy(agentConfig) → 能力宣言から戦略を選択
//   - resolveAdapter(agentConfig) → 戦略に応じた Adapter インスタンスを返す
//   - Adapter インターフェース（adapter-base.js）の再エクスポート
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { createClaudeAdapter } = require('./claude-adapter');
const { selectStrategy, STRATEGY } = require('./strategy-selector');

// ── Adapter 解決 ──────────────────────────────────────────────────────────

/**
 * エージェント設定から、そのエージェントに適した InboxAdapter を解決して返す。
 *
 * 内部で selectStrategy() を呼び出し、戦略に対応する Adapter 実装を返す。
 * 現時点で実装済みなのは "monitor" 戦略（claude 系）のみ。
 * "session-resume" 戦略に対応する Adapter は Issue D で実装予定。
 *
 * @param {object} agentConfig - resolveAgentConfig() で解決済みのエージェント設定
 * @returns {object} InboxAdapter インターフェースを満たすオブジェクト
 * @throws {Error} 戦略が未実装の場合、または能力宣言が不完全な場合
 */
function resolveAdapter(agentConfig) {
  const strategy = selectStrategy(agentConfig);

  switch (strategy) {
    case STRATEGY.MONITOR:
      return createClaudeAdapter(agentConfig);

    case STRATEGY.SESSION_RESUME:
      throw new Error(
        `エージェント "${agentConfig.id || '(idなし)'}" は ` +
        '"session-resume" 戦略に分類されましたが、この戦略に対応する ' +
        'Adapter 実装はまだ提供されていません（Issue D で実装予定）。'
      );

    default:
      throw new Error(
        `不明な inbox 配送戦略です: "${strategy}"`
      );
  }
}

module.exports = {
  // 戦略選択
  selectStrategy,
  STRATEGY,

  // Adapter 解決
  resolveAdapter,

  // Adapter ファクトリ（テスト用）
  createClaudeAdapter,

  // インターフェース検証（adapter-base.js の再エクスポート）
  ...require('./adapter-base'),
};
