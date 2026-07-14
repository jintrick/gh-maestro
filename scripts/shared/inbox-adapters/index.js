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
const { createSessionResumeAdapter } = require('./session-resume-adapter');
const { selectStrategy, STRATEGY } = require('./strategy-selector');

// ── Adapter 解決 ──────────────────────────────────────────────────────────

/**
 * エージェント設定から、そのエージェントに適した InboxAdapter を解決して返す。
 *
 * 内部で selectStrategy() を呼び出し、戦略に対応する Adapter 実装を返す。
 * "monitor" 戦略（claude 系）と "session-resume" 戦略（agy / codex / reasonix 系）の
 * 両方に対応している。
 *
 * @param {object} agentConfig - resolveAgentConfig() で解決済みのエージェント設定
 * @returns {object} InboxAdapter インターフェースを満たすオブジェクト
 * @throws {Error} 戦略が不明な場合、または能力宣言が不完全な場合
 */
function resolveAdapter(agentConfig) {
  const strategy = selectStrategy(agentConfig);

  switch (strategy) {
    case STRATEGY.MONITOR:
      return createClaudeAdapter(agentConfig);

    case STRATEGY.SESSION_RESUME:
      return createSessionResumeAdapter(agentConfig);

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
  createSessionResumeAdapter,

  // インターフェース検証（adapter-base.js の再エクスポート）
  ...require('./adapter-base'),
};
