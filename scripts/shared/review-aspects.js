'use strict';
// review-aspects.js — Review Managerのレビュー基準（7葉）と幹（4幹）の定義
//
// run-review-jobs.js / finalize-review.js 等から共有参照される単一の正規定義。
// 将来葉や幹を変更する際はこのファイルだけを更新する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const ALL_LEAF_IDS = Object.freeze([
  'correctness/logic-invariants',
  'correctness/api-contract',
  'correctness/concurrency',
  'resilience-security/failure-recovery',
  'resilience-security/hostile-input',
  'maintainability/structure-naming',
  'test-quality/test-quality',
]);

const TRUNK_TO_LEAVES = Object.freeze({
  'Correctness': ['correctness/logic-invariants', 'correctness/api-contract', 'correctness/concurrency'],
  'Resilience & Security': ['resilience-security/failure-recovery', 'resilience-security/hostile-input'],
  'Maintainability': ['maintainability/structure-naming'],
  'Test Quality': ['test-quality/test-quality'],
});

const VALID_ASPECTS = new Set(['Correctness', 'Maintainability', 'Resilience & Security', 'Test Quality']);

const VALID_SEVERITIES = new Set(['BLOCKER', 'MAJOR', 'SUGGESTION']);

const FINDING_REQUIRED_FIELDS = [
  'aspect', 'path', 'line_anchor', 'summary',
  'severity', 'severity_rationale', 'body', 'verified_references',
];

/**
 * 葉IDに対応する正本ファイルのスキルルート相対パスを導出する。
 *
 * 葉IDは正本のディレクトリとファイル名を兼ねるため、実行計画にファイルの
 * 所在を書かせずとも一意に解決できる。未知のIDは正本の定義に対応しないため、
 * パスへ変換せず拒否する。
 *
 * @param {string} leafId
 * @returns {string}
 * @throws {Error} leafIdが正規の葉IDでない場合
 */
function deriveLeafFilePath(leafId) {
  if (typeof leafId !== 'string' || !ALL_LEAF_IDS.includes(leafId)) {
    throw new Error(`unknown leaf id: ${JSON.stringify(leafId)}`);
  }
  return `${leafId}.md`;
}

module.exports = {
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
  VALID_ASPECTS,
  VALID_SEVERITIES,
  FINDING_REQUIRED_FIELDS,
  deriveLeafFilePath,
};
