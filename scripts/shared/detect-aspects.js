'use strict';
// 変更ファイルの一覧から、レビューすべき観点（skills/gh-maestro-reviewer/ 配下の葉）を
// 決定的なパターンマッチングで算出する。poll-pr.js 専用ロジックとして埋め込まず、
// 他スクリプト（run-review-manager.js 等）からも再利用できるよう独立モジュールにする。

const { listKnownAspects } = require('./review-aspects');

/**
 * ファイルパスのパターン → 観点（葉名）のマッピングテーブル。
 * 上から順に評価し、一致したものをすべて集める（1ファイルが複数観点に一致してよい）。
 */
const ASPECT_RULES = [
  { pattern: /(^|[\\/])tests[\\/].*\.test\.js$/, aspects: ['test-quality'] },
  { pattern: /(auth|permission|sandbox|safe-path|path-confine)/i, aspects: ['hostile-input'] },
  { pattern: /(lock|lifecycle|concurrency|race|mutex|poll)/i, aspects: ['concurrency'] },
  { pattern: /(cleanup|retry|recover|fail-closed|dead-man)/i, aspects: ['failure-recovery'] },
  { pattern: /(child-process|spawn|-api\.js$|api-)/i, aspects: ['api-contract'] },
  { pattern: /\.(ya?ml|json)$/i, aspects: ['api-contract'] },
  { pattern: /(README|SKILL)\.md$/i, aspects: ['structure-naming'] },
];

/**
 * @param {string[]} changedFiles 変更されたファイルパスの一覧
 * @param {string[]} [knownAspects] 既知の観点名一覧（省略時は動的スキャン）
 * @returns {string[]} 観点名のソート済み一覧。1件も一致しなければ既知の全観点を返す
 *   （見逃しリスクを避けるため、迷った場合はheavy相当に近い形で広く倒す）。
 */
function detectAspects(changedFiles, knownAspects = listKnownAspects()) {
  const matched = new Set();
  for (const file of changedFiles) {
    for (const rule of ASPECT_RULES) {
      if (!rule.pattern.test(file)) continue;
      for (const aspect of rule.aspects) {
        if (knownAspects.includes(aspect)) matched.add(aspect);
      }
    }
  }
  if (matched.size === 0) {
    return [...knownAspects].sort();
  }
  return [...matched].sort();
}

module.exports = { detectAspects, ASPECT_RULES };
