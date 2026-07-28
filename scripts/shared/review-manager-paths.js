'use strict';
// review-manager (start-review-manager.js / run-review-manager.js) が
// PR番号からファイルパスを組み立てる際の path-safety ヘルパー。
//
// pr はGitHub上のPR番号として扱われるが、CLI引数として直接渡されうるため、
// path.join に使う前に検証しないと "../" 等でworkspace外への
// 任意ファイル書き込みに悪用できる（PR #84 Review指摘）。

const path = require('path');
const { workerLogPath } = require('./headless-launch');

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
 * '.log'（実行ログ）だけは例外で、ghDir直下ではなく shared/headless-launch.js の
 * workerLogPath() と同じ `<workspace>/.gh-maestro/worker-logs/` に置く。以前はReview Managerの
 * ログだけ ghDir 直下という独自の場所になっており、通常ワーカー（coder等）のログ保存先
 * （workerLogPath）と食い違っていた。ログの保存場所を全ワーカー種別で1つの仕組みに揃える。
 * '.running'（lock）・'.json'（findingsスキーマで契約が固定された成果物）は対象外のまま
 * ghDir直下に残す（.claude/rules/review-manager-launcher-conventions.md 参照）。
 *
 * @param {string} ghDir
 * @param {string|number} pr
 * @param {string} suffix 例: '.running', '.log', '.json'
 * @returns {string} 解決済みの絶対パス
 */
function reviewArtifactPath(ghDir, pr, suffix) {
  const validPr = assertValidPr(pr);
  const resolvedGhDir = path.resolve(ghDir);

  if (suffix === '.log') {
    // resolvedGhDir は常に <workspace>/.gh-maestro（呼び出し元がそう組み立てる前提）なので、
    // 一段上がれば workspace になる。validPr は上で正整数のみに検証済みのため、
    // これをそのまま workerName として渡してもpath traversalの余地はない。
    const workspace = path.dirname(resolvedGhDir);
    return workerLogPath(workspace, `review-manager-${validPr}`);
  }

  const filePath = path.join(resolvedGhDir, `review-manager-${validPr}${suffix}`);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedGhDir && !resolvedFile.startsWith(resolvedGhDir + path.sep)) {
    throw new Error(`resolved path escapes ghDir: ${filePath}`);
  }
  return resolvedFile;
}

/**
 * PR番号から Review Manager専用worktreeのディレクトリ名（ブランチ名としても使う）を作る。
 * @param {string|number} pr
 * @returns {string} 例: 'review-pr-123'
 */
function reviewWorktreeBranchName(pr) {
  return `review-pr-${assertValidPr(pr)}`;
}

/**
 * PRのheadを取り込む専用ref名を作る。実際にoriginに存在するリモート追跡ブランチではないため
 * refs/remotes/origin/ 名前空間は使わず、gh-maestro専用の名前空間に置く（実リモートブランチとの
 * 混同を避けるため）。毎回force-fetchで上書きする前提（呼び出し側は `+` refspecを使う）。
 * @param {string|number} pr
 * @returns {string} 例: 'refs/gh-maestro/review-pr-123'
 */
function reviewWorktreeFetchRef(pr) {
  return `refs/gh-maestro/${reviewWorktreeBranchName(pr)}`;
}

/**
 * workspace/.gh-maestro/worktrees/ 配下に限定した、Review Manager専用worktreeのパスを構築する。
 * reviewArtifactPath と同じ封じ込めパターン（識別子検証 + 解決後パスがルート配下に収まることの確認）
 * を worktrees ディレクトリに適用する。
 *
 * @param {string} workspace
 * @param {string|number} pr
 * @returns {string} 解決済みの絶対パス
 */
function reviewWorktreeDir(workspace, pr) {
  const branchName = reviewWorktreeBranchName(pr);
  const worktreesRoot = path.resolve(path.join(workspace, '.gh-maestro', 'worktrees'));
  const dir = path.join(worktreesRoot, branchName);
  const resolvedDir = path.resolve(dir);
  if (resolvedDir !== worktreesRoot && !resolvedDir.startsWith(worktreesRoot + path.sep)) {
    throw new Error(`resolved path escapes worktrees root: ${dir}`);
  }
  return resolvedDir;
}

module.exports = {
  assertValidPr,
  reviewArtifactPath,
  reviewWorktreeBranchName,
  reviewWorktreeFetchRef,
  reviewWorktreeDir,
};
