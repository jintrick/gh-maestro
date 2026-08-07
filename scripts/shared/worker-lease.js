'use strict';
// worker-lease.js — ワーカー起動の排他制御（lease/liveness層）
//
// 責務:
//   ワーカー起動時の重複起動防止を、生存確認に基づくリース（lease）で実現する。
//   リース保存先（lease store）を抽象化し、通常ワーカー用アダプタと常駐プロセス用の
//   role lease の両方を持てる設計。
//
// Phase 2（本ファイル）:
//   - 通常ワーカー用 lease store（.gh-maestro/leases/<key>.json）
//   - リース獲得（live lease 拒否 / stale lease 回収 / 原子作成）
//   - リース解放・アクティベート
//
// Phase 5（本ファイル、Issue #240）:
//   - 常駐プロセス用 role lease（msg-poll.js / inbox-supervisor.js の多重起動を、
//     workspace 表記の差異に依存せず workspace の正規化 + 固定role で排他する）
//   - 拒否・引き継ぎ（handoff）時の監査イベント記録（resident-audit.js）
//
// Phase 4（将来、本PR対象外）:
//   - Review Manager 用 lease store adapter（.running ファイルをラップ）
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const path = require('path');
const fs = require('fs');
const { isProcessAlive, verifyProcessIdentity, getProcessStartTime } = require('../process-lifecycle');
const { canonicalWorkspace, assertValidWorkspace } = require('./storage-layout');
const { killProcessTree } = require('../kill-tree');
const { recordResidentAuditEvent } = require('./resident-audit');

