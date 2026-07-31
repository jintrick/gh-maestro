'use strict';
// read-state.js — メッセージ既読状態（.gh-maestro/msg-state/<self>.json）の共有管理モジュール
//
// 背景（Issue #207）: 既読の正本を時刻カーソル（since）ではなく、
// 「実際に確認し既読として確定したコメントIDの集合」にする。本モジュールは
// その状態の読み書き・ロック・原子更新・初期化を集約し、複数の呼び出し元
// （msg-poll.js / spawn-worker.js / reset-session.js）で同じ更新APIを使う。
//
// 責務:
//   - v2スキーマ（{ schemaVersion, initialized, generation, readByIssue, sinceByIssue }）の読み書き
//   - 欠落(missing)/破損(corrupt)/旧形式v1(legacy)/正常(ok) の判別
//     （暗黙の空状態生成はしない。欠落・破損は呼び出し元が「明示初期化が必要」と報告する）
//   - ロック下での「再読込 → 集合和 → 原子的保存」による冪等な既読追加（markRead / markReadMany）
//   - 初期化（initializeState）— reset / 初回初期化の共通入口
//
// ビジネスロジック（gh呼び出し・マーカーパース等）は持たない。各呼び出し元が実装する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { isProcessAlive } = require('../process-lifecycle');

const SCHEMA_VERSION = 2;

/**
 * 状態ファイルのパスを返す。
 * @param {string} workspace
 * @param {string} self
 * @returns {string}
 */
function statePath(workspace, self) {
  return path.join(workspace, '.gh-maestro', 'msg-state', `${self}.json`);
}

/**
 * v2 の空状態を作る（呼び出し元が明示的に初期化する場合のみ使用）。
 * @param {string} [generation]
 * @returns {object}
 */
function emptyState(generation = '') {
  return {
    schemaVersion: SCHEMA_VERSION,
    initialized: true,
    generation,
    readByIssue: {},
    sinceByIssue: {},
  };
}

/**
 * v2 状態を正規化して返す。破損値（配列でないreadByIssue等）は安全に空に落とす。
 * @param {object} parsed
 * @returns {object}
 */
