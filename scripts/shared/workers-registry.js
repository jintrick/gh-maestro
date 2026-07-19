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

/**
 * 〈issue番号 + skill（役割）〉から workerName を解決する。
 *
 * orchestrator が workerName という文字列を記憶せず、意識している情報（対象Issue番号と
 * 役割）だけでワーカーを指せるようにするための逆引き。真の記録は workers.json であり、
 * orchestrator のLLM文脈記憶に依存しない。
 *
 * 一意に決まる場合だけ workerName を返す。0件・複数件は解決不能として Error を投げる
 * （複数件時はメッセージに候補 workerName を列挙する。曖昧な場合は呼び出し元が
 * --worker-name で明示する運用）。
 *
 * @param {string} workspace
 * @param {{issue: string|number, skill: string}} criteria
 * @returns {string} 一意に決まった workerName
 * @throws {Error} 該当0件、または複数件で一意に決まらない場合
 */
function resolveWorkerName(workspace, { issue, skill }) {
  if (issue == null || issue === '') throw new Error('resolveWorkerName: issue が必要です');
  if (!skill) throw new Error('resolveWorkerName: skill が必要です');

  const raw = readWorkersRaw(workspace);
  if (!raw) throw new Error(`workers.json を読み込めません（${workspace}）`);

  const wantIssue = Number(issue);
  const matches = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (name === 'orchestrator') continue;
    const normalized = normalizeWorkerEntry(entry);
    if (normalized.issue === wantIssue && normalized.skill === skill) {
      matches.push(name);
    }
  }

  if (matches.length === 0) {
    throw new Error(`該当するワーカーが見つかりません（issue=${wantIssue}, skill=${skill}）。既に削除済みか、まだ起動していない可能性があります。`);
  }
  if (matches.length > 1) {
    throw new Error(
      `issue=${wantIssue}, skill=${skill} に複数のワーカーが該当し一意に決まりません。` +
      `--worker-name で明示してください。候補: ${matches.join(', ')}`
    );
  }
  return matches[0];
}

module.exports = {
  workersJsonPath,
  readWorkersRaw,
  updateWorkerPaneId,
  getOrchestratorPaneId,
  resolveWorkerName,
};
