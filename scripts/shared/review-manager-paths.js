'use strict';
// review-manager (start-review-manager.js / run-review-manager.js) が
// PR番号からファイルパスを組み立てる際の path-safety ヘルパー。
//
// pr はGitHub上のPR番号として扱われるが、CLI引数として直接渡されうるため、
// path.join に使う前に検証しないと "../" 等でworkspace外への
// 任意ファイル書き込みに悪用できる（PR #84 Review指摘）。

const path = require('path');

const VALID_PR_RE = /^[1-9]\d*$/;

/**
 * PR番号を厳密な正整数文字列として検証する。
 * @param {string|number} pr
 * @returns {string} 検証済みのpr文字列
 */
function assertValidPr(pr) {
  const s = String(pr);
  if (!VALID_PR_RE.test(s)) {
    throw new Error(`invalid PR number: ${JSON.stringify(pr)} (must be a positive integer)`);
  }
  return s;
}

/**
 * ghDir配下に限定したreview-manager成果物のパスを構築する。
 * prを検証した上でファイル名を組み立て、解決後のパスがghDir配下に
 * 収まることも確認する（prの検証漏れに対する多層防御）。
 *
 * @param {string} ghDir
 * @param {string|number} pr
 * @param {string} suffix 例: '.running', '.log', '.json', '-brief.md'
 * @returns {string} 解決済みの絶対パス
 */
function reviewArtifactPath(ghDir, pr, suffix) {
  const validPr = assertValidPr(pr);
  const resolvedGhDir = path.resolve(ghDir);
  const filePath = path.join(resolvedGhDir, `review-manager-${validPr}${suffix}`);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedGhDir && !resolvedFile.startsWith(resolvedGhDir + path.sep)) {
    throw new Error(`resolved path escapes ghDir: ${filePath}`);
  }
  return resolvedFile;
}

module.exports = { assertValidPr, reviewArtifactPath };
