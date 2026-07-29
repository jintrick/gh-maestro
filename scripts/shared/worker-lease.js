'use strict';
// worker-lease.js — ワーカー起動の排他制御（lease/liveness層）
//
// 責務:
//   ワーカー起動時の重複起動防止を、生存確認に基づくリース（lease）で実現する。
//   リース保存先（lease store）を抽象化し、通常ワーカー用アダプタと将来の
//   Review Manager `.running` 契約用アダプタの両方を持てる設計。
//
// Phase 2（本ファイル初版）:
//   - 通常ワーカー用 lease store（.gh-maestro/leases/<key>.json）
//   - リース獲得（live lease 拒否 / stale lease 回収 / 原子作成）
//   - リース解放・アクティベート
//
// Phase 4（将来、本PR対象外）:
//   - Review Manager 用 lease store adapter（.running ファイルをラップ）
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const path = require('path');
const fs = require('fs');
const { isProcessAlive, verifyProcessIdentity, getProcessStartTime } = require('../process-lifecycle');

// テストで注入可能にする（実プロセスに触れない。test-process-spawn-safety ルール準拠）。
let _isProcessAlive = isProcessAlive;
let _verifyProcessIdentity = verifyProcessIdentity;
let _getProcessStartTime = getProcessStartTime;

// ── Lease Store 抽象 ───────────────────────────────────────────────────────────
//
// Lease store は以下のインターフェースを持つプレーンオブジェクト:
//   read(key)    → entry|null  リースエントリを読み取る
//   write(key, entry) → void   原子的に新規作成（EEXIST で競合検知）
//   update(key, entry) → void  既存エントリを上書き
//   remove(key)  → void        リースを削除
//
// entry 形式: { pid, startTime, workerName, createdAt }

/**
 * 通常ワーカー用の lease store を作成する。
 * .gh-maestro/leases/<key>.json を 1 ファイル 1 リースで管理する。
 *
 * workers.json（resume台帳）とは責務を分離し、排他制御に専念する。
 *
 * @param {string} workspace ワークスペース絶対パス
 * @returns {object} lease store
 */
function createNormalWorkerStore(workspace) {
  const dir = path.join(workspace, '.gh-maestro', 'leases');

  function filePath(key) {
    return path.join(dir, `${key}.json`);
  }

  return {
    /** リースエントリを読み取る。存在しない・破損時は null。 */
    read(key) {
      const fp = filePath(key);
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        const entry = JSON.parse(raw);
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
        return entry;
      } catch {
        return null;
      }
    },

    /** 原子的に新規作成する。既存の場合は EEXIST を投げる。 */
    write(key, entry) {
      fs.mkdirSync(dir, { recursive: true });
      const fp = filePath(key);
      fs.writeFileSync(fp, JSON.stringify(entry, null, 2), { encoding: 'utf8', flag: 'wx' });
    },

    /** 既存エントリを上書きする。存在しなくても新規作成（排他不要の更新用）。 */
    update(key, entry) {
      fs.mkdirSync(dir, { recursive: true });
      const fp = filePath(key);
      fs.writeFileSync(fp, JSON.stringify(entry, null, 2), 'utf8');
    },

    /** リースを削除する。 */
    remove(key) {
      const fp = filePath(key);
      try {
        fs.unlinkSync(fp);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },
  };
}

// ── 生存確認 ──────────────────────────────────────────────────────────────────

/**
 * リースエントリが指すプロセスが稼働中か判定する。
 *
 * PID の生存だけでは不十分で、startTime が記録されている場合は同一性も確認する
 * （PID再利用による誤判定を防ぐ。process-lifecycle-scripts.md ルール準拠）。
 *
 * @param {object|null} entry リースエントリ
 * @returns {boolean}
 */
function isLeaseLive(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const pid = typeof entry.pid === 'number' && Number.isFinite(entry.pid) && entry.pid > 0
    ? entry.pid
    : null;
  if (!pid) return false;

  if (!_isProcessAlive(pid)) return false;

  // startTime が記録されていれば同一性を確認（PID再利用対策）
  if (typeof entry.startTime === 'string' && entry.startTime) {
    const result = _verifyProcessIdentity(pid, { startTime: entry.startTime });
    if (!result.match) return false;
  }

  return true;
}

