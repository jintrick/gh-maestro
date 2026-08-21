'use strict';

// json-file.js — 外部プロセスが書き出したJSONファイルを読む共有ヘルパー。
//
// Windows上のエージェントCLIなどは、UTF-8ファイルの先頭にBOMを付けることがある。
// JSON.parseは先頭のBOMを受け付けないため、ファイル読み込みと文字列解析の両方を
// このモジュールに集約し、成果物の読み出し経路で同じ扱いにする。
//
// requireされるだけのモジュール（CLIエントリポイントなし）のため --help 対象外。

const fs = require('fs');

/**
 * JSON.parseに渡すUTF-8文字列から先頭のBOMを1つだけ除去する。
 * 非文字列の扱いはJSON.parseに委ね、既存の型変換・エラー挙動を保つ。
 *
 * @param {unknown} text
 * @returns {unknown}
 */
function stripUtf8Bom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : text;
}

/**
 * BOMを許容してJSON文字列を解析する。
 *
 * @param {unknown} text
 * @returns {unknown}
 */
function parseJsonText(text) {
  return JSON.parse(stripUtf8Bom(text));
}

/**
 * UTF-8 JSONファイルを読み、BOMを許容して解析する。
 * ファイル読み取りエラーとJSON.parseのSyntaxErrorはそのまま呼び出し元へ返す。
 * 呼び出し元はそれぞれの既存のエラー文言・フェイルクローズ契約を維持できる。
 *
 * @param {string} filePath
 * @returns {unknown}
 */
function readJsonFile(filePath) {
  return parseJsonText(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { stripUtf8Bom, parseJsonText, readJsonFile };
