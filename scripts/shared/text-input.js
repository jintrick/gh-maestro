'use strict';
// 共有: ファイル経由・標準入力・インライン文字列のいずれかでテキストを受け取る処理
//
// msg-send.js（--body-file / --stdin）・write-draft.js（--stdin）・create-issue.js
// （--body-file）・start-review-manager.js/run-review-manager.js（--brief-file）に
// 個別実装／重複実装されがちなファイル読み込み・標準入力読み込みロジックを1箇所に集約する
// （write-draft.jsが独自に持っていたreadStdin()+TTYガードをここへ統合したもの）。
//
// 複数の入力源が同時に指定された場合の扱い（エラーにするか、どちらかを優先するか）は
// 呼び出し元ごとに異なるため、ここでは判断しない。呼び出し元が事前にチェックしてから渡すこと。
// 優先順位: filePath > stdin > inlineValue。

const fs = require('fs');

function defaultReadStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** stdin指定時に標準入力がTTYだった場合に投げる（呼び出し元でcatchしてUsageエラーに変換する）。 */
class StdinTTYError extends Error {}

/**
 * filePath があればその内容を読み込んで返す（最優先）。
 * stdin が true なら標準入力から読み込む（TTYならStdinTTYErrorを投げ、ハングを防ぐ）。
 * どちらも無ければ inlineValue を返す。すべて未指定なら null を返す。
 *
 * @param {{ inlineValue?: string|null, filePath?: string|null, stdin?: boolean,
 *   readStdinFn?: () => string, isStdinTTY?: () => boolean }} options
 * @returns {string|null}
 * @throws {StdinTTYError} stdin指定時に標準入力がTTYの場合
 */
function resolveTextInput({
  inlineValue = null,
  filePath = null,
  stdin = false,
  readStdinFn = defaultReadStdin,
  isStdinTTY = () => process.stdin.isTTY,
} = {}) {
  if (filePath != null) {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (stdin) {
    if (isStdinTTY()) {
      throw new StdinTTYError('標準入力がTTYです。パイプまたはheredocで内容を渡してください。');
    }
    return readStdinFn();
  }
  if (inlineValue != null) {
    return inlineValue;
  }
  return null;
}

module.exports = { resolveTextInput, StdinTTYError };
