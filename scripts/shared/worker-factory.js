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
const { assertValidPr, reviewArtifactPath } = require('./review-manager-paths');

// ── 入力バリデーション ──────────────────────────────────────────────────────────
// 外部由来の値（issue/description）が worktree・ログパス等の構成要素になる前に
// 検証する。既存の spawn-worker.js CLI と同一のバリデーションをfactoryでも適用する。

const ISSUE_RE = /^[1-9][0-9]*$/;
const DESCRIPTION_RE = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * Issue番号を正の整数として検証する（spawn-worker.js line 168 と同一の検証）。
 * @param {number|string} issue
 * @returns {number} 検証済みの数値
 * @throws {Error} 正の整数でない場合
 */
function assertValidIssue(issue) {
  const s = String(issue);
  if (!ISSUE_RE.test(s)) {
    throw new Error(
      `invalid issue number: ${JSON.stringify(issue)} ` +
      `(must be a positive integer)`
    );
  }
  return Number(s);
}

/**
 * description を gitブランチ名・worktreeディレクトリ名として安全に使えるか
 * 検証する（spawn-worker.js line 152 と同一の検証）。
 * @param {string} description
 * @returns {string} 検証済みのdescription
 * @throws {Error} 英数字・ハイフン・アンダースコアのみ 1〜50文字でない場合
 */
function assertValidDescription(description) {
  if (typeof description !== 'string' || !DESCRIPTION_RE.test(description)) {
    throw new Error(
      `invalid description: ${JSON.stringify(description)} ` +
      `(must match ${DESCRIPTION_RE.source}: 1–50 chars, A-Z a-z 0-9 _ - only)`
    );
  }
  return description;
}

/**
 * candidate を resolve した結果が root 配下であることを確認する
 * （path-confinement.md のルール準拠。review-manager-paths.js と同じパターン）。
 * resolve が "../" を正規化するため、正規化後のパスで配下判定する。
 * @param {string} root 許可されたルートディレクトリ（事前resolve済み）
 * @param {string} candidate 検査対象のパス
 * @param {string} label エラーメッセージ用のラベル（例: 'worktreeDir'）
 * @throws {Error} ルート配下でない場合
 */
function assertWithinRoot(root, candidate, label) {
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== root &&
    !resolvedCandidate.startsWith(root + path.sep)
  ) {
    throw new Error(
      `${label} が管理ルート外に解決されました: ` +
      `${JSON.stringify(resolvedCandidate)} (root: ${JSON.stringify(root)})`
    );
  }
}

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
// completionMode は「呼び出し制御（supervise）」と「仕事の完了シグナル」の2関心事を
// 1つのunion型で表現する（Issue #174 2巡目architect設計）。
//
// - launch-accepted: 起動が成立した時点で完了。呼び出し元は即座に返る（detached）。
//   通常ワーカー（coder/senior-coder/explorer等）が該当。
// - process-exit:   プロセスの終了（exit status 0）を完了シグナルとする。
//   呼び出し元はプロセス終了までブロックする。
// - artifact-committed: 成果物のコミット（atomic rename完了）を完了シグナルとする。
//   プロセス終了はcleanup目的でのみ扱う。Review Managerが該当。
//
// @typedef {'launch-accepted'|'process-exit'|'artifact-committed'} CompletionMode
//
// @typedef {object} LifecyclePolicy
// @property {CompletionMode} completionMode - 完了判定種別
// @property {boolean} registerInWorkersJson - workers.json に登録するか
// @property {boolean} resumeTarget     - resume対象か
// @property {boolean} keepWorktree     - 終了後worktreeを保持するか（falseなら即時破棄）
// @property {number|null} timeoutMs    - 監督モード（completionMode !== 'launch-accepted'）の
//                                        タイムアウト（ms）。nullの場合はデフォルト値を使用。
// @property {object|null} artifactConfig - completionMode === 'artifact-committed' の場合の
//                                          成果物検出設定。それ以外は null。
// @property {string} artifactConfig.outputFileName   - 監視対象の成果物ファイル名
// @property {number} artifactConfig.pollIntervalMs    - ポーリング間隔（ms）
// @property {string} artifactConfig.schemaPath        - JSON Schemaの絶対パス
// @property {function|null} onSuccess  - 成功時の後処理（未使用。Phase 4でreview-publisherをhook）
// @property {function|null} onFailure  - 失敗時の後処理（未使用）
// @property {boolean} participateInExecutionRegistry - execution-registryへ参加するか