// ── リース操作 ────────────────────────────────────────────────────────────────

/**
 * リースを獲得する。
 *
 * 処理順序（worktree の除去・再作成より先に行う）:
 *   1. 既存リースを読み取る
 *   2. live lease があれば明示的に拒否（エラーを throw）
 *   3. stale lease なら回収（削除）してから新規作成
 *   4. リースがなければ原子的に新規作成（wx フラグで競合防止）
 *
 * 作成されたリースエントリの pid は起動元（launcher）のPID。
 * ワーカー起動後に activateLease() で実際のワーカーPIDに更新する。
 *
 * @param {object} store lease store
 * @param {string} key リースキー（workerName）
 * @param {object} opt
 * @param {number} opt.pid 起動元（launcher）のPID
 * @param {string|null} opt.startTime 起動元のプロセス起動時刻
 * @param {string} opt.workerName ワーカー名（エラーメッセージ用）
 * @returns {{ acquired: true, staleReclaimed: boolean }}
 * @throws {Error} live lease が存在する場合
 */
function acquireLease(store, key, { pid, startTime, workerName }) {
  const existing = store.read(key);

  if (existing && isLeaseLive(existing)) {
    throw new Error(
      `worker "${workerName}" は既に稼働中です（pid ${existing.pid}）。` +
      `重複起動できません。前のワーカーが終了するまでお待ちください。`
    );
  }

  // stale lease があれば回収
  const staleReclaimed = !!existing;
  if (existing) {
    store.remove(key);
  }

  const now = new Date().toISOString();
  const entry = {
    pid,
    startTime: startTime || _getProcessStartTime(pid) || now,
    workerName,
    createdAt: now,
  };

  try {
    store.write(key, entry);
    return { acquired: true, staleReclaimed };
  } catch (e) {
    if (e.code === 'EEXIST') {
      // TOCTOU 競合: read と write の間に別プロセスが同じキーで lease を作成した。
      // 競合エントリを再確認し、live なら拒否、stale なら再回収してリトライ。
      const raced = store.read(key);
      if (raced && isLeaseLive(raced)) {
        throw new Error(
          `worker "${workerName}" は別プロセスによって起動されました（pid ${raced.pid}）。` +
          `重複起動できません。`
        );
      }
      // 競合エントリが stale → 回収してリトライ（1回のみ）
      store.remove(key);
      store.write(key, entry);
      return { acquired: true, staleReclaimed: true };
    }
    throw e;
  }
}

/**
 * リースを解放する。
 * 自プロセスが所有者の場合のみ削除し、他プロセスのリースは触らない。
 *
 * @param {object} store lease store
 * @param {string} key リースキー
 * @param {object} opt
 * @param {number} opt.pid 解放を試みるプロセスのPID
 */
function releaseLease(store, key, { pid }) {
  const existing = store.read(key);
  if (!existing) return;

  // 自プロセスのリースだけを解放（他プロセスのリースを誤って消さない）
  if (existing.pid === pid) {
    store.remove(key);
  }
}

/**
 * リースを実際のワーカーPIDでアクティベートする。
 *
 * 起動元（launcher）のPIDで予約したリースを、実際に起動したワーカープロセスの
 * PID・startTime で更新する。ワーカー起動確認後に呼ぶ。
 *
 * @param {object} store lease store
 * @param {string} key リースキー
 * @param {object} opt
 * @param {number} opt.pid ワーカープロセスのPID
 * @param {string|null} opt.startTime ワーカープロセスの起動時刻
 */
function activateLease(store, key, { pid, startTime }) {
  const existing = store.read(key);
  if (!existing) return; // 何らかの理由でリースが消えている → 何もしない

  const now = new Date().toISOString();
  store.update(key, {
    ...existing,
    pid,
    startTime: startTime || _getProcessStartTime(pid) || now,
  });
}

module.exports = {
  createNormalWorkerStore,
  acquireLease,
  releaseLease,
  activateLease,
  isLeaseLive,
  // テスト用注入（test-process-spawn-safety ルール準拠）
  _setIsProcessAlive: (fn) => { _isProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _verifyProcessIdentity = fn; },
  _setGetProcessStartTime: (fn) => { _getProcessStartTime = fn; },
};