// テストで注入可能にする（実プロセスに触れない。test-process-spawn-safety ルール準拠）。
let _isProcessAlive = isProcessAlive;
let _verifyProcessIdentity = verifyProcessIdentity;
let _getProcessStartTime = getProcessStartTime;
let _killProcessTree = killProcessTree;
let _sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
 * startTime は必須で、PID の生存に加えて必ず verifyProcessIdentity による同一性を
 * 確認する（PID再利用による誤判定・改ざんされたリースによる誤kill防止。
 * process-lifecycle-scripts.md ルール準拠）。startTime が欠落・不正なリースは
 * live とみなさない。この判定は --force の停止対象選定にもそのまま使われるため、
 * startTime なしで live と判定すると書き込み可能な workspace に細工したリースを
 * 置くだけで任意の生存 PID を強制終了できてしまう。
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

  // startTime が欠落・不正なリースは live とみなさない（--force の停止対象にもしない）
  if (typeof entry.startTime !== 'string' || !entry.startTime) return false;

  if (!_isProcessAlive(pid)) return false;

  const result = _verifyProcessIdentity(pid, { startTime: entry.startTime });
  if (!result.match) return false;

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

  const selfEntry = {
    pid: process.pid,
    startTime: _getProcessStartTime(process.pid) || new Date().toISOString(),
  };

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(selfEntry), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // ロックが存在 → 現在の保持者を読み直し、PID+startTime の同一性まで確認してから
    // stale 判定する。無条件 unlink だと、他プロセスが直前に書いた新しいロックを
    // 消して同一ワーカーの二重起動を許す TOCTOU 競合になるため（Review指摘 #4）、
    // process-lifecycle.js の acquireStartupLock と同型のパターンに揃える。
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      holder = null;
    }

    const holderAlive = holder
      && Number.isFinite(holder.pid)
      && holder.pid > 0
      && _isProcessAlive(holder.pid);
    const holderMatches = holderAlive && _verifyProcessIdentity(holder.pid, holder).match;
    if (holderMatches) {
      throw new Error(
        `worker "${key}" の起動処理が別プロセス（pid ${holder.pid}）で進行中です。` +
        `しばらくお待ちください。`
      );
    }

    // stale ロック（保持者非生存・PID再利用・破損）→ 奪取して再試行
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
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (holder && holder.pid === process.pid) {
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

// ── 常駐プロセス用 role lease（Issue #240） ────────────────────────────────
//
// msg-poll.js / inbox-supervisor.js などの常駐プロセスは、固定の role 名を
// リースキーとして workspace ごとに排他する。通常ワーカー lease と異なり
// 起動元（launcher）がいないため、lease の PID/startTime は実際に稼働する
// プロセス自身（= このコードを実行するプロセス）が記録する。
//
// Issue #240 の根本症状「workspace 表記の差異（大文字小文字・末尾スラッシュ等）で
// 重複プロセス検知がすり抜ける」への対策として、store 生成前に
// storage-layout.js の canonicalWorkspace() で正規化する。createNormalWorkerStore は
// 生の workspace 文字列でディレクトリを組むため、この層で必ず正規化してから渡す。

/** inbox-supervisor.js の固定 role 名。 */
const INBOX_SUPERVISOR_ROLE = 'inbox-supervisor';

/** 引き継ぎ（--force）で所有者の終了を待つ上限時間（ms）。 */
const HANDOFF_WAIT_MS = 10000;

/** 引き継ぎ待機中の再取得ポーリング間隔（ms）。 */
const HANDOFF_POLL_MS = 500;

// リースキーに使えない文字（Windows のパス無効文字）をアンダースコアに置換する。
const INVALID_PATH_CHAR_RE = /[/\\:*?"<>|\x00-\x1f]/g;

/**
 * 固定 role から role lease のリースキーを生成する。
 *
 * role は内部定数（inbox-supervisor, msgpoll-<self>）由来のため通常は安全だが、
 * Windows パスに使えない文字を置換して、store のファイル名として常に安全にする。
 *
 * @param {string} role
 * @returns {string}
 */
function roleLeaseKey(role) {
  return `resident-role-${String(role).replace(INVALID_PATH_CHAR_RE, '_')}`;
}

/**
 * workspace を正規化・検証して role lease 用の store を作る。
 *
 * 生の workspace 文字列で createNormalWorkerStore を呼ぶと、表記差異ごとに
 * 別の store（= 別の排他領域）ができて重複がすり抜けるため（Issue #240）、
 * canonicalWorkspace() で正規化したパスを必ず渡す。
 *
 * @param {string} workspace
 * @returns {object} lease store
 */
function createResidentLeaseStore(workspace) {
  const canonical = canonicalWorkspace(workspace);
  assertValidWorkspace(canonical);
  return createNormalWorkerStore(canonical);
}

/**
 * 指定 role の lease が live（生存プロセスが保持）か確認する。
 *
 * ensure-inbox-supervisor.js などが registry とは独立に二重起動を事前検知するための
 * 読み取り専用チェック。書き込みはしない。
 *
 * @param {object} opt
 * @param {string} opt.workspace
 * @param {string} opt.role
 * @returns {boolean}
 */
function isResidentLeaseLive({ workspace, role }) {
  const store = createResidentLeaseStore(workspace);
  return isLeaseLive(store.read(roleLeaseKey(role)));
}

/**
 * 監査イベントを記録する。記録失敗（不正種別・I/O失敗）は fail closed で例外を伝播する
 * （recordResidentAuditEvent の契約。記録できないまま排他制御を素通りさせない）。
 *
 * @param {string} workspace
 * @param {string} type
 * @param {string} role
 * @param {object} detail
 */
function recordAudit(workspace, type, role, detail) {
  recordResidentAuditEvent({ workspace, type, role, detail });
}

/**
 * 常駐プロセス用 role lease を取得する。
 *
 * 通常起動（handoff: false）: live lease があれば lock-denied を監査記録して throw する。
 * --force（handoff: true）:    レース判定を無効化せず、既存所有者（lease 保持者 +
 *   handoffStopTargets の戻り値）へ停止要求を送り、同じ lease を期限付きで再取得する。
 *   待機開始時に handoff-wait を監査記録し、期限超過時は lock-denied を記録して
 *   { acquired: false } を返す（本稼働へは進まない）。
 *
 * どの経路でも lease の PID/startTime はこのプロセス自身のものを記録する。
 * 取得に成功した場合は即座に phase 'active' にする（常駐プロセスは起動直後に
 * 本稼働するため、launcher の initializing ウィンドウを持たない）。
 *
 * @param {object} opt
 * @param {string} opt.workspace
 * @param {string} opt.role
 * @param {boolean} [opt.handoff]   --force による引き継ぎを試みるか
 * @param {() => Array<number>} [opt.handoffStopTargets]
 *   引き継ぎ時に停止要求を送る追加PID（registry 由来の旧所有者等）を返す関数
 * @param {number} [opt.deadlineMs] 引き継ぎ待機の上限時間（既定: HANDOFF_WAIT_MS）
 * @returns {{ acquired: true, key: string, release: () => void, staleReclaimed: boolean }
 *          | { acquired: false, reason: 'handoff-timeout', key: string, ownerPid: number|null }}
 * @throws {Error} live lease が存在する（handoff なし）場合、または監査記録に失敗した場合
 */
function acquireResidentLease({
  workspace,
  role,
  handoff = false,
  handoffStopTargets = () => [],
  deadlineMs = HANDOFF_WAIT_MS,
}) {
  const store = createResidentLeaseStore(workspace);
  const key = roleLeaseKey(role);
  const pid = process.pid;
  const startTime = _getProcessStartTime(pid) || new Date().toISOString();

  const existing = store.read(key);
  const liveExisting = existing && isLeaseLive(existing);

  // ── 通常起動: live lease があれば拒否 ──
  if (!handoff && liveExisting) {
    recordAudit(workspace, 'lock-denied', role, { ownerPid: existing.pid, reason: 'live-lease' });
    throw new Error(
      `role "${role}" は既に別プロセス（pid ${existing.pid}）で稼働中です。重複起動できません。` +
      `既存プロセスが終了するまでお待ちください。`
    );
  }

  // ── --force: 既存所有者へ停止要求 → 同じ lease を期限付きで再取得 ──
  if (handoff && liveExisting) {
    recordAudit(workspace, 'handoff-wait', role, { ownerPid: existing.pid });
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const liveOwner = store.read(key);
      const targets = new Set();
      if (liveOwner && isLeaseLive(liveOwner)) targets.add(liveOwner.pid);
      // registry 由来の旧所有者（findRunningInstance 等）。判定不能・失敗時は
      // 停止対象から外す（kill できないなら kill しない = 誤kill防止）。
      let extra = [];
      try { extra = handoffStopTargets() || []; } catch {}
      for (const t of extra) {
        if (Number.isFinite(t) && t > 0 && t !== pid) targets.add(t);
      }
      for (const t of targets) {
        try { _killProcessTree(t); } catch {}
      }
      try {
        const res = acquireLease(store, key, { pid, startTime, workerName: role });
        activateLease(store, key, { pid, startTime });
        return { acquired: true, key, release: () => releaseLease(store, key, { pid }), staleReclaimed: res.staleReclaimed };
      } catch {}
      _sleep(HANDOFF_POLL_MS);
    }
    // 期限超過: まだ live な所有者が残っていれば拒否
    const last = store.read(key);
    const lastLive = last && isLeaseLive(last);
    recordAudit(workspace, 'lock-denied', role, {
      ownerPid: lastLive ? last.pid : null,
      reason: 'handoff-timeout',
    });
    return { acquired: false, reason: 'handoff-timeout', key, ownerPid: lastLive ? last.pid : null };
  }

  // ── 通常起動（live lease なし）または stale lease 回収 ──
  const res = acquireLease(store, key, { pid, startTime, workerName: role });
  activateLease(store, key, { pid, startTime });
  return { acquired: true, key, release: () => releaseLease(store, key, { pid }), staleReclaimed: res.staleReclaimed };
}

/**
 * 自プロセスが保持する role lease を解放する。
 * 所有者が自分の場合のみ削除する（他プロセスの lease は触らない）。
 *
 * @param {object} opt
 * @param {string} opt.workspace
 * @param {string} opt.role
 * @param {number} opt.pid
 */
function releaseResidentLease({ workspace, role, pid }) {
  const store = createResidentLeaseStore(workspace);
  releaseLease(store, roleLeaseKey(role), { pid });
}

module.exports = {
  createNormalWorkerStore,
  acquireLease,
  acquireLeaseLock,
  releaseLeaseLock,
  releaseLease,
  activateLease,
  isLeaseLive,
  // 常駐プロセス用 role lease（Issue #240）
  INBOX_SUPERVISOR_ROLE,
  roleLeaseKey,
  isResidentLeaseLive,
  acquireResidentLease,
  releaseResidentLease,
  // テスト用注入（test-process-spawn-safety ルール準拠）
  _setIsProcessAlive: (fn) => { _isProcessAlive = fn; },
  _setVerifyProcessIdentity: (fn) => { _verifyProcessIdentity = fn; },
  _setGetProcessStartTime: (fn) => { _getProcessStartTime = fn; },
  _setKillProcessTree: (fn) => { _killProcessTree = fn; },
  _setSleep: (fn) => { _sleep = fn; },
};