// ── Role 導出（ROLE_LABEL_MAP + カスタムスキルフォールバック） ─────────────────
// ROLE_LABEL_MAP に無いスキル（ユーザーが config.json の skillAgentMap に追加した
// カスタムスキル等）は、スキル名から安全な role を導出する。
// gh-maestro- プレフィックスがあれば除去し、なければスキル名全体を role として使う。
// 導出された role も DESCRIPTION_RE（英数字・ハイフン・アンダースコア 1〜50文字）の
// 検証を通過することを確認する。

/**
 * スキル名から role ラベルを導出する。
 *
 * ROLE_LABEL_MAP に登録済みならそれを返し、なければスキル名から安全な role を
 * 機械的に導出する。カスタムスキル名（例: gh-maestro-custom-reviewer）も
 * 受け付ける。
 *
 * @param {string} skill 完全なスキル名
 * @returns {string} role ラベル
 * @throws {Error} 導出した role が安全でない場合
 */
function deriveRoleFromSkill(skill) {
  // 既知のスキル → 登録済み role
  if (ROLE_LABEL_MAP[skill]) {
    return ROLE_LABEL_MAP[skill];
  }

  // gh-maestro- プレフィックスがあれば除去
  let derived;
  const PREFIX = 'gh-maestro-';
  if (skill.startsWith(PREFIX)) {
    derived = skill.slice(PREFIX.length);
  } else {
    derived = skill;
  }

  // 安全性検証: git ブランチ名・ディレクトリ名として使えるか
  if (!DESCRIPTION_RE.test(derived)) {
    throw new Error(
      `カスタムスキル "${skill}" から導出した role "${derived}" が` +
      `安全な識別子ではありません（${DESCRIPTION_RE.source}: ` +
      `1–50 chars, A-Z a-z 0-9 _ - only）。` +
      `スキル名を gh-maestro- で始まる安全な名前に変更してください。`
    );
  }

  return derived;
}

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
  const role = deriveRoleFromSkill(skill);

  // 入力検証: issue/description を workerName（延いては worktreeDir/logPath）の
  // 構成要素として使う前に、既存 CLI（spawn-worker.js）と同じ検証を適用する。
  // description は gitブランチ名・ディレクトリ名として使われるため、
  // パストラバーサル文字列（../等）はここで拒否される。
  const validIssue = assertValidIssue(issue);
  const validDescription = assertValidDescription(description);

  const workerName = buildWorkerName(validIssue, role, validDescription);
  const ghDir = path.resolve(path.join(workspace, '.gh-maestro'));
  const worktreesRoot = path.join(ghDir, 'worktrees');

  const worktreeDir = path.join(worktreesRoot, workerName);
  const logPath = workerLogPath(workspace, workerName, {
    ownerKind: 'issue', ownerId: validIssue, workerName,
  });

  // 多層防御: 識別子検証を通過した後も、解決後パスが管理ルート配下かを確認する
  // （path-confinement.md 準拠。description検証が ../ を弾くが、将来の変更や
  // 未知のエンコーディングバイパスに備えた防護線）。
  assertWithinRoot(worktreesRoot, worktreeDir, 'worktreeDir');

  return Object.freeze({
    workerName,
    issue: validIssue,
    role,
    skill,
    description: validDescription,
    pr: null,
    repo,
    workspace,
    worktreeKey: workerName,
    logKey: workerName,
    leaseKey: workerName,
    leaseStore: path.join(ghDir, 'workers.json'),
    worktreeDir,
    logPath,
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
  const validIssue = assertValidIssue(issue);
  const validPr = assertValidPr(pr);
  const description = `pr-${validPr}`;

  const workerName = buildWorkerName(validIssue, role, description);
  // 例: issue-174-review-manager-pr-42

  const ghDir = path.resolve(path.join(workspace, '.gh-maestro'));
  const worktreesRoot = path.join(ghDir, 'worktrees');

  const worktreeDir = path.join(worktreesRoot, `review-pr-${validPr}`);
  const logPath = workerLogPath(workspace, workerName, {
    ownerKind: 'pr', ownerId: validPr, workerName,
  });

  // 多層防御: 解決後パスが管理ルート配下かを確認する（通常ワーカーと同様の防護線）。
  // Review Managerのworktreeキーは review-pr-<pr>（pr は assertValidPr で正整数に
  // 検証済み）だが、将来の変更に備えて封じ込めチェックを適用する。
  assertWithinRoot(worktreesRoot, worktreeDir, 'worktreeDir');

  return Object.freeze({
    workerName,
    issue: validIssue,
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
    leaseStore: reviewArtifactPath(ghDir, validPr, '.running'),
    worktreeDir,
    logPath,
  });
}

// ── LifecyclePolicy factory ────────────────────────────────────────────────────

/**
 * 通常ワーカーの LifecyclePolicy を返す。
 *
 * - completionMode: 'launch-accepted'（起動成立で即完了。呼び出し元はdetach）
 * - workers.json 登録あり
 * - resume対象
 * - worktree保持
 * - execution-registry参加
 * - artifactConfig: null（成果物の知識を持たない）
 *
 * @returns {LifecyclePolicy}
 */
function normalWorkerPolicy() {
  return Object.freeze({
    completionMode: 'launch-accepted',
    registerInWorkersJson: true,
    resumeTarget: true,
    keepWorktree: true,
    timeoutMs: null,
    artifactConfig: null,
    onSuccess: null,
    onFailure: null,
    participateInExecutionRegistry: true,
  });
}

/**
 * Review Manager の LifecyclePolicy を返す。
 *
 * - completionMode: 'artifact-committed'（成果物のatomic renameを完了シグナルとする）
 * - workers.json 非登録
 * - resume非対象
 * - worktree即時破棄
 * - execution-registry非参加（completedへの正しい状態遷移を保証できないため）
 * - artifactConfig: 成果物検出の設定（ポーリング間隔・スキーマパス等）
 * - timeoutMs: デフォルトの監督タイムアウト（30分）
 *
 * @param {object} [opts]
 * @param {string} [opts.schemaPath] - JSON Schemaファイルの絶対パス
 * @param {string} [opts.outputFileName] - 成果物ファイル名（デフォルト: findings.json）
 * @param {number} [opts.pollIntervalMs] - ポーリング間隔ms（デフォルト: 200）
 * @param {number} [opts.timeoutMs] - 監督タイムアウトms（デフォルト: 30分）
 * @returns {LifecyclePolicy}
 */
function reviewManagerPolicy(opts = {}) {
  const schemaPath = opts.schemaPath || null;
  const outputFileName = opts.outputFileName || 'findings.json';
  const pollIntervalMs = opts.pollIntervalMs || 200;
  const timeoutMs = opts.timeoutMs || 30 * 60 * 1000; // 30 minutes

  return Object.freeze({
    completionMode: 'artifact-committed',
    registerInWorkersJson: false,
    resumeTarget: false,
    keepWorktree: false,
    timeoutMs,
    artifactConfig: Object.freeze({
      outputFileName,
      pollIntervalMs,
      schemaPath,
    }),
    onSuccess: null,
    onFailure: null,
    participateInExecutionRegistry: false,
  });
}

module.exports = {
  ROLE_LABEL_MAP,
  deriveRoleFromSkill,
  buildWorkerName,
  buildNormalWorkerLaunchSpec,
  buildReviewManagerLaunchSpec,
  normalWorkerPolicy,
  reviewManagerPolicy,
  // 入力バリデーション（テスト用にエクスポート）
  assertValidIssue,
  assertValidDescription,
  assertWithinRoot,
};
