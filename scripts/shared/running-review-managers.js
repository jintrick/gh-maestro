'use strict';
// running-review-managers.js
// Review Manager の manager.running を読み取り、OS endpointとinstanceIdの
// 同一性まで確認する共有ヘルパー。
//
// collect-housekeeping-exclusions.js（安全側）と worker-status.js（tolerant）だけで
// なく、start-review-manager.js の二重起動判定・assistant-watch.js の読み取り専用
// 判定も同じ経路を使う。manager.running は旧バージョンが PID だけを書いたファイルを
// 残している可能性があるため、旧形式を「稼働中」と断定することはしない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson } = require('./atomic-write');
const { normalizePid } = require('./worker-entry');
const { reviewArtifactPath } = require('./review-manager-paths');

const STARTING_FILE_NAME = 'manager.starting';

const processLiveness = require('./process-liveness');
let injectedLiveness = null;
function checkerFor(opts = {}) { return opts.liveness || injectedLiveness || processLiveness; }

/**
 * Review Managerの起動中だけ使う予約ファイルのパスを返す。
 *
 * manager.runningはReview Manager本体だけが所有するため、detachしたshimを
 * 起動側が記録することはできない。起動側と本体がmanager.runningへ所有権を
 * 引き渡すまでの短い空白は、隣接する専用予約ファイルで排他する。
 *
 * @param {string} runningPath manager.runningのパス
 * @returns {string}
 */
function reviewManagerStartingPath(runningPath) {
  return path.join(path.dirname(runningPath), STARTING_FILE_NAME);
}

function createStartupToken() {
  return crypto.randomBytes(16).toString('hex');
}

function normalizeStartupMarker({ processRef, token }, checker = checkerFor()) {
  if (typeof processRef !== 'string' || !processRef) throw new Error('Review Manager起動予約の参照が不正です');
  const owner = checker.writeRef({}, processRef);
  if (!owner || normalizePid(owner.pid) === null) throw new Error('Review Manager起動予約のPIDが不正です');
  if (typeof token !== 'string' || token === '') {
    throw new Error('Review Manager起動予約のトークンが不正です');
  }
  return { ...owner, token };
}

