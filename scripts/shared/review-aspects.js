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

module.exports = {
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
  VALID_ASPECTS,
  VALID_SEVERITIES,
  FINDING_REQUIRED_FIELDS,
};
