'use strict';
// worker-factory.js — ワーカー起動仕様（WorkerLaunchSpec）とライフサイクルポリシー
// （LifecyclePolicy）のfactory
//
// Phase 1（本ファイル）:
//   正規ワーカーID（issue-<issue>-<role>-<description>）と各リソースキー（worktreeキー/
//   ブランチ名、Review Managerのreview-pr-<pr>/review-manager-<pr>等）を返すfactory、
//   およびLifecyclePolicyを導入する。既存の起動ロジック（spawn-worker.js・
//   start-review-manager.js・run-review-manager.js）は一切変更しない。
//
// 後続フェーズ（Phase 3-5、本PR対象外）で、既存の起動ロジックをこのfactoryへ差し替える。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const path = require('path');
const { workerLogPath } = require('./headless-launch');
const { assertValidPr } = require('./review-manager-paths');

// ── Role ラベルマップ ──────────────────────────────────────────────────────────
// skill名 → roleラベル（workerNameの <role> 部分）。
// 全ワーカー種別が一貫して role を持つ（Issue #174 命名規約フォローアップコメント参照）。

const ROLE_LABEL_MAP = Object.freeze({
  'gh-maestro-coder': 'coder',
  'gh-maestro-senior-coder': 'senior-coder',
  'gh-maestro-explorer': 'explorer',
  'gh-maestro-investigator': 'investigator',
  'gh-maestro-architect': 'architect',
  'gh-maestro-base': 'base',
  'gh-maestro-reviewer': 'review-manager',
});

// ── WorkerLaunchSpec ───────────────────────────────────────────────────────────
//
// 起動前に確定する不変の起動仕様。全ワーカー種別で共通の形状を持つ。
//
// @typedef {object} WorkerLaunchSpec
// @property {string} workerName   - 正規ワーカーID（issue-<issue>-<role>-<description>）
// @property {number} issue        - アンカーIssue番号
// @property {string} role         - 短いロールラベル（ROLE_LABEL_MAPの値）
// @property {string} skill        - 完全なスキル名（ROLE_LABEL_MAPのキー）
// @property {string} description  - タスク記述（通常ワーカー: ユーザー指定。Review Manager: "pr-<PR>"）
// @property {string|null} pr      - PR番号（Review Managerのみ。通常ワーカーは null）
// @property {string} repo         - GitHub リポジトリ（owner/repo）
// @property {string} workspace    - ワークスペース絶対パス
// @property {string} worktreeKey  - worktreeディレクトリ名/ブランチ名
//                                   （通常ワーカー: workerName と同一。
//                                     Review Manager: review-pr-<pr>）
// @property {string} logKey       - workerLogPath(workspace, logKey) に渡すログキー。
//                                   全ワーカー種別で正規ID（workerName）に統一。
// @property {string} leaseKey     - リースを識別するキー
//                                   （通常ワーカー: workers.json のキー = workerName。
//                                     Review Manager: review-manager-<pr>）
// @property {string} leaseStore   - リース保存先のパス
//                                   （通常ワーカー: workers.json のパス。
//                                     Review Manager: .running ファイルのパス）
// @property {string} worktreeDir  - worktreeの絶対パス（workspace + worktreeKey から導出）
// @property {string} logPath      - ログファイルの絶対パス（workspace + logKey から導出）

// ── LifecyclePolicy ────────────────────────────────────────────────────────────
//
// 起動から終了時までの扱いを表すポリシー。ワーカー種別ごとに固定の組み合わせを持つ。
//
// @typedef {object} LifecyclePolicy
// @property {boolean} detached         - detached起動（true）か完了待ち（false）か
// @property {boolean} registerInWorkersJson - workers.json に登録するか
// @property {boolean} resumeTarget     - resume対象か
// @property {boolean} keepWorktree     - 終了後worktreeを保持するか（falseなら即時破棄）
// @property {function|null} onSuccess  - 成功時の後処理（未使用。Phase 4でreview-publisherをhook）
// @property {function|null} onFailure  - 失敗時の後処理（未使用）
// @property {boolean} participateInExecutionRegistry - execution-registryへ参加するか

// ── ヘルパー ───────────────────────────────────────────────────────────────────

/**
 * 正規ワーカーIDを組み立てる。
 *
 * 形式: issue-<issue>-<role>-<description>
 * 冗長さは許容し、可読性・追跡性を優先する（Issue #174 命名規約）。
 *
 * @param {number|string} issue
 * @param {string} role 短いロールラベル（ROLE_LABEL_MAPの値）
 * @param {string} description タスク記述
 * @returns {string} issue-<issue>-<role>-<description>
 */
function buildWorkerName(issue, role, description) {
  return `issue-${issue}-${role}-${description}`;
}

// ── LaunchSpec factory ─────────────────────────────────────────────────────────

/**
 * 通常ワーカー（coder/senior-coder/explorer/investigator/architect/base）の
 * 起動仕様を生成する。
 *
 * worktreeキー・ブランチ名は正規IDと同一。
 * リースは workers.json のエントリ（キー = workerName）。
 *
 * @param {object} params
 * @param {string} params.skill        - 完全なスキル名（ROLE_LABEL_MAPのキー）
 * @param {number|string} params.issue - Issue番号（正の整数）
 * @param {string} params.description  - タスク記述（英数字・ハイフン・アンダースコアのみ、1〜50文字）
 * @param {string} params.repo         - GitHub リポジトリ（owner/repo）
 * @param {string} params.workspace    - ワークスペース絶対パス
 * @returns {WorkerLaunchSpec}
 */
