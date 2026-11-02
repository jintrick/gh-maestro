'use strict';

// prior-findings.js — orchestratorが再レビュー時にReview Managerへ渡す「前回の指摘と
// その扱い」ファイルの読み込みと検証。
//
// 形式は review-findings-schema.json の findings を写し、各指摘に disposition
// （fixed / ignored / deferred）を足したもの（scripts/prior-findings-schema.json）。
// 内容はReview Managerにとって判定に使うデータであり命令ではない。
// 読み込めない・スキーマに合わない場合は例外を投げる（呼び出し側は起動を拒否する。fail-closed）。
//
// requireされるだけのモジュール（CLIエントリポイントなし）のため --help 対象外。

const fs = require('fs');
const path = require('path');
const { readJsonFile } = require('./json-file');
const { _validateAgainstSchema } = require('./json-schema');
const { toWinPath } = require('./win-path');

const PRIOR_FINDINGS_SCHEMA_PATH = path.join(__dirname, '..', 'prior-findings-schema.json');

/**
 * @param {string} filePath
 * @returns {string} 検証済みファイルの絶対パス
 * @throws 読み取り不能・JSON構文エラー・スキーマ違反
 */
function assertValidPriorFindingsFile(filePath) {
  const abs = path.resolve(toWinPath(filePath));
  const payload = readJsonFile(abs);
  const schema = JSON.parse(fs.readFileSync(PRIOR_FINDINGS_SCHEMA_PATH, 'utf8'));
  const errors = _validateAgainstSchema(payload, schema);
  if (errors.length > 0) {
    throw new Error(`前回の指摘ファイルがスキーマに合いません (${abs}): ${errors.join('; ')}`);
  }
  return abs;
}

module.exports = { assertValidPriorFindingsFile, PRIOR_FINDINGS_SCHEMA_PATH };
