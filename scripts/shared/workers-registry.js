'use strict';
// workers-registry.js — workers.json への書き込みヘルパー
//
// inbox-supervisor.js は元々 workers.json を読み取り専用で扱っていたが（loadWorkers()）、
// resumeによるプロセス再起動後は新しいpid/startTimeを書き戻す必要がある。
// spawn-worker.js の新規登録とは異なり、既存エントリのプロセス識別フィールドのみを
// 更新する用途に絞った、最小限の共有ヘルパー。

const fs = require('fs');
const path = require('path');
const { normalizeWorkerEntry, normalizePid } = require('../worker-entry');

/**
 * workspace の workers.json パスを返す。
 * @param {string} workspace
 * @returns {string}
 */
function workersJsonPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'workers.json');
}

/**
 * 既定のスリープ: Atomics.wait による同期的な短時間待機。
 * @param {number} ms
 */
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * workers.json を読み込む。存在しない・全試行でparse失敗の場合は null を返す。
 *
 * JSON.parse 失敗は、別プロセス（spawn-worker.js等）が書き込み中で、tmp→rename
 * アトミック書き込みの最中に部分内容を読んだ場合に起こりうる。書き込み完了を待って
 * 短いリトライを行い、書き込み中の読み取りで保護ロジック全体が無効化される事態を
 * 防ぐ（Issue #248 項目12）。ファイル自体の不在・型不正（配列等）はリトライしない。
 *
 * @param {string} workspace
 * @param {{readFileFn?: (p: string) => string, sleepFn?: (ms: number) => void, maxAttempts?: number, delayMs?: number}} [opts]
 *   テスト容易性のための注入点。既定は fs.readFileSync と Atomics.wait。
 * @returns {object|null}
 */
function readWorkersRaw(workspace, {
  readFileFn = (p) => fs.readFileSync(p, 'utf8'),
  sleepFn = defaultSleep,
  maxAttempts = 5,
  delayMs = 20,
} = {}) {
  const p = workersJsonPath(workspace);
  if (!fs.existsSync(p)) return null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = JSON.parse(readFileFn(p));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      return raw;
    } catch {
      if (attempt < maxAttempts) sleepFn(delayMs);
    }
  }
  return null;
}

/**
 * 既存workerエントリのプロセス識別フィールド（pid/startTime/logPath）を更新する。
 * アトミック書き込み（tmp → rename）。
 * workerNameのエントリが存在しない場合は何もせずfalseを返す。
 *
 * resume でワーカーを再起動したときに呼ぶ。移行前セッションが残した paneId は
 * ここで消す——新しいプロセスが起きた以上、古いペインIDは掃除経路にとっても
 * 誤った対象であり、残すと無関係なペインをkillしうる。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @param {{pid: number, startTime: string|null, logPath: string|null}} process
 * @returns {boolean} 更新に成功したか
 */
function updateWorkerProcess(workspace, workerName, { pid, startTime = null, logPath = null }) {
  const p = workersJsonPath(workspace);
  const raw = readWorkersRaw(workspace);
  if (!raw || !(workerName in raw)) return false;

  const entry = normalizeWorkerEntry(raw[workerName]);
  entry.pid = normalizePid(pid);
  entry.startTime = startTime;
  entry.logPath = logPath ?? entry.logPath;
  entry.paneId = null;
  raw[workerName] = entry;

  const tmp = p + '.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return true;
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
  updateWorkerProcess,
  resolveWorkerName,
};
