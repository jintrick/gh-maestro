'use strict';
// Path-safety validation shared across queue and msg-bus layers.
//
// Extracted from scripts/queue.js (validateField) so that msg-poll.js and
// future consumers can validate user-supplied names before using them as
// filesystem path components.
//
// Characters that are not allowed in path-component names.
// These would allow path traversal (..) or path separator injection.
const INVALID_FIELD_RE = /[\/\\:*?"<>|\x00-\x1f]/;
const PARENT_REF_RE = /(?:^|[\/\\])\.\.(?:$|[\/\\])/;

/**
 * Validate a field value for path-safety.
 *
 * Falsy values (empty string, undefined, null) pass through without error.
 * Callers are responsible for checking required fields separately
 * (matching the existing queue.js convention).
 *
 * Throws if the value contains path separators, `..`, or other unsafe chars.
 *
 * @param {string} name   Human-readable field name for the error message.
 * @param {string} value  The value to validate.
 */
function validateField(name, value) {
  if (!value) return;
  if (PARENT_REF_RE.test(value)) {
    throw new Error(`"${name}" に親ディレクトリ参照（..）は許可されません: ${JSON.stringify(value)}`);
  }
  if (INVALID_FIELD_RE.test(value)) {
    throw new Error(`"${name}" に不正な文字が含まれています: ${JSON.stringify(value)}`);
  }
}

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

module.exports = { validateField, isPlainObject, INVALID_FIELD_RE, PARENT_REF_RE };