function buildNormalWorkerLaunchSpec({ skill, issue, description, repo, workspace }) {
  const role = ROLE_LABEL_MAP[skill];
  if (!role) {
    throw new Error(
      `buildNormalWorkerLaunchSpec: 未知のスキルです: ${JSON.stringify(skill)}。` +
      `通常ワーカーは ROLE_LABEL_MAP に登録されたスキルのみ受け付けます。`
    );
  }
  if (role === 'review-manager') {
    throw new Error(
      `buildNormalWorkerLaunchSpec: review-manager は通常ワーカーではありません。` +
      `buildReviewManagerLaunchSpec を使用してください。`
    );
  }

  const workerName = buildWorkerName(issue, role, description);
  const ghDir = path.join(workspace, '.gh-maestro');

  return Object.freeze({
    workerName,
    issue: Number(issue),
    role,
    skill,
    description,
    pr: null,
    repo,
    workspace,
    worktreeKey: workerName,
    logKey: workerName,
    leaseKey: workerName,
    leaseStore: path.join(ghDir, 'workers.json'),
    worktreeDir: path.join(ghDir, 'worktrees', workerName),
    logPath: workerLogPath(workspace, workerName),
  });
}

/**
 * Review Managerの起動仕様を生成する。
 *
 * - workerName は正規形式（issue-<issue>-review-manager-pr-<pr>）。
 * - worktreeキー/ブランチ名は review-pr-<pr>（PR番号ベース。正規IDとは異なる）。
 * - リースは .running ファイル（review-manager-<pr>.running）。
 * - ログキーは正規ID（workerName）。現行コードは review-manager-<pr> を
 *   使っているが、フェーズ4で正規IDへ切り替える。
 *
 * @param {object} params
 * @param {number|string} params.issue     - アンカーIssue番号（正の整数）
 * @param {string|number} params.pr        - PR番号（正の整数）
 * @param {string} params.repo             - GitHub リポジトリ（owner/repo）
 * @param {string} params.workspace        - ワークスペース絶対パス
 * @returns {WorkerLaunchSpec}
 */
function buildReviewManagerLaunchSpec({ issue, pr, repo, workspace }) {
  const skill = 'gh-maestro-reviewer';
  const role = ROLE_LABEL_MAP[skill]; // 'review-manager'
  const validPr = assertValidPr(pr);
  const description = `pr-${validPr}`;

  const workerName = buildWorkerName(issue, role, description);
  // 例: issue-174-review-manager-pr-42

  const ghDir = path.join(workspace, '.gh-maestro');

  return Object.freeze({
    workerName,
    issue: Number(issue),
    role,
    skill,
    description,
    pr: validPr,
    repo,
    workspace,
    // Review Managerのworktreeキー/ブランチ名はPR番号ベース
    // （review-manager-paths.js の reviewWorktreeBranchName と同一の契約）
    worktreeKey: `review-pr-${validPr}`,
    // ログキーは正規ID。現行（review-manager-paths.js）の reviewArtifactPath(.log) は
    // workerLogPath(workspace, 'review-manager-<pr>') を使っているが、
    // フェーズ4で workerLogPath(workspace, workerName) へ切り替える。
    logKey: workerName,
    // リースキーは .running ファイルのベース名（review-manager-<pr>）。
    // 現行の start-review-manager.js / run-review-manager.js の契約を維持。
    leaseKey: `review-manager-${validPr}`,
    leaseStore: path.join(ghDir, `review-manager-${validPr}.running`),
    worktreeDir: path.join(ghDir, 'worktrees', `review-pr-${validPr}`),
    logPath: workerLogPath(workspace, workerName),
  });
}

// ── LifecyclePolicy factory ────────────────────────────────────────────────────

/**
 * 通常ワーカーの LifecyclePolicy を返す。
 *
 * - detached起動
 * - workers.json 登録あり
 * - resume対象
 * - worktree保持
 * - execution-registry参加
 *
 * @returns {LifecyclePolicy}
 */
function normalWorkerPolicy() {
  return Object.freeze({
    detached: true,
    registerInWorkersJson: true,
    resumeTarget: true,
    keepWorktree: true,
    onSuccess: null,
    onFailure: null,
    participateInExecutionRegistry: true,
  });
}

/**
 * Review Manager の LifecyclePolicy を返す。
 *
 * - 完了待ち（同期。呼び出し元が終了までブロックする）
 * - workers.json 非登録
 * - resume非対象
 * - worktree即時破棄
 * - execution-registry非参加（completedへの正しい状態遷移を保証できないため）
 *
 * @returns {LifecyclePolicy}
 */
function reviewManagerPolicy() {
  return Object.freeze({
    detached: false,
    registerInWorkersJson: false,
    resumeTarget: false,
    keepWorktree: false,
    onSuccess: null,
    onFailure: null,
    participateInExecutionRegistry: false,
  });
}

module.exports = {
  ROLE_LABEL_MAP,
  buildWorkerName,
  buildNormalWorkerLaunchSpec,
  buildReviewManagerLaunchSpec,
  normalWorkerPolicy,
  reviewManagerPolicy,
};
