'use strict';
// council-worktree.js — council（run-council.js / run-council-investigation.js）の
// セッション名前空間と議論用worktreeの共有ヘルパー。
//
// セッションIDはローカル成果物（state / 議論用worktree / 調査結果）の名前空間であり、
// --title から ASCII スラッグを決定論的に自動生成する。state ファイルと衝突する場合は
// -2, -3... の短い接尾辞を機械的に付与する。--resume は明示 --session で一意特定する。
// セッションIDの算出は orchestrator の責務ではない（run-council.js 側の決定論的処理）。
//
// 外部由来の --session は ^[A-Za-z0-9_-]{1,64}$ で形式検証し、すべてのパス導出は
// assertWithinRoot で封じ込める（path-confinement ルール準拠）。成果物は計画どおり
// <workspace>/.gh-maestro/ 直下に置く（install.js 管理外の per-workspace 領域）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('../child-process');
const { assertWithinRoot } = require('./worker-factory');
const { worktreeAddDetached, worktreeRemove } = require('../git-worktree');

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
// SESSION_RE の上限64文字から、collision接尾辞（-2, -3...）の余地を差し引いた
// 自動生成スラッグの基本長。56文字 + "-2" 程度の接尾辞でも64を超えない。
const MAX_SLUG_BASE_LEN = 56;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * --session を厳密に形式検証する。形式外なら throw。
 * @param {string} session
 * @returns {string} 検証済み session
 */
function assertValidSession(session) {
  if (typeof session !== 'string' || !SESSION_RE.test(session)) {
    throw new Error(`invalid session: ${JSON.stringify(session)} (must match ${SESSION_RE.source})`);
  }
  return session;
}

/**
 * --title からセッションIDの候補を決定論的に生成する。
 * 非ASCII文字・記号は '-' に畳み込み、連続・両端の '-' を取り除き、結果が空になる
 * タイトルは 'council' にフォールバックする。加えて、正規化後のタイトル全体の
 * SHA-1 先頭8文字を常に接尾辞として付与する。
 *
 * ハッシュを付与する理由: ASCII畳み込みだけだと日本語タイトル（"RAG構成の採用可否"、
 * "採用可否について" 等）は全て 'council'（または同一の残り文字列）に潰れて同じ
 * セッションIDを共有する。すると state ファイルが衝突し、調査結果の読込先が
 * 別議題のものに混線する（実害: 過去の調査結果が新しい議題の最初のコメントとして
 * 誤投稿された。review指摘 #2）。ハッシュは決定論的（同一タイトル → 同一ID）なので
 * 同じ議題の --resume は安定し、内容が異なれば必ず別IDになる。
 *
 * 長いタイトルは MAX_SLUG_BASE_LEN までで切り詰める（ハッシュと '-' を必ず残し、
 * SESSION_RE 形式=最大64文字を保証。collision 接尾辞の余地もここで確保する）。
 * 例: "RAG構成の採用可否" → "rag-<hash8>"
 *
 * @param {string} title
 * @returns {string}
 */
function slugifyTitle(title) {
  const normalized = String(title).normalize('NFKC');
  const asciiBase = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  const base = (asciiBase || 'council').slice(0, MAX_SLUG_BASE_LEN - hash.length - 1);
  return `${base}-${hash}`;
}

/**
 * council 成果物のルート（<workspace>/.gh-maestro/）。
 * @param {string} workspace
 * @returns {string} 解決済み絶対パス
 */
function councilArtifactsRoot(workspace) {
  return path.resolve(path.join(workspace, '.gh-maestro'));
}

/**
 * state ファイルパス。session 検証 + assertWithinRoot 封じ込め。
 * @param {string} workspace
 * @param {string} session
 * @returns {string} 解決済み絶対パス
 */
function councilStatePath(workspace, session) {
  const valid = assertValidSession(session);
  const root = councilArtifactsRoot(workspace);
  const filePath = path.join(root, `council-${valid}.json`);
  const resolved = path.resolve(filePath);
  assertWithinRoot(root, resolved, 'councilStatePath');
  return resolved;
}

/**
 * 議論用worktreeのディレクトリパス。session 検証 + assertWithinRoot 封じ込め。
 * @param {string} workspace
 * @param {string} session
 * @returns {string} 解決済み絶対パス
 */
function councilWorktreeDir(workspace, session) {
  const valid = assertValidSession(session);
  const root = councilArtifactsRoot(workspace);
  const dirPath = path.join(root, `council-wt-${valid}`);
  const resolved = path.resolve(dirPath);
  assertWithinRoot(root, resolved, 'councilWorktreeDir');
  return resolved;
}

