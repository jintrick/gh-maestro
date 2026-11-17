'use strict';
// strip-ansi.js — 文字列から ANSI SGR エスケープシーケンスを取り除く共有ヘルパー。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外。

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * 文字列から ANSI SGR エスケープシーケンス（`\x1b[...m`）を除去する。
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
function stripAnsi(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(ANSI_SGR_RE, '');
}

module.exports = {
  stripAnsi,
};