function normalize(parsed) {
  const readByIssue = {};
  if (parsed.readByIssue && typeof parsed.readByIssue === 'object' && !Array.isArray(parsed.readByIssue)) {
    for (const [issue, ids] of Object.entries(parsed.readByIssue)) {
      readByIssue[issue] = Array.isArray(ids)
        ? ids.filter((x) => typeof x === 'number' && Number.isFinite(x))
        : [];
    }
  }
  const sinceByIssue = {};
  if (parsed.sinceByIssue && typeof parsed.sinceByIssue === 'object' && !Array.isArray(parsed.sinceByIssue)) {
    for (const [issue, ts] of Object.entries(parsed.sinceByIssue)) {
      if (typeof ts === 'string') sinceByIssue[issue] = ts;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    initialized: true,
    generation: typeof parsed.generation === 'string' ? parsed.generation : '',
    readByIssue,
    sinceByIssue,
  };
}

/**
 * 状態を読み取る。
 *
 * @param {string} workspace
 * @param {string} self
 * @returns {{ status: 'ok', state: object } | { status: 'missing', state: null }
 *           | { status: 'corrupt', state: null } | { status: 'legacy', state: object|null }}
 *   - ok:      v2 かつ initialized=true
 *   - missing: ファイルが存在しない
 *   - corrupt: JSON破損・非オブジェクト・未知スキーマ（initializedフラグ無しの不明形式）
 *   - legacy:  v1（since/seenIds を持つ旧形式）。移行（明示再ベースライン）が必要。
 *              state には旧形式の生パースを返す（呼び出し元が seenIds を引き継げる）
 */
function readState(workspace, self) {
  const sp = statePath(workspace, self);
  let raw;
  try {
    if (!fs.existsSync(sp)) return { status: 'missing', state: null };
    raw = fs.readFileSync(sp, 'utf8');
  } catch {
    return { status: 'corrupt', state: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', state: null };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'corrupt', state: null };
  }

  if (parsed.schemaVersion === SCHEMA_VERSION && parsed.initialized === true) {
    return { status: 'ok', state: normalize(parsed) };
  }

  // v1（since / seenIds）の旧形式。生パースを返す（呼び出し元が seenIds 等を引き継げる）
  if (parsed.since != null || Array.isArray(parsed.seenIds)) {
    return { status: 'legacy', state: parsed };
  }

  // それ以外の未知スキーマは破損扱い（フェイルクローズ）
  return { status: 'corrupt', state: null };
}

/**
 * 状態を原子的に永続化する（tmp書き込み + rename）。
 * 件数切り捨ては行わない（既読IDは正本として無期限に保持する。Issue #207）。
 *
 * @param {string} workspace
 * @param {string} self
 * @param {object} state
 */
function writeState(workspace, self, state) {
  const sp = statePath(workspace, self);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const tmp = `${sp}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, sp);
}

/**
 * msg-state の更新ロックのパス。
 * @param {string} workspace
 * @param {string} self
 * @returns {string}
 */
function stateLockPath(workspace, self) {
  return path.join(workspace, '.gh-maestro', 'locks', `read-state-${self}.lock`);
}

/**
 * msg-state の更新ロックを取得する。
 *
 * worker-lease.js の per-key ロックと同型の pid ファイルロック。
 * 保持者は生存している間だけロックを保持し、更新処理はミリ秒オーダーで解放する
 * 過渡ロックのため、起動ロック（acquireStartupLock）のような WMI を伴う startTime
 * 同一性確認までは行わない（WMI は毎回 PowerShell を起動し ~2秒かかり、markRead を
 * ポーリング毎に呼ぶ運用では許容できない）。複数プロセス（msg-poll / spawn-worker /
 * reset）が同じ self の状態を排他更新できる。
 *
 * @param {string} workspace
 * @param {string} self
 * @returns {boolean}
 */
function acquireStateLock(workspace, self) {
  const lp = stateLockPath(workspace, self);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  for (let i = 0; i < 5; i++) {
    try {
      fs.writeFileSync(lp, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holderPid = null;
    try {
      holderPid = parseInt(fs.readFileSync(lp, 'utf8').trim(), 10);
    } catch {
      holderPid = null;
    }
    if (holderPid && Number.isFinite(holderPid) && holderPid > 0 && isProcessAlive(holderPid)) {
      // 生存中の保持者がいる → 取得失敗
      return false;
    }
    // stale ロック（保持者が非生存・壊れている）→ 奪取して再試行
    try { fs.unlinkSync(lp); } catch {}
  }
  return false;
}

/**
 * 自プロセスが保持する msg-state 更新ロックを解放する。
 * 自分が保持者でない場合は何もしない（他プロセスのロックを誤って消さない）。
 * @param {string} workspace
 * @param {string} self
 */
function releaseStateLock(workspace, self) {
  const lp = stateLockPath(workspace, self);
  try {
    const holder = parseInt(fs.readFileSync(lp, 'utf8').trim(), 10);
    if (holder === process.pid) fs.unlinkSync(lp);
  } catch {
    // 読めない・存在しない → 何もしない
  }
}

/**
 * ロック下で状態を読み、ok でなければ失敗を返す（暗黙の空状態生成はしない）。
 * @param {string} workspace
 * @param {string} self
 * @returns {{ ok: true, state: object } | { ok: false, error: string }}
 */
function requireInitialized(workspace, self) {
  const current = readState(workspace, self);
  if (current.status !== 'ok') {
    return {
      ok: false,
      error: `msg-state(${self}) が ${current.status} のため更新できません（初期化が必要です）`,
    };
  }
  return { ok: true, state: current.state };
}

/**
 * 複数 Issue の既読IDを一度のロック区間で集合和して原子的に保存する。
 *
 * 各書込みは必ず「ロック取得 → 最新状態を再読込 → 集合和 → 原子的保存」で行う。
 * これにより、古い状態を後書きして他者（ベースライン等）の更新を消す競合を防ぐ。
 * 既に読まれているIDの再登録は無害（冪等）。IDはGitHub全体で一意のため、
 * 別IssueのIDが混入しても照合に影響しない。
 *
 * @param {string} workspace
 * @param {string} self
 * @param {{ byIssue?: object, sinceByIssue?: object }} params
 *   byIssue:      { [issue: string]: number[] } — 既読として追加するID
 *   sinceByIssue: { [issue: string]: string }   — 診断用タイムスタンプ（既読判定には使わない）
 * @returns {{ ok: boolean, error?: string, state?: object }}
 */
function markReadMany(workspace, self, { byIssue = {}, sinceByIssue = {} } = {}) {
  const clean = {};
  let hasIds = false;
  for (const [issue, ids] of Object.entries(byIssue)) {
    const cleanIds = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'number' && Number.isFinite(x));
    if (cleanIds.length > 0) {
      clean[String(issue)] = cleanIds;
      hasIds = true;
    }
  }
  const cleanSince = {};
  for (const [issue, ts] of Object.entries(sinceByIssue)) {
    if (typeof ts === 'string' && ts) cleanSince[String(issue)] = ts;
  }
  if (!hasIds && Object.keys(cleanSince).length === 0) {
    return { ok: true, state: null }; // 変更なし
  }

  const lockAcquired = acquireStateLock(workspace, self);
  if (!lockAcquired) {
    return { ok: false, error: `msg-state(${self}) の更新ロックを取得できませんでした` };
  }

  try {
    const current = readState(workspace, self);
    if (current.status !== 'ok') {
      return {
        ok: false,
        error: `msg-state(${self}) が ${current.status} のため既読追加できません（初期化が必要です）`,
      };
    }

    let dirty = false;
    const readByIssue = current.state.readByIssue;
    for (const [issue, ids] of Object.entries(clean)) {
      const existing = readByIssue[issue] || [];
      const seen = new Set(existing);
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          dirty = true;
        }
      }
      if (seen.size !== existing.length) readByIssue[issue] = [...seen];
    }
    if (!dirty && Object.keys(cleanSince).length === 0) {
      return { ok: true, state: current.state };
    }
    if (!dirty && Object.keys(cleanSince).length > 0) {
      // ID変更なし・診断タイムスタンプのみ更新
      current.state.sinceByIssue = { ...(current.state.sinceByIssue || {}), ...cleanSince };
      writeState(workspace, self, current.state);
      return { ok: true, state: current.state };
    }
    if (Object.keys(cleanSince).length > 0) {
      current.state.sinceByIssue = { ...(current.state.sinceByIssue || {}), ...cleanSince };
    }
    writeState(workspace, self, current.state);
    return { ok: true, state: current.state };
  } finally {
    releaseStateLock(workspace, self);
  }
}

/**
 * 単一 Issue の既読IDを追加する（markReadMany の薄いラッパー）。
 *
 * @param {string} workspace
 * @param {string} self
 * @param {{ issue: string|number, ids: number[] }} params
 * @returns {{ ok: boolean, error?: string, state?: object }}
 */
function markRead(workspace, self, { issue, ids }) {
  return markReadMany(workspace, self, { byIssue: { [String(issue)]: ids } });
}

/**
 * 状態を明示的に初期化（全置換）する。reset / 初回初期化の共通入口。
 *
 * 新状態（initialized=true・generation・readByIssue）を一時ファイルに構築し、
 * 原子的に置換する。呼び出し元は「スナップショット取得の全件成功」を確認した上で
 * 呼ぶこと（一部失敗なら呼ばず、空状態で再開しない）。byIssue が空でも initialized=true。
 *
 * @param {string} workspace
 * @param {string} self
 * @param {{ byIssue?: object, generation?: string }} params
 * @returns {{ ok: boolean, error?: string, state?: object }}
 */
function initializeState(workspace, self, { byIssue = {}, generation = '' } = {}) {
  const lockAcquired = acquireStateLock(workspace, self);
  if (!lockAcquired) {
    return { ok: false, error: `msg-state(${self}) の初期化ロックを取得できませんでした` };
  }

  try {
    const readByIssue = {};
    for (const [issue, ids] of Object.entries(byIssue)) {
      readByIssue[String(issue)] = (Array.isArray(ids) ? ids : [])
        .filter((x) => typeof x === 'number' && Number.isFinite(x));
    }
    const state = emptyState(typeof generation === 'string' ? generation : '');
    state.readByIssue = readByIssue;
    writeState(workspace, self, state);
    return { ok: true, state };
  } finally {
    releaseStateLock(workspace, self);
  }
}

module.exports = {
  SCHEMA_VERSION,
  statePath,
  stateLockPath,
  emptyState,
  normalize,
  readState,
  writeState,
  acquireStateLock,
  releaseStateLock,
  requireInitialized,
  markRead,
  markReadMany,
  initializeState,
};
