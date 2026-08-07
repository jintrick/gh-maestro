'use strict';
// json-schema.js — 簡易JSON Schema検証ヘルパーの共有化
//
// finalize-review.js と run-review-manager.js に独立実装されていた _validateAgainstSchema
// （同一実装の複製）を1箇所に集約する。レビューfindings・council成果物等、
// このプロジェクト内のスキーマファイル（review-findings-schema.json 等）の検証に使う。
//
// 完全なJSON Schema実装ではない。追加のスキーマキーワード（type/required/
// additionalProperties/properties/items/minItems/minLength/enum/minimum）に対応する場合は、
// 両方の利用元を横並びで確認した上でここに追記する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

/**
 * 簡易JSON Schema検証。
 * additionalProperties: false、required、type、enum、minItems、minLength、minimum をサポート。
 * 完全なJSON Schema実装ではないが、review-findings-schema.jsonの検証には十分。
 *
 * @param {*} value
 * @param {object} schema
 * @param {string} path_
 * @returns {string[]}
 */
function _validateAgainstSchema(value, schema, path_ = '') {
  const errors = [];

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path_}: expected object`);
      return errors;
    }
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in value)) errors.push(`${path_}: missing required '${field}'`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${path_}: unexpected field '${key}'`);
      }
    }
    if (schema.properties) {
      for (const [key, ps] of Object.entries(schema.properties)) {
        if (key in value) {
          errors.push(..._validateAgainstSchema(value[key], ps, path_ ? `${path_}.${key}` : key));
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path_}: expected array`);
      return errors;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path_}: expected >= ${schema.minItems} items`);
    }
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < value.length; i++) {
        errors.push(..._validateAgainstSchema(value[i], schema.items, `${path_}[${i}]`));
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path_}: expected string`);
    else if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path_}: string too short (min ${schema.minLength})`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path_}: invalid enum value '${value}'`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path_}: expected integer`);
    else if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path_}: below minimum ${schema.minimum}`);
    }
  }

  return errors;
}

module.exports = { _validateAgainstSchema };
