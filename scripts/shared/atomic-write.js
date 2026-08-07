'use strict';
// atomic-write.js — JSONファイルの原子的書き出し（staging → rename）を共有化する
// 汎用ヘルパー。
//
// 背景: finalize-review.js（findings JSON）と run-council.js（council state）が
// それぞれ「親ディレクトリ確保 → 一時ファイルへ JSON.stringify(_, null, 2) 書込み →
// renameSync → 失敗時 unlink」を独立に実装していた（Issue #232 反省会指摘 #1）。
// 書き込み途中のクラッシュで対象ファイルが破損するのを防ぎ、rename は同一
// ファイルシステム上でのみ原子的。
//
// 契約: エラーは throw。成功/失敗の返り値形式は呼び出し元の契約に合わせて
// 呼び出し元側で定める（finalize-review.js は {success,error}、run-council.js は
// throw のまま）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');

/**
 * オブジェクトを JSON として原子的に書き出す（staging → rename）。
 *
 * @param {string} filePath 出力先ファイルパス
 * @param {object} data     書き出すオブジェクト（JSON.stringify(data, null, 2)）
 * @returns {string} 出力先ファイルパス
 * @throws {Error} 親ディレクトリ作成・一時ファイル書込み・rename のいずれかが失敗した場合
 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const rand = Math.random().toString(36).slice(2, 8);
  const stagingPath = path.join(dir, `.staging-${path.basename(filePath)}.${process.pid}-${Date.now()}-${rand}`);

  try {
    fs.writeFileSync(stagingPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(stagingPath, filePath);
  } catch (e) {
    // 失敗時は staging を掃除（ベストエフォート）して失敗を伝える
    try { fs.unlinkSync(stagingPath); } catch {}
    throw e;
  }
  return filePath;
}

module.exports = { atomicWriteJson };
