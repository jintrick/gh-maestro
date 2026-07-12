'use strict';
// 共有: ファイル経由またはインライン文字列でテキストを受け取る処理
//
// msg-send.js（--body-file）・create-issue.js（--body-file）・
// start-review-manager.js/run-review-manager.js（--brief-file）に
// 個別実装されていたファイル読み込みロジックを1箇所に集約する。
//
// 両方の入力源が同時に指定された場合の扱い（エラーにするか、どちらかを
// 優先するか）は呼び出し元ごとに異なるため、ここでは判断しない。
// 呼び出し元が事前にチェックしてから渡すこと。

const fs = require('fs');

/**
 * filePath があればその内容を読み込んで返す（filePath を優先）。
 * filePath がなければ inlineValue を返す。どちらも未指定なら null を返す。
 *
 * @param {{ inlineValue?: string|null, filePath?: string|null }} options
 * @returns {string|null}
 */
function resolveTextInput({ inlineValue = null, filePath = null } = {}) {
  if (filePath != null) {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (inlineValue != null) {
    return inlineValue;
  }
  return null;
}

module.exports = { resolveTextInput };
