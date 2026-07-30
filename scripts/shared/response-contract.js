'use strict';
// response-contract.js — 応答契約の読み書きを担当する共有モジュール
//
// 責務:
//   契約ファイル（.gh-maestro/inbox-supervisor/contracts/<workerName>.json）の
//   読み書きと削除。契約のビジネスロジック（充足判定）は持たない（それは worker-exit-hook.js の責務）。
//   契約のライフサイクル管理（いつクリアするか）も持たない（それは inbox-supervisor.js の責務）。
//
// 契約型:
//   message-required（既定）: msg-send.js による明示的返信のみで充足
//   artifact-or-message:      指定成果物（PR）の成立または msg-send.js 返信で充足
//
// 契約ファイルの有効期限チェックは行わない。契約のライフサイクルは呼び出し側が確定的な
// 終着点で clearContract() を呼ぶことで管理する（stale expiration ガードは不要）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');

// ── 定数 ──────────────────────────────────────────────────────────────────

const CONTRACT_TYPES = Object.freeze({
  MESSAGE_REQUIRED: 'message-required',
  ARTIFACT_OR_MESSAGE: 'artifact-or-message',
});

// ── パス計算 ──────────────────────────────────────────────────────────────

/**
 * 契約ディレクトリのパスを返す。
 * @param {string} workspace
 * @returns {string}
 */
function contractDir(workspace) {
  return path.join(workspace, '.gh-maestro', 'inbox-supervisor', 'contracts');
}

/**
 * 特定ワーカーの契約ファイルパスを返す。
 * @param {string} workspace
 * @param {string} workerName
 * @returns {string}
 */
function contractPath(workspace, workerName) {
  return path.join(contractDir(workspace), `${workerName}.json`);
}

// ── 操作 ──────────────────────────────────────────────────────────────────

/**
 * 契約をファイルに書き込む。
 * ディレクトリが存在しない場合は自動作成する。
 * アトミック書き込み（tmp → rename）で破損を防ぐ。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @param {object} contract - { type: string, artifact?: string, issue?: number|string }
 */
function writeContract(workspace, workerName, contract) {
  const dir = contractDir(workspace);
  fs.mkdirSync(dir, { recursive: true });

  const cp = contractPath(workspace, workerName);
  const tmp = cp + '.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(contract, null, 2), 'utf8');
  fs.renameSync(tmp, cp);
}

/**
 * 契約ファイルを読み込む。
 * ファイルが存在しない・壊れている場合は null を返す。
 * 有効期限チェックは行わない。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @returns {object|null}
 */
function readContract(workspace, workerName) {
  const cp = contractPath(workspace, workerName);
  try {
    if (!fs.existsSync(cp)) return null;
    const raw = fs.readFileSync(cp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!parsed.type || typeof parsed.type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 契約ファイルを削除する（消費）。
 * ファイルが存在しない場合は何もしない（冪等）。
 *
 * @param {string} workspace
 * @param {string} workerName
 */
function clearContract(workspace, workerName) {
  const cp = contractPath(workspace, workerName);
  try {
    if (fs.existsSync(cp)) fs.unlinkSync(cp);
  } catch {
    // 削除失敗は無視（次回の writeContract で上書きされる）
  }
}

module.exports = {
  CONTRACT_TYPES,
  contractDir,
  contractPath,
  writeContract,
  readContract,
  clearContract,
};
