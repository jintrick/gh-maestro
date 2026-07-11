'use strict';
// 汎用の型判定ヘルパー。特定ドメイン（path-safety検証等）に紐づかない
// 共有ユーティリティはここに置く（scripts/shared/validate.js は path-safety 専用）。

/**
 * Check if a value is a plain object (not null, not array).
 * Unified replacement for repeated `typeof x === 'object' && x !== null && !Array.isArray(x)`.
 *
 * @param {*} x
 * @returns {boolean}
 */
function isPlainObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

module.exports = { isPlainObject };
