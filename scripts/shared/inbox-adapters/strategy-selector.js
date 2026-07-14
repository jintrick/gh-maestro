'use strict';
// strategy-selector.js
// エージェントの能力宣言から、使うべき inbox 配送戦略を機械的に決定する。
//
// 選択ロジックは決定的で、人間の判断を介さない。
// 新しいエージェントを追加する際も、能力さえ正しく宣言すれば
// 自動的に正しい戦略が選ばれる。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

// ── 戦略定数 ──────────────────────────────────────────────────────────────

/**
 * inbox 配送戦略の識別子。
 *
 * - MONITOR:        非同期通知（Monitor ツール等）を持つエージェント向け。
 *                   常時バックグラウンドで新着を検知できる。
 * - SESSION_RESUME: 非同期通知は持たないがセッション再開可能なエージェント向け。
 *                   定期的にセッションを起こして新着を確認する。
 */
const STRATEGY = Object.freeze({
  MONITOR: 'monitor',
  SESSION_RESUME: 'session-resume',
});

// ── 選択ロジック ──────────────────────────────────────────────────────────

/**
 * エージェントの能力宣言から、使うべき inbox 配送戦略を決定する。
 *
 * 選択ルール:
 *   1. asynchronousNotification: true → "monitor"
 *   2. asynchronousNotification: false かつ sessionResume: true → "session-resume"
 *   3. どちらも false（または宣言がない）→ エラー（fail-closed）
 *
 * 能力宣言が欠落または不正な場合もエラーとする。
 * `.claude/rules/fail-closed-safety-guards.md` の方針に従い、
 * 推測・フォールバックは行わない。
 *
 * @param {object} agentConfig - エージェント設定。
 *   asynchronousNotification (boolean) と sessionResume (boolean) を含むこと。
 * @returns {string} STRATEGY 定数のいずれか
 * @throws {Error} 能力宣言が不完全・不正な場合、または対応する戦略がない場合
 */
function selectStrategy(agentConfig) {
  if (!agentConfig || typeof agentConfig !== 'object') {
    throw new Error(
      'agentConfig はオブジェクトである必要があります。' +
      '能力宣言（asynchronousNotification / sessionResume）が確認できません。'
    );
  }

  const label = agentConfig.id ? `"${agentConfig.id}"` : '(idなし)';

  // 能力宣言の存在と型を検証
  if (typeof agentConfig.asynchronousNotification !== 'boolean') {
    throw new Error(
      `エージェント ${label} の能力宣言が不完全です: ` +
      `asynchronousNotification が boolean で宣言されていません（実際: ${typeof agentConfig.asynchronousNotification}）。` +
      '能力宣言がないエージェントには配送戦略を割り当てられません。'
    );
  }

  if (typeof agentConfig.sessionResume !== 'boolean') {
    throw new Error(
      `エージェント ${label} の能力宣言が不完全です: ` +
      `sessionResume が boolean で宣言されていません（実際: ${typeof agentConfig.sessionResume}）。` +
      '能力宣言がないエージェントには配送戦略を割り当てられません。'
    );
  }

  // ルール1: 非同期通知あり → monitor
  if (agentConfig.asynchronousNotification) {
    return STRATEGY.MONITOR;
  }

  // ルール2: 非同期通知なし、セッション再開あり → session-resume
  if (agentConfig.sessionResume) {
    return STRATEGY.SESSION_RESUME;
  }

  // ルール3: どちらも false → 対応する戦略なし
  throw new Error(
    `エージェント ${label} に対応する inbox 配送戦略がありません ` +
    '(asynchronousNotification=false, sessionResume=false)。' +
    '少なくともどちらかの能力が true である必要があります。'
  );
}

module.exports = { STRATEGY, selectStrategy };
