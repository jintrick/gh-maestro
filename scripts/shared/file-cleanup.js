'use strict';

const fs = require('fs');

// 外部操作成功後の入力ファイル削除は、リモート操作の成否と独立したbest-effort処理。
// 削除だけが失敗しても、リモート操作を失敗扱いにして再実行を誘発しない。

/**
 * 入力ファイルの削除を試み、失敗時は警告文を返す。
 *
 * @param {string} filePath
 * @param {(filePath: string) => void} [unlinkFn]
 * @returns {string|null} 削除失敗時の警告、成功時はnull
 */
function deleteInputFileBestEffort(filePath, unlinkFn = fs.unlinkSync) {
  try {
    unlinkFn(filePath);
    return null;
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return `body-fileの削除に失敗しました。原案を保持しています: ${filePath} (${detail})`;
  }
}

module.exports = { deleteInputFileBestEffort };
