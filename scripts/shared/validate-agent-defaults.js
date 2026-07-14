'use strict';
// validate-agent-defaults.js
// agent-defaults.json の各エージェント定義が備えるべきフィールドを検証する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

// ── フィールド定義（ここがSSOT） ────────────────────────────────────────────

/**
 * 全エージェント共通で必須のフィールドと期待される型。
 * 各エントリ: [fieldName, expectedType]
 *   expectedType: 'string' | 'boolean' | 'array' | 'number'
 */
const REQUIRED_FIELDS = [
  ['id', 'string'],
  ['label', 'string'],
  ['command', 'string'],
  ['runtime', 'string'],
  ['extraArgs', 'array'],
  ['promptDelivery', 'string'],
  ['enterSequence', 'string'],
  ['rulesSupported', 'boolean'],
  ['asynchronousNotification', 'boolean'],
  ['sessionResume', 'boolean'],
];

/**
 * 既知の promptDelivery 値。
 * buildAgentCommandArgs (agent-launch.js) の switch 分岐と同期させる。
 */
const KNOWN_PROMPT_DELIVERIES = [
  'system-prompt-file',
  'flag',
  'positional',
  'send-text-after-launch',
];

/**
 * promptDelivery の値に応じて追加で必須となるフィールド。
 * 各エントリ: [promptDelivery値, fieldName, expectedType]
 */
const CONDITIONAL_REQUIRED = [
  ['flag', 'promptFlag', 'string'],
];

/**
 * 特定のbooleanフィールドが true のときに追加で必須となるフィールド。
 * 各エントリ: [conditionField, conditionValue, requiredField, expectedType]
 */
const BOOLEAN_CONDITIONAL_REQUIRED = [
  ['sessionResume', true, 'resumeCommand', 'string'],
];

/**
 * 既知のオプショナルフィールド（必須ではないが、存在する場合の型チェック対象）。
 * 各エントリ: [fieldName, expectedType]
 */
const KNOWN_OPTIONAL_FIELDS = [
  ['dynamicCommand', 'boolean'],
  ['sendTextDelayMs', 'number'],
  ['skillsViaMd', 'boolean'],
  ['promptFlag', 'string'],
  ['execArgs', 'array'],
  ['resumeCommand', 'string'],
];

// ── ヘルパー ─────────────────────────────────────────────────────────────────

function getType(val) {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

/**
 * 配列の全要素が文字列か検証する。
 * @returns {string|null} エラー理由、または null
 */
function validateStringArray(arr, fieldName) {
  if (!Array.isArray(arr)) return null; // 型不一致は呼び出し元で検出
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string') {
      return `${fieldName}[${i}] は文字列である必要があります（実際: ${getType(arr[i])}）`;
    }
  }
  return null;
}

// ── 公開API ─────────────────────────────────────────────────────────────────

/**
 * 単一のエージェント定義を検証する。
 *
 * @param {object} agent  エージェント定義
 * @param {number} index  agents 配列内のインデックス（エラーメッセージ用）
 * @returns {string[]} エラー/警告メッセージの配列（空なら検証通過）
 */