/**
 * 調査結果ファイルのパス。session 検証 + assertWithinRoot 封じ込め。
 * @param {string} workspace
 * @param {string} session
 * @returns {string} 解決済み絶対パス
 */
function councilInvestigationPath(workspace, session) {
  const valid = assertValidSession(session);
  const root = councilArtifactsRoot(workspace);
  const filePath = path.join(root, `council-${valid}.investigation.json`);
  const resolved = path.resolve(filePath);
  assertWithinRoot(root, resolved, 'councilInvestigationPath');
  return resolved;
}

/**
 * セッションIDを解決する。
 * - 明示 session が与えられた場合: 形式検証のみ（--resume 用）。既存 state との衝突は
 *   再開対象そのものなので付与しない。
 * - 省略時: --title からスラッグを生成し、既存の state ファイル（council-<slug>.json）と
 *   衝突する場合は -2, -3... の接尾辞を機械的に付与する（同タイトルの別セッションと混線しない）。
 *
 * @param {{ session?: string, title: string, workspace: string }} opts
 * @returns {string} 解決済み session ID
 */
function resolveSession({ session, title, workspace }) {
  if (session !== undefined && session !== null && session !== '') {
    return assertValidSession(session);
  }
  const base = slugifyTitle(title);
  let candidate = base;
  let n = 2;
  while (fs.existsSync(councilStatePath(workspace, candidate))) {
    // 接尾辞を足しても SESSION_RE（最大64文字）を超えないよう、base を切り詰める。
    // base が十分短い場合は slice は無害（元のまま）。
    const suffix = `-${n}`;
    candidate = `${base.slice(0, MAX_SLUG_BASE_LEN - suffix.length)}${suffix}`;
    n += 1;
  }
  return candidate;
}

/**
 * ワークスペースの HEAD コミットを取得する。失敗時は throw。
 * @param {string} workspace リポジトリルート
 * @returns {string} 40桁の sha
 */
function resolveWorkspaceHead(workspace) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${(r.stderr || '').toString().trim() || (r.error && r.error.message) || 'unknown error'}`);
  }
  const sha = String(r.stdout || '').trim();
  if (!SHA_RE.test(sha)) {
    throw new Error(`git rev-parse HEAD returned unexpected value: ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * 議論用worktreeの現在のHEADを取得する。HEADが解決できない場合（壊れたworktree等）は
 * null を返す。呼び出し元は null を「要求shaと一致しない」として付け直す
 * （fail-closed方向）。
 * @param {string} dir worktreeディレクトリ
 * @returns {string | null} 40桁の sha、または null
 */
function worktreeHead(dir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const sha = String(r.stdout || '').trim();
  return SHA_RE.test(sha) ? sha : null;
}

/**
 * 議論用worktreeを存在保証する（冪等）。
 * 既にworktreeとして存在しても、そのHEADが要求shaと一致している場合のみ再利用する。
 * HEADが取得できない・一致しない場合は `git worktree remove --force` で付け直してから
 * `git worktree add --detach <path> <sha>` で作成する。
 *
 * HEADを検証する理由: 存在チェックだけだと、state が記録するHEADより古いコミットを
 * チェックアウトしたままのworktree（残骸）を再利用し、議論の対象コミットが session を
 * 越えて食い違う（review指摘 #6）。
 *
 * @param {string} workspace
 * @param {string} session
 * @param {string} sha  チェックアウトするコミット
 * @returns {string} 確保済みworktreeの絶対パス
 */
function ensureCouncilWorktree(workspace, session, sha) {
  const dir = councilWorktreeDir(workspace, session);
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (worktreeHead(dir) === sha) return dir;
    worktreeRemove(dir, workspace, { stdio: 'pipe' });
  }
  worktreeAddDetached(dir, sha, workspace);
  return dir;
}

/**
 * 議論用worktreeを片付ける（冪等）。`git worktree remove --force`。
 * 存在しない場合は何もしない。失敗時は throw（呼び出し元が state に記録して
 * orchestrator へ手動片付けを促す）。
 *
 * @param {string} workspace
 * @param {string} session
 */
function removeCouncilWorktree(workspace, session) {
  const dir = councilWorktreeDir(workspace, session);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return;
  }
  worktreeRemove(dir, workspace, { stdio: 'pipe' });
}

module.exports = {
  assertValidSession,
  slugifyTitle,
  councilStatePath,
  councilWorktreeDir,
  councilInvestigationPath,
  resolveSession,
  resolveWorkspaceHead,
  ensureCouncilWorktree,
  removeCouncilWorktree,
};
