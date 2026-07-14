'use strict';
// workers-registry.js — workers.json への書き込みヘルパー
//
// inbox-supervisor.js は元々 workers.json を読み取り専用で扱っていたが（loadWorkers()）、
// resumeによるペイン再作成後は新しいpaneIdを書き戻す必要がある。
// spawn-worker.js の新規登録とは異なり、既存エントリの一部フィールド（paneId）のみを
// 更新する用途に絞った、最小限の共有ヘルパー。

const fs = require('fs');
const path = require('path');
const { normalizeWorkerEntry } = require('../worker-entry');

/**
 * workspace の workers.json パスを返す。
 * @param {string} workspace
 * @returns {string}
 */
function workersJsonPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'workers.json');
}

/**
 * workers.json を読み込む。存在しない・parse失敗の場合は null を返す。
 * @param {string} workspace
 * @returns {object|null}
 */
function readWorkersRaw(workspace) {
  const p = workersJsonPath(workspace);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * 既存workerエントリのpaneIdのみを更新する。アトミック書き込み（tmp → rename）。
 * workerNameのエントリが存在しない場合は何もせずfalseを返す。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @param {string} newPaneId
 * @returns {boolean} 更新に成功したか
 */
function updateWorkerPaneId(workspace, workerName, newPaneId) {
  const p = workersJsonPath(workspace);
  const raw = readWorkersRaw(workspace);
  if (!raw || !(workerName in raw)) return false;

  const entry = normalizeWorkerEntry(raw[workerName]);
  entry.paneId = String(newPaneId);
  raw[workerName] = entry;

  const tmp = p + '.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return true;
}

/**
 * orchestratorのpaneIdを返す（split元のフォールバック用）。存在しなければnull。
 * @param {string} workspace
 * @returns {string|null}
 */
function getOrchestratorPaneId(workspace) {
  const raw = readWorkersRaw(workspace);
  if (!raw || !raw.orchestrator) return null;
  return normalizeWorkerEntry(raw.orchestrator).paneId;
}

module.exports = {
  workersJsonPath,
  readWorkersRaw,
  updateWorkerPaneId,
  getOrchestratorPaneId,
};