function validateAgentEntry(agent, index) {
  const issues = [];
  const label = agent && agent.id ? `"${agent.id}"` : `index ${index}`;

  if (!agent || typeof agent !== 'object') {
    issues.push(`[ERROR] agents[${index}]: オブジェクトである必要があります（実際: ${getType(agent)}）`);
    return issues;
  }

  // ── 必須フィールドの存在と型チェック ──
  for (const [field, expectedType] of REQUIRED_FIELDS) {
    const val = agent[field];
    const actualType = getType(val);

    if (val === undefined || val === null) {
      issues.push(`[ERROR] ${label}: 必須フィールド "${field}" がありません`);
      continue;
    }

    if (actualType !== expectedType) {
      issues.push(`[ERROR] ${label}: "${field}" は ${expectedType} である必要があります（実際: ${actualType}）`);
      continue;
    }

    // 配列の場合は中身の文字列チェック
    if (expectedType === 'array') {
      const arrErr = validateStringArray(val, field);
      if (arrErr) issues.push(`[ERROR] ${label}: ${arrErr}`);
    }
  }

  // ── promptDelivery の値チェック ──
  if (typeof agent.promptDelivery === 'string' && !KNOWN_PROMPT_DELIVERIES.includes(agent.promptDelivery)) {
    issues.push(`[WARN] ${label}: promptDelivery "${agent.promptDelivery}" は未知の値です（既知: ${KNOWN_PROMPT_DELIVERIES.join(', ')}）`);
  }

  // ── 条件付き必須フィールド ──
  for (const [delivery, field, expectedType] of CONDITIONAL_REQUIRED) {
    if (agent.promptDelivery === delivery) {
      const val = agent[field];
      if (val === undefined || val === null) {
        issues.push(`[ERROR] ${label}: promptDelivery="${delivery}" のため "${field}" が必須ですが、設定されていません`);
      } else if (getType(val) !== expectedType) {
        issues.push(`[ERROR] ${label}: "${field}" は ${expectedType} である必要があります（実際: ${getType(val)}）`);
      }
    }
  }

  // ── boolean条件付き必須フィールド ──
  for (const [condField, condValue, requiredField, expectedType] of BOOLEAN_CONDITIONAL_REQUIRED) {
    if (agent[condField] === condValue) {
      const val = agent[requiredField];
      if (val === undefined || val === null) {
        issues.push(`[ERROR] ${label}: ${condField}=${condValue} のため "${requiredField}" が必須ですが、設定されていません`);
      } else if (getType(val) !== expectedType) {
        issues.push(`[ERROR] ${label}: "${requiredField}" は ${expectedType} である必要があります（実際: ${getType(val)}）`);
      }
    }
  }

  // ── 未知のトップレベルフィールドを警告 ──
  const knownFields = new Set([
    ...REQUIRED_FIELDS.map(([f]) => f),
    ...KNOWN_OPTIONAL_FIELDS.map(([f]) => f),
  ]);
  for (const key of Object.keys(agent)) {
    if (!knownFields.has(key)) {
      issues.push(`[WARN] ${label}: 未知のフィールド "${key}" があります`);
    }
  }

  // ── 既知のオプショナルフィールドの型チェック（存在する場合のみ） ──
  for (const [field, expectedType] of KNOWN_OPTIONAL_FIELDS) {
    if (field in agent && agent[field] !== null && agent[field] !== undefined) {
      const actualType = getType(agent[field]);
      if (actualType !== expectedType) {
        issues.push(`[ERROR] ${label}: "${field}" は ${expectedType} である必要があります（実際: ${actualType}）`);
      } else if (expectedType === 'array') {
        const arrErr = validateStringArray(agent[field], field);
        if (arrErr) issues.push(`[ERROR] ${label}: ${arrErr}`);
      }
    }
  }

  return issues;
}

/**
 * agent-defaults.json のデータ全体を検証する。
 *
 * @param {object} data  agent-defaults.json をパースしたオブジェクト
 * @returns {string[]} エラー/警告メッセージの配列（空なら検証通過）
 */
function validateAgentDefaults(data) {
  const issues = [];

  if (!data || typeof data !== 'object') {
    return ['[ERROR] agent-defaults.json: オブジェクトである必要があります'];
  }

  if (!Array.isArray(data.agents)) {
    return ['[ERROR] agent-defaults.json: "agents" は配列である必要があります'];
  }

  // 重複 id チェック
  const seenIds = new Set();
  for (const agent of data.agents) {
    if (agent && typeof agent.id === 'string') {
      if (seenIds.has(agent.id)) {
        issues.push(`[ERROR] agent-defaults.json: エージェントID "${agent.id}" が重複しています`);
      }
      seenIds.add(agent.id);
    }
  }

  for (let i = 0; i < data.agents.length; i++) {
    issues.push(...validateAgentEntry(data.agents[i], i));
  }

  return issues;
}

module.exports = { validateAgentEntry, validateAgentDefaults, REQUIRED_FIELDS, KNOWN_OPTIONAL_FIELDS, CONDITIONAL_REQUIRED, BOOLEAN_CONDITIONAL_REQUIRED, KNOWN_PROMPT_DELIVERIES };
