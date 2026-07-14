'use strict';
// adapter-base.js
// InboxAdapter のインターフェース定義（JSDoc）と検証ヘルパー。
//
// このモジュールは抽象インターフェースの「契約」を定義する。
// 具象Adapterはこのインターフェースを満たすことを期待されるが、
// 実行時の型チェックは行わない（ダックタイピング）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

// ── JSDoc 型定義（ドキュメント用） ─────────────────────────────────────────

/**
 * @typedef {object} AgentCapabilities
 * @property {boolean} asynchronousNotification - バックグラウンドで非同期通知を受け取れるか
 * @property {boolean} sessionResume               - 中断したセッションを再開できるか
 */

/**
 * @typedef {object} StartOptions
 * @property {string} skill         - スキル名
 * @property {string} promptFile       - プロンプトファイルの絶対パス
 * @property {string} shortPrompt      - 短縮プロンプト（flag/positional配送用）
 * @property {string} systemPromptText - システムプロンプトテキスト（system-prompt-file 配送用）
 * @property {object} [contextVars]    - コンテキスト変数（WORKER_NAME, ISSUE 等）
 */

/**
 * @typedef {object} StartResult
 * @property {string} command - 実行コマンド
 * @property {string[]} args  - コマンド引数
 */

/**
 * @typedef {object} ResumeResult
 * @property {string} command - 実行コマンド
 * @property {string[]} args  - コマンド引数（--continue 等の再開フラグを含む）
 */

/**
 * @typedef {object} DeliverResult
 * @property {string} type   - 配送戦略の種類（"monitor" | "session-resume"）
 * @property {string} prompt - エージェントに与える配送手順のプロンプト文
 */

/**
 * @typedef {object} StopResult
 * @property {string} action      - 停止アクションの種類（"exit" | "kill-pane" 等）
 * @property {string} description - 人間向け説明
 */

/**
 * @typedef {object} Message
 * @property {string} from - 送信者
 * @property {string} body - メッセージ本文
 */

// ── 必須メソッド一覧 ───────────────────────────────────────────────────────

/**
 * Adapter が実装すべきメソッド名のリスト。
 * テスト等でインターフェース準拠を検証する際のリファレンスとして使用する。
 */
const ADAPTER_METHODS = [
  'getCapabilities',
  'start',
  'resume',
  'deliverMessage',
  'stop',
];

// ── 検証ヘルパー ────────────────────────────────────────────────────────────

/**
 * Adapter オブジェクトが必須メソッドをすべて持っているか検証する。
 * 存在しないメソッド名の配列を返す（空なら検証通過）。
 *
 * @param {object} adapter
 * @returns {string[]} 欠落しているメソッド名の配列
 */
function validateAdapterMethods(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    return [...ADAPTER_METHODS];
  }
  const missing = [];
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      missing.push(method);
    }
  }
  return missing;
}

/**
 * Adapter が有効かどうか（全必須メソッドを持つか）を真偽で返す。
 *
 * @param {object} adapter
 * @returns {boolean}
 */
function isValidAdapter(adapter) {
  return validateAdapterMethods(adapter).length === 0;
}

// ── 配送プロンプト整形（共通） ────────────────────────────────────────────

/**
 * 新着メッセージをそのまま提示する、Adapter非依存のプロンプト文を生成する。
 * Monitor等の非同期通知手段を持たないエージェント（session-resume戦略）と、
 * 稼働中エージェントへの直接配送の両方で共通して使う。
 *
 * 外部由来の改行は \r\n 対応で分割する（inbox-adapter-crlf-handling ルール準拠）。
 *
 * @param {import('./adapter-base').Message} message
 * @returns {string}
 */
function formatPlainInboxPrompt(message) {
  const lines = [
    '',
    '[gh-maestro inbox] 新着メッセージを受信しました。',
    `From: ${message.from || '(unknown)'}`,
    '',
  ];

  if (message.body) {
    const quoted = message.body.split(/\r?\n/).map(line => `> ${line}`).join('\n');
    lines.push(quoted);
    lines.push('');
  }

  lines.push('このメッセージを処理してください。返信には msg-send.js を使用します。');
  lines.push('処理後は直ちに待機状態に戻り、追加の指示を待ってください。');
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  ADAPTER_METHODS,
  validateAdapterMethods,
  isValidAdapter,
  formatPlainInboxPrompt,
};
