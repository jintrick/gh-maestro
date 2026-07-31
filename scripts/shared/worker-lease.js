'use strict';
// worker-lease.js — ワーカー起動の排他制御（lease/liveness層）
//
// 責務:
//   ワーカー起動時の重複起動防止を、生存確認に基づくリース（lease）で実現する。
//   リース保存先（lease store）を抽象化し、通常ワーカー用アダプタと将来の
//   Review Manager `.running` 契約用アダプタの両方を持てる設計。
//
// Phase 2（本ファイル）:
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
//   update(key, entry) → void  既存エントリを temp+rename で原子的に上書き
//   remove(key)  → void        リースを削除
//   lockPath(key)→ string      キーに対応するロックファイルのパス
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

  function lockPath(key) {
    return path.join(dir, `.lock-${key}`);
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

    /**
     * 既存エントリを原子的に上書きする。
     * 一時ファイルへの書き込み + atomic rename により、並行 read が
     * 空ファイルや不完全 JSON を読むことがないようにする。
     */
    update(key, entry) {
      fs.mkdirSync(dir, { recursive: true });
      const fp = filePath(key);
      const tmpPath = `${fp}.tmp.${process.pid}`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf8');
        fs.renameSync(tmpPath, fp);
      } catch (e) {
        // rename 失敗時は一時ファイルを掃除（ベストエフォート）
        try { fs.unlinkSync(tmpPath); } catch {}
        throw e;
      }
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

    /** キーに対応する per-key ロックファイルのパスを返す。 */
    lockPath(key) {
      return lockPath(key);
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

// ── Per-Key 起動ロック ────────────────────────────────────────────────────────
//
// stale lease の read-remove-write 区間を直列化する。
// 2つの launcher が同じ stale entry を読んだ後、A の新規 lease を
// B の store.remove(key) が削除してしまう TOCTOU 競合を防ぐ。

/**
 * 指定キーの起動処理を排他制御するロックを取得する。
 *
 * 保持者が非生存の場合は stale とみなし自動的に奪取する。
 *
 * @param {object} store lease store
 * @param {string} key リースキー
 * @param {number} maxRetries 最大リトライ回数
 * @returns {boolean} 取得できれば true
 * @throws {Error} live な保持者がいる、またはリトライ上限超過
 */
function acquireLeaseLock(store, key, maxRetries = 5) {
  const lockPath = store.lockPath(key);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // ロックが存在 → 保持者の生存を確認
    let holderPid = null;
    try {
      holderPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    } catch {
      holderPid = null;
    }

    if (holderPid && Number.isFinite(holderPid) && holderPid > 0 && _isProcessAlive(holderPid)) {
      throw new Error(
        `worker "${key}" の起動処理が別プロセス（pid ${holderPid}）で進行中です。` +
        `しばらくお待ちください。`
      );
    }

    // stale ロック（保持者が非生存、または壊れている）→ 奪取して再試行
    try { fs.unlinkSync(lockPath); } catch {}
  }

  throw new Error(
    `worker "${key}" の起動ロックを取得できませんでした（最大試行回数 ${maxRetries} 超過）`
  );
}

/**
 * 自プロセスが保持している per-key ロックを解放する。
 * 自分が保持者でない場合は何もしない。
 *
 * @param {object} store lease store
 * @param {string} key リースキー
 */
function releaseLeaseLock(store, key) {
  const lockPath = store.lockPath(key);
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (parseInt(raw, 10) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // 読めない・存在しない → 何もしない
  }
}

// ── リース操作 ────────────────────────────────────────────────────────────────

/**
 * リースを獲得する。
 *
 * 処理順序（worktree の除去・再作成より先に行う）:
 *   1. 既存リースを読み取る（ロック取得前に高速チェック）
 *   2. live lease があれば明示的に拒否（エラーを throw）
 *   3. per-key ロックを取得し、read-remove-write 区間を直列化
 *   4. ロック下で再読み取り→再判定→stale回収→原子的新規作成
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
 * @throws {Error} live lease が存在する場合、または別launcherが進行中の場合
 */
function acquireLease(store, key, { pid, startTime, workerName }) {
  // ── 高速パス: ロック取得前に live lease をチェック ──
  const quickCheck = store.read(key);
  if (quickCheck && isLeaseLive(quickCheck)) {
    throw new Error(
      `worker "${workerName}" は既に稼働中です（pid ${quickCheck.pid}）。` +
      `重複起動できません。前のワーカーが終了するまでお待ちください。`
    );
  }

  // ── per-key ロックを取得 ──
  // 他プロセスが同じキーの stale 回収を実行中ならここで待つか拒否される。
  let lockAcquired = false;
  try {
    acquireLeaseLock(store, key);
    lockAcquired = true;
  } catch (e) {
    throw new Error(`起動を拒否しました: ${e.message}`);
  }

  try {
    // ── ロック下で再読み取り・再判定 ──
    // ロック取得待ちの間に別プロセスが live lease を作成している可能性がある。
    const existing = store.read(key);

    if (existing && isLeaseLive(existing)) {
      throw new Error(
        `worker "${workerName}" は既に稼働中です（pid ${existing.pid}）。` +
        `重複起動できません。`
      );
    }

    // stale lease があれば回収
    let staleReclaimed = !!existing;
    if (existing) {
      store.remove(key);
    }

    // 新規リースを原子的に作成
    const now = new Date().toISOString();
    const entry = {
      pid,
      startTime: startTime || _getProcessStartTime(pid) || now,
      workerName,
      createdAt: now,
      // phase: 'initializing' = ワーカー起動準備中（orchestrator 用 Issue ベースライン既読化の
      // 完了前。Issue #207）。起動（activateLease）で 'active' に更新される。
      // クラッシュ復旧時は stale lease として回収され、ベースラインが冪等に再実行される
      // （集合和のため「再実行＝完了確認」となる）。
      phase: 'initializing',
    };

    try {
      store.write(key, entry);
    } catch (e) {
      if (e.code === 'EEXIST') {
        // read が null を返してもファイルがディスク上に存在するケース:
        // 破損JSON・空ファイル等で store.read() が null を返したが、
        // ファイル実体が残っているため 'wx' が EEXIST で失敗する。
        // ロック下なので安全に削除→再作成できる。
        const retryRead = store.read(key);
        if (retryRead && isLeaseLive(retryRead)) {
          throw new Error(
            `worker "${workerName}" は既に稼働中です（pid ${retryRead.pid}）。` +
            `重複起動できません。`
          );
        }
        // 破損またはstale → 削除して再試行
        store.remove(key);
        staleReclaimed = true; // 破損ファイルも回収扱い
        store.write(key, entry);
      } else {
        throw e;
      }
    }
    return { acquired: true, staleReclaimed };
  } finally {
    releaseLeaseLock(store, key);
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
 * PID・startTime で更新する。
 *
 * store.update() は temp+rename による原子更新のため、並行 read が
 * 空ファイルや不完全 JSON を読むことは構造的に起きない。
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
    // ワーカープロセス起動まで完了したら active（initializing → active。Issue #207）
    phase: 'active',
  });
}

module.exports = {
  createNormalWorkerStore,
  acquireLease,
  acquireLeaseLock,
  releaseLeaseLock,
  releaseLease,
  activateLease,
  isLeaseLive,
  // テスト用注入（test-process-spawn-safety ルール準拠）
  _setIsProcessAlive: (fn) => { _isProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _verifyProcessIdentity = fn; },
  _setGetProcessStartTime: (fn) => { _getProcessStartTime = fn; },
};