function writeStartupMarkerExclusive(startingPath, marker) {
  fs.mkdirSync(path.dirname(startingPath), { recursive: true });
  fs.writeFileSync(startingPath, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
}

/**
 * Review Managerの起動予約を原子的に取得する。
 *
 * 既存manager.runningがまだ無い状態でも、manager.startingのwx作成に成功した
 * 起動だけが先へ進む。既存予約の保持者が生存・同一性一致なら呼び出し元は
 * ALREADY_RUNNINGへ戻り、同一性を確認できない場合はfail-closedで例外にする。
 * stale予約は内容比較付きで回収してから一度だけ再取得を試みる。
 *
 * @param {string} runningPath manager.runningのパス
 * @param {object} [opts]
 * @param {string} [opts.processRef] 予約を作るプロセスの不透明な参照
 * @param {string} [opts.token] 本体へ引き渡すトークン
 * @returns {{acquired:boolean,active?:boolean,error?:Error,path:string,token?:string}}
 */
function acquireReviewManagerStartup(runningPath, opts = {}) {
  const startingPath = reviewManagerStartingPath(runningPath);
  const checker = checkerFor(opts);
  const processRef = opts.processRef || checker.captureSelf();
  if (checker.observe(processRef) !== 'alive') throw new Error('Review Manager起動予約の所有者を確認できません');
  const marker = normalizeStartupMarker({
    processRef,
    token: opts.token || createStartupToken(),
  }, checker);

  try {
    writeStartupMarkerExclusive(startingPath, marker);
    return { acquired: true, path: startingPath, token: marker.token };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  const existing = inspectRunningReviewManager(startingPath, {
    onError: 'skip',
    cleanupStale: true,
    liveness: opts.liveness,
  });
  if (existing.status === 'live' || existing.status === 'legacy-live') {
    return { acquired: false, active: true, path: startingPath };
  }
  if (existing.status === 'error') {
    return { acquired: false, error: existing.error, path: startingPath };
  }

  // stale回収後に別の起動が先に予約を取り直していた場合は、その起動を優先する。
  try {
    writeStartupMarkerExclusive(startingPath, marker);
    return { acquired: true, path: startingPath, token: marker.token };
  } catch (e) {
    if (e.code === 'EEXIST') return { acquired: false, active: true, path: startingPath };
    throw e;
  }
}

/**
 * 起動予約の所有者をdetach shimへ引き渡す。
 * manager.runningは変更せず、予約ファイルだけを更新する。
 *
 * @param {string} runningPath manager.runningのパス
 * @param {string} token 起動側が作成した予約トークン
 * @param {{processRef:string}} owner shimの不透明な参照
 * @returns {{transferred:boolean,missing?:boolean,reason?:string}}
 */
function transferReviewManagerStartup(runningPath, token, owner) {
  const startingPath = reviewManagerStartingPath(runningPath);
  let raw;
  try {
    raw = fs.readFileSync(startingPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { transferred: false, missing: true };
    return { transferred: false, reason: `起動予約の読み取りに失敗しました: ${e.message}` };
  }

  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (e) {
    return { transferred: false, reason: `起動予約の解析に失敗しました: ${e.message}` };
  }
  if (!marker || marker.token !== token) {
    return { transferred: false, reason: '起動予約の所有者が変わりました' };
  }

  let next;
  try {
    next = { ...marker, ...normalizeStartupMarker({ ...owner, token }) };
  } catch (e) {
    return { transferred: false, reason: e.message };
  }

  try {
    atomicWriteJson(startingPath, next);
    return { transferred: true };
  } catch (e) {
    return { transferred: false, reason: `起動予約の引き渡しに失敗しました: ${e.message}` };
  }
}

/**
 * 本体がmanager.runningを書いた後、対応する起動予約だけを解放する。
 *
 * @param {string} runningPath manager.runningのパス
 * @param {string} token 起動側が作成した予約トークン
 * @returns {{released:boolean,missing?:boolean,changed?:boolean,reason?:string}}
 */
function releaseReviewManagerStartup(runningPath, token) {
  const startingPath = reviewManagerStartingPath(runningPath);
  let raw;
  try {
    raw = fs.readFileSync(startingPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { released: true, missing: true };
    return { released: false, reason: `起動予約の読み取りに失敗しました: ${e.message}` };
  }

  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (e) {
    return { released: false, reason: `起動予約の解析に失敗しました: ${e.message}` };
  }
  if (!marker || marker.token !== token) {
    return { released: false, reason: '起動予約の所有者が変わりました' };
  }

  try {
    const cleanup = removeIfUnchanged(startingPath, raw);
    if (cleanup.changed) return { released: false, changed: true, reason: 'record changed' };
    return { released: true, missing: cleanup.disappeared };
  } catch (e) {
    return { released: false, reason: e.message };
  }
}

/**
 * manager.running の内容を解析する。
 *
 * 旧形式は、ファイル全体が正の整数PIDだけのテキストである。新形式は
 * {pid, resourceKey, instanceId} のJSONオブジェクトである。PR1の起動時刻だけの
 * 旧JSONはOS資源参照がなく、process-liveness が持ち主のいない記録（dead）として扱う。
 *
 * @param {string} raw
 * @param {string} [runningPath]
 * @returns {{pid: number, resourceKey: string|null, instanceId: string|null, legacy: boolean, raw: string}}
 * @throws {Error} 形式またはPIDが不正な場合
 */
function parseRunningReviewManagerRecord(raw, runningPath = 'manager.running') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`manager.running の PID が不正です（PID/JSON解析不能）: ${runningPath}`);
  }

  const trimmed = raw.trim();
  // 旧形式は「PIDのみ」に限定する。Number('1e3') のような表記を旧形式として
  // 誤認すると、想定外の内容をプロセス識別子として扱うことになる。
  if (/^[1-9]\d*$/.test(trimmed)) {
    const pid = normalizePid(trimmed);
    if (pid !== null) return { pid, resourceKey: null, instanceId: null, legacy: true, raw };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`manager.running の PID が不正です（PID/JSON解析不能）: ${runningPath}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`manager.running のレコード形式が不正です: ${runningPath}`);
  }

  const pid = normalizePid(parsed.pid);
  if (pid === null) {
    throw new Error(`manager.running の PID が不正です（解析不能）: ${runningPath}`);
  }

  const resourceKey = typeof parsed.resourceKey === 'string' && parsed.resourceKey.trim() !== ''
    ? parsed.resourceKey
    : null;
  const instanceId = typeof parsed.instanceId === 'string' && parsed.instanceId.trim() !== ''
    ? parsed.instanceId
    : null;
  if ((resourceKey === null) !== (instanceId === null)) {
    throw new Error(`manager.running のresource metadataが不正です: ${runningPath}`);
  }
  const startTime = typeof parsed.startTime === 'string' && Number.isFinite(Date.parse(parsed.startTime))
    ? parsed.startTime
    : null;
  return { pid, resourceKey, instanceId, startTime, legacy: resourceKey === null, raw };
}

/**
 * stale と判断したファイルを、判定時に読んだ内容と変わっていない場合だけ削除する。
 *
 * @returns {{removed: boolean, disappeared?: boolean, changed?: boolean}}
 * @throws {Error} 再読込または削除に失敗した場合
 */
function removeIfUnchanged(runningPath, raw) {
  let current;
  try {
    current = fs.readFileSync(runningPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { removed: false, disappeared: true };
    throw new Error(`manager.running の再読み取りに失敗しました: ${runningPath}: ${e.message}`);
  }

  if (current !== raw) return { removed: false, changed: true };

  try {
    fs.unlinkSync(runningPath);
    return { removed: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { removed: false, disappeared: true };
    throw new Error(`manager.running のstaleファイル削除に失敗しました: ${runningPath}: ${e.message}`);
  }
}

function errorResult(message, onError) {
  const error = message instanceof Error ? message : new Error(message);
  if (onError === 'throw') throw error;
  return { status: 'error', error };
}

function finishStale({ runningPath, raw, record, pr, cleanupStale, onError, reason }) {
  if (cleanupStale) {
    let cleanup;
    try {
      cleanup = removeIfUnchanged(runningPath, raw);
    } catch (e) {
      return errorResult(e, onError);
    }
    if (cleanup.changed) {
      return errorResult(
        `manager.running が判定中に置き換えられました（削除を中止）: ${runningPath}`,
        onError
      );
    }
  }

  return {
    status: 'stale',
    pr,
    pid: record.pid,
    resourceKey: record.resourceKey,
    legacy: record.legacy,
    reason,
  };
}

/**
 * 1つの manager.running を解析・生存確認・同一性確認する。
 *
 * @param {string} runningPath
 * @param {object} [opts]
 * @param {string|number} [opts.pr] PR番号。旧形式コールバックへ渡す値
 * @param {'throw'|'skip'} [opts.onError='throw'] エラー時の動作
 * @param {boolean} [opts.cleanupStale=false] staleファイルを内容比較後に削除するか
 * @param {(info:{pr:string|null,pid:number,path:string,legacy:true})=>void} [opts.onLegacyLive]
 * @returns {{status:'missing'|'live'|'legacy-live'|'stale'|'error', pr:string|null, pid?:number, startTime?:string|null, processRef?:string, legacy?:boolean, reason?:string, error?:Error}}
 */
function inspectRunningReviewManager(runningPath, opts = {}) {
  const onError = opts.onError || 'throw';
  const pr = opts.pr == null ? null : String(opts.pr);
  const cleanupStale = opts.cleanupStale === true;

  let raw;
  try {
    raw = fs.readFileSync(runningPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing', pr };
    return errorResult(`manager.running の読み取りに失敗しました: ${runningPath}: ${e.message}`, onError);
  }

  let record;
  try {
    record = parseRunningReviewManagerRecord(raw, runningPath);
  } catch (e) {
    return errorResult(e, onError);
  }

  const checker = checkerFor(opts);
  const state = checker.observe(checker.readRef(record, 'default', { source: runningPath }));
  if (state === 'unknown') {
    return errorResult(`manager.running の生死を判定できません: ${runningPath}`, onError);
  }
  if (state === 'dead') {
    return finishStale({ runningPath, raw, record, pr, cleanupStale, onError, reason: 'process not alive or identity mismatch' });
  }
  return {
    status: 'live', pr, pid: record.pid, resourceKey: record.resourceKey, instanceId: record.instanceId, startTime: record.startTime,
    processRef: checker.readRef(record), legacy: false,
  };

}

/**
 * manager.running を新形式で原子的に書き出す。
 * resourceKey は決定論的OS endpointを指し、instanceIdは起動世代を識別する。
 *
 * @param {string} runningPath
 * @param {string|{processRef:string}} record
 * @returns {string}
 */
function writeRunningReviewManager(runningPath, record) {
  const processRef = typeof record === 'string' ? record : record && record.processRef;
  if (typeof processRef !== 'string' || !processRef) throw new Error(`manager.running の参照が不正です: ${runningPath}`);
  const checker = checkerFor();
  if (checker.observe(processRef) !== 'alive') throw new Error(`manager.running の所有者を確認できません: ${runningPath}`);
  const metadata = record && typeof record === 'object' && typeof record.startTime === 'string'
    ? { startTime: record.startTime }
    : {};
  atomicWriteJson(runningPath, checker.writeRef(metadata, processRef));
  return runningPath;
}

/**
 * 指定した所有者の manager.running だけを、内容比較後に削除する。
 *
 * @param {string} runningPath
 * @param {{processRef:string}} owner
 * @returns {{released:boolean,missing?:boolean,changed?:boolean,reason?:string}}
 */
function removeRunningReviewManagerIfOwned(runningPath, owner) {
  const processRef = typeof owner === 'string' ? owner : owner && owner.processRef;
  if (typeof processRef !== 'string' || !processRef) return { released: false, reason: 'owner reference unavailable' };

  let raw;
  try {
    raw = fs.readFileSync(runningPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { released: true, missing: true };
    return { released: false, reason: `read failed: ${e.message}` };
  }

  let record;
  try {
    record = parseRunningReviewManagerRecord(raw, runningPath);
  } catch (e) {
    return { released: false, reason: e.message };
  }
  const checker = checkerFor();
  if (!checker.sameRef(processRef, checker.readRef(record))) {
    return { released: false, reason: 'different process identity' };
  }

  try {
    const cleanup = removeIfUnchanged(runningPath, raw);
    if (cleanup.changed) return { released: false, changed: true, reason: 'record changed' };
    return { released: true, missing: cleanup.disappeared };
  } catch (e) {
    return { released: false, reason: e.message };
  }
}

/**
 * records/pr/<PR>/review/manager.running を走査し、同一性確認済みの Review Manager を列挙する。
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {'throw'|'skip'} [opts.onError='throw'] 不正値・読み取り不能時の挙動
 * @param {boolean} [opts.cleanupStale=false] staleファイルを回収するか
 * @param {(info:object)=>void} [opts.onLegacyLive] 旧形式の生存PIDを当該PRの保護対象として通知
 * @returns {Array<{pr:string,pid:number,startTime:string}>}
 */
function listRunningReviewManagers(workspace, opts = {}) {
  const onError = opts.onError || 'throw';
  const ghDir = path.join(workspace, '.gh-maestro');
  const prDir = path.join(ghDir, 'records', 'pr');
  if (!fs.existsSync(prDir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(prDir, { withFileTypes: true });
  } catch (e) {
    if (onError === 'throw') {
      throw new Error(`records/pr の走査に失敗しました: ${prDir}: ${e.message}`);
    }
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const runningPath = reviewArtifactPath(workspace, entry.name, '.running');
    const inspection = inspectRunningReviewManager(runningPath, {
      ...opts,
      pr: entry.name,
      onError,
    });
    if (inspection.status === 'live') {
      results.push({ pr: entry.name, pid: inspection.pid, startTime: inspection.startTime });
    }
  }

  return results;
}

module.exports = {
  parseRunningReviewManagerRecord,
  inspectRunningReviewManager,
  listRunningReviewManagers,
  writeRunningReviewManager,
  removeRunningReviewManagerIfOwned,
  reviewManagerStartingPath,
  acquireReviewManagerStartup,
  transferReviewManagerStartup,
  releaseReviewManagerStartup,
  _setLiveness: (value) => { injectedLiveness = value; },
};
