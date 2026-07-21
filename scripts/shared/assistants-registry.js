'use strict';
// assistants-registry.js — .gh-maestro/assistants.json（issue番号 → assistant pane情報）の読み書き。
//
// workers.json とは意図的に別ファイルにする。assistant はオーケストレーターの管理対象外の
// ワーカーであり（spawn-worker.js のstale pruning・reset-session.jsのworkers.json起点のkillの
// 対象に含めないため）、同じファイルに混ぜない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const { resolve, dirname } = require('path');

function assistantsPath(workspace) {
  return resolve(workspace, '.gh-maestro', 'assistants.json');
}

/**
 * assistants.json を安全に読み込む。存在しない・壊れている場合は空オブジェクトとして扱う
 * （workers.json 読み込み時の既存パターンと同様、フェイルクローズせず空として継続する）。
 * @param {string} workspace
 * @returns {object}
 */
function loadAssistants(workspace) {
  const p = assistantsPath(workspace);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function saveAssistants(workspace, data) {
  const p = assistantsPath(workspace);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * @param {string} workspace
 * @param {string|number} issue
 * @returns {{paneId: string, launchedAt: string}|null}
 */
function getAssistant(workspace, issue) {
  const data = loadAssistants(workspace);
  return data[String(issue)] ?? null;
}

/**
 * @param {string} workspace
 * @param {string|number} issue
 * @param {{paneId: string, launchedAt: string}} entry
 */
function setAssistant(workspace, issue, entry) {
  const data = loadAssistants(workspace);
  data[String(issue)] = entry;
  saveAssistants(workspace, data);
}

/**
 * @param {string} workspace
 * @param {string|number} issue
 * @returns {boolean} エントリが存在していたか
 */
function removeAssistant(workspace, issue) {
  const data = loadAssistants(workspace);
  const key = String(issue);
  const existed = key in data;
  delete data[key];
  saveAssistants(workspace, data);
  return existed;
}

module.exports = { assistantsPath, loadAssistants, saveAssistants, getAssistant, setAssistant, removeAssistant };
