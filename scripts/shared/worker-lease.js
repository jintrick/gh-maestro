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
//   - 常駐プロセス用 role lease（msg-poll.js / worker-supervisor.js の多重起動を、
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
const { canonicalWorkspace, assertValidWorkspace } = require('./storage-layout');
const { killProcessTree } = require('./kill-tree');
const { recordResidentAuditEvent } = require('./resident-audit');
const { atomicWriteJson } = require('./atomic-write');
const { checkResidentForceGuard } = require('./resident-force-guard');
const { resourceKeyFor } = require('./process-liveness');

// テストでは生存確認の入力を注入した同じ API を使う。
let _injectedLiveness = null;
function liveness() { return _injectedLiveness || require('./process-liveness'); }

// テストで注入可能にする（実プロセスに触れない）。
let _killProcessTree = killProcessTree;
let _killProcess = (pid) => process.kill(pid, 'SIGKILL');
let _sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** activateLease が endpoint 確立を待つときの観測間隔（ms）。 */
const ACTIVATE_POLL_MS = 100;

// ── Lease Store 抽象 ───────────────────────────────────────────────────────────
//
// Lease store は以下のインターフェースを持つプレーンオブジェクト:
//   read(key)    → entry|null  リースエントリを読み取る
//   write(key, entry) → void   原子的に新規作成（EEXIST で競合検知）
//   update(key, entry) → void  既存エントリを temp+rename で原子的に上書き
//   remove(key)  → void        リースを削除
//   lockPath(key)→ string      キーに対応するロックファイルのパス
//
// entry 形式: { pid, resourceKey, workerName, createdAt }

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
  const canonical = canonicalWorkspace(workspace);
  const dir = path.join(workspace, '.gh-maestro', 'leases');

  function filePath(key) {
    return path.join(dir, `${key}.json`);
  }

  function lockPath(key) {
    return path.join(dir, `.lock-${key}`);
  }

  return {
    workspace: canonical,
    /** 不在だけ null。破損・読み取り失敗はファイルを保持して報告する。 */
    read(key) {
      const fp = filePath(key);
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`lease ${fp} の読み取りに失敗しました: ${error.message}`, { cause: error });
      }
      let entry;
      try { entry = JSON.parse(raw); }
      catch (error) { throw new Error(`lease ${fp} が破損しています: ${error.message}`, { cause: error }); }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`lease ${fp} の形式が不正です`);
      }
      return entry;
    },

    /** 原子的に新規作成する。既存の場合は EEXIST を投げる。 */
    write(key, entry) {
      fs.mkdirSync(dir, { recursive: true });
      const fp = filePath(key);
      fs.writeFileSync(fp, JSON.stringify(entry, null, 2), { encoding: 'utf8', flag: 'wx' });
    },

    /**
     * 既存エントリを原子的に上書きする。
     * staging 書き込み + atomic rename により、並行 read が空ファイルや不完全 JSON を
     * 読むことがないようにする。atomic-write.js の短時間リトライ（EACCES/EPERM/EBUSY、
     * 合計500ms予算）で、Windows で他プロセスが対象を一瞬掴む rename EPERM にも耐える
     * （Issue #252）。
     */
    update(key, entry) {
      atomicWriteJson(filePath(key), entry);
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

    /** キーに対応する lease ファイルのパスを返す（記録の出所の報告用）。 */
    filePath(key) {
      return filePath(key);
    },
  };
}

// ── 生存確認 ──────────────────────────────────────────────────────────────────

/**
 * リースエントリが指すプロセスが稼働中か判定する。
 *
 * 参照を共通モジュールで観測し、判定不能な記録はエラーにする。
 * この判定は --force の停止対象選定にも使われるため、不明な所有者を
 * 生存または死亡と決めつけない。
 *
 * @param {object|null} entry リースエントリ
 * @returns {boolean}
 */
function isLeaseLive(entry) {
  if (!entry) return false;
  const checker = liveness();
  const state = checker.observe(checker.readRef(entry));
  if (state === 'unknown') {
    const error = new Error(`lease 保持者 ${JSON.stringify(entry)} の生死を判定できません`);
    error.code = 'LIVENESS_UNKNOWN';
    throw error;
  }
  return state === 'alive';
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
 * @param {string} [identity] ロック保持者として共有する不透明なプロセス参照
 * @returns {boolean} 取得できれば true
 * @throws {Error} live な保持者がいる、またはリトライ上限超過
 */
function acquireLeaseLock(store, key, maxRetries = 5, ownerRef = null) {
  // identity を明示された場合は、捕捉済みの resourceKey と instanceId をそのまま検証する。
  // 取得に失敗したidentityをここで再取得すると、lease本体・PID registryとの照合値が
  // 分断されるため、未知値のままロックを作成しない。
  const checker = liveness();
  const lockOwnerRef = ownerRef || checker.captureSelf();
  if (checker.observe(lockOwnerRef) !== 'alive') {
    throw new Error('worker lease: ロック所有者の生存を確認できません');
  }
  const selfEntry = checker.writeRef({}, lockOwnerRef);
  const lockPath = store.lockPath(key);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(selfEntry), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // ロックが存在 → 現在の保持者を読み直し、OS資源参照の同一性まで確認してから
    // stale 判定する。無条件 unlink だと、他プロセスが直前に書いた新しいロックを
    // 消して同一ワーカーの二重起動を許す TOCTOU 競合になるため（Review指摘 #4）、
    // process-lifecycle.js の acquireStartupLock と同型のパターンに揃える。
    let holder;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (error) {
      throw new Error(`ロック ${lockPath} の保持者を読めません: ${error.message}`, { cause: error });
    }
    const state = checker.observe(checker.readRef(holder));
    if (state === 'unknown') {
      throw new Error(`ロック ${lockPath} の保持者 ${JSON.stringify(holder)} の生死を判定できません`);
    }
    const holderMatches = state === 'alive';
    if (holderMatches) {
      const error = new Error(
        `worker "${key}" の起動処理が別プロセス（pid ${holder.pid}）で進行中です。` +
        `しばらくお待ちください。`
      );
      error.code = 'LEASE_LOCK_HELD';
      throw error;
    }

    // stale ロック（保持者非生存・PID再利用）→ 奪取して再試行
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
    const checker = liveness();
    if (checker.sameRef(checker.readRef(holder), checker.captureSelf())) {
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
 * ワーカー起動後に activateLease() で、ワーカーの endpoint 確立を確認してから実際のワーカー参照に更新する。
 *
 * @param {object} store lease store
 * @param {string} key リースキー（workerName）
 * @param {object} opt
 * @param {string} opt.processRef 不透明な起動元参照
 * @param {string} opt.workerName ワーカー名（エラーメッセージ用）
 * @returns {{ acquired: true, staleReclaimed: boolean }}
 * @throws {Error} live lease が存在する場合、または別launcherが進行中の場合
 */
function acquireLease(store, key, { processRef, workerName }) {
  // ── 高速パス: ロック取得前に live lease をチェック ──
  const checker = liveness();
  const workerResourceKey = typeof store.workspace === 'string'
    ? resourceKeyFor({ workspace: store.workspace, kind: 'worker', name: key })
    : null;
  const observeWorkerEndpoint = () => {
    if (typeof checker.observeResource !== 'function' || typeof store.workspace !== 'string') return null;
    const observed = checker.observeResource({ workspace: store.workspace, kind: 'worker', name: key });
    if (observed.state === 'unknown') {
      const error = new Error(`worker "${workerName}" の決定論的endpointを確認できません`);
      error.code = 'LIVENESS_UNKNOWN';
      throw error;
    }
    return observed;
  };
  const leaseSource = typeof store.filePath === 'function' ? store.filePath(key) : `lease ${key}`;
  const requireAvailable = (entry) => {
    const observed = observeWorkerEndpoint();
    if (observed?.state === 'unknown') {
      const error = new Error(`worker "${workerName}" の決定論的endpointを確認できません`);
      error.code = 'LIVENESS_UNKNOWN';
      throw error;
    }
    if (observed?.state === 'alive') {
      throw new Error(`worker "${workerName}" は既に稼働中です（pid ${observed.manifest?.pid ?? 'unknown'}）。重複起動できません。`);
    }

    if (entry) {
      const hasResourceKey = entry.resourceKey !== undefined && entry.resourceKey !== null;
      const hasInstanceId = entry.instanceId !== undefined && entry.instanceId !== null;
      if (hasResourceKey !== hasInstanceId
          || (hasResourceKey && (typeof entry.resourceKey !== 'string'
            || !/^[a-f0-9]{64}$/.test(entry.resourceKey)
            || typeof entry.instanceId !== 'string' || entry.instanceId.length === 0))) {
        const error = new Error(`worker "${workerName}" の lease resource metadata が破損しています`);
        error.code = 'LIVENESS_CORRUPT';
        throw error;
      }
      // During initialization the lease describes the launcher, not the worker.
      // Its endpoint remains relevant until activation replaces it with the worker ref.
      // An endpointless (old-format) lease has no holder; observe() reports it as dead.
      if (entry.resourceKey !== workerResourceKey) {
        const ref = checker.readRef(entry, 'default', { source: leaseSource });
        if (!ref) {
          const error = new Error(`worker "${workerName}" の lease の形式が不正です: ${JSON.stringify(entry)}`);
          error.code = 'LIVENESS_CORRUPT';
          throw error;
        }
        const state = checker.observe(ref);
        if (state === 'alive') {
          throw new Error(`worker "${workerName}" の起動処理は既に進行中です（pid ${entry.pid}）。重複起動できません。`);
        }
        if (state !== 'dead') {
          const error = new Error(`worker "${workerName}" の lease 保持者 ${JSON.stringify(entry)} の生死を判定できません`);
          error.code = 'LIVENESS_UNKNOWN';
          throw error;
        }
      }
    }
  };
  const quickCheck = store.read(key);
  requireAvailable(quickCheck);

  if (checker.observe(processRef) !== 'alive') {
    throw new Error('worker lease: lease所有者の生存を確認できません');
  }

  // ── per-key ロックを取得 ──
  // 他プロセスが同じキーの stale 回収を実行中ならここで待つか拒否される。
  let lockAcquired = false;
  try {
    // 起動ロックの所有者はこのNodeプロセス自身であり、通常leaseの対象PIDが
    // 別プロセスとして渡された場合にそのPIDをロック記録へ書いてはならない。
    // 常駐leaseのように対象PIDが自PIDの場合だけ、捕捉済みidentityを共有する。
    const selfRef = checker.captureSelf();
    const lockOwnerRef = checker.sameRef(processRef, selfRef) ? processRef : null;
    acquireLeaseLock(store, key, 5, lockOwnerRef);
    lockAcquired = true;
  } catch (e) {
    throw new Error(`起動を拒否しました: ${e.message}`);
  }

  try {
    // ── ロック下で再読み取り・再判定 ──
    // ロック取得待ちの間に別プロセスが live lease を作成している可能性がある。
    const existing = store.read(key);

    requireAvailable(existing);

    // stale lease があれば回収
    let staleReclaimed = !!existing;
    if (existing) {
      store.remove(key);
    }

    // 新規リースを原子的に作成
    const now = new Date().toISOString();
    const entry = checker.writeRef({
      workerName,
      createdAt: now,
      // phase: 'initializing' = ワーカー起動準備中（orchestrator 用 Issue ベースライン既読化の
      // 完了前。Issue #207）。起動（activateLease）で 'active' に更新される。
      // クラッシュ復旧時は stale lease として回収され、ベースラインが冪等に再実行される
      // （集合和のため「再実行＝完了確認」となる）。
      phase: 'initializing',
    }, processRef);

    try {
      store.write(key, entry);
    } catch (e) {
      if (e.code === 'EEXIST') {
        // Re-read under the lock. A missing or unreadable record is not proof
        // of death, and must never be removed or recreated automatically.
        const retryRead = store.read(key);
        if (!retryRead) throw new Error(`worker "${workerName}" の lease が競合後に読めません`);
        requireAvailable(retryRead);
        store.remove(key);
        staleReclaimed = true;
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
function releaseLease(store, key, processRef) {
  const existing = store.read(key);
  if (!existing) return;

  // 自プロセスのリースだけを解放（他プロセスのリースを誤って消さない）
  if (liveness().sameRef(liveness().readRef(existing), processRef)) {
    store.remove(key);
  }
}

/**
 * リースを実際のワーカーPIDでアクティベートする。
 *
 * 起動元（launcher）のPIDで予約したリースを、実際に起動したワーカープロセスの
 * PID・resourceKey で更新する。
 *
 * ワーカーは別プロセスとして起動した後に自分の決定論的 endpoint を確立するため、
 * 呼び出し元は waitMs を指定して endpoint の確立を待つ。待機中も launcher は自分の
 * endpoint と initializing lease を持ち続けるので、予約に空白ができない。
 * 期限内に endpoint の確立を確認できなければ例外を投げ、lease は launcher 参照の
 * まま変更しない（起動中の子をどう扱うかは呼び出し元が決める）。
 * この待機は単一の OS 資源の確立待ちであり、期限は決定論的に強制する。
 *
 * store.update() は temp+rename による原子更新のため、並行 read が
 * 空ファイルや不完全 JSON を読むことは構造的に起きない。
 *
 * @param {object} store lease store
 * @param {string} key リースキー
 * @param {string} processRef ワーカープロセスの不透明な参照
 * @param {object} [opt]
 * @param {number} [opt.waitMs=0] endpoint 確立を待つ上限時間（ms）
 * @throws {Error} lease が消えている、期限内に生存を確認できない、または保存に失敗した場合
 */
function activateLease(store, key, processRef, { waitMs = 0 } = {}) {
  const existing = store.read(key);
  if (!existing) {
    throw new Error(`worker lease "${key}" がアクティベート前に消えています`);
  }

  const checker = liveness();
  const deadline = Date.now() + Math.max(0, waitMs);
  let state = checker.observe(processRef);
  while (state !== 'alive' && Date.now() < deadline) {
    _sleep(Math.min(ACTIVATE_POLL_MS, Math.max(1, deadline - Date.now())));
    state = checker.observe(processRef);
  }
  if (state !== 'alive') {
    const error = new Error(
      `worker lease: アクティベート対象の生存を確認できません（${state}、待機 ${Math.max(0, waitMs)}ms）`
    );
    if (state === 'unknown') error.code = 'LIVENESS_UNKNOWN';
    throw error;
  }
  store.update(key, checker.writeRef({
    ...existing,
    // ワーカープロセス起動まで完了したら active（initializing → active。Issue #207）
    phase: 'active',
  }, processRef));
}

// ── 常駐プロセス用 role lease（Issue #240） ────────────────────────────────
//
// msg-poll.js / worker-supervisor.js などの常駐プロセスは、固定の role 名を
// リースキーとして workspace ごとに排他する。通常ワーカー lease と異なり
// 起動元（launcher）がいないため、lease の PID/resourceKey は実際に稼働する
// プロセス自身（= このコードを実行するプロセス）が記録する。
//
// Issue #240 の根本症状「workspace 表記の差異（大文字小文字・末尾スラッシュ等）で
// 重複プロセス検知がすり抜ける」への対策として、store 生成前に
// storage-layout.js の canonicalWorkspace() で正規化する。createNormalWorkerStore は
// 生の workspace 文字列でディレクトリを組むため、この層で必ず正規化してから渡す。

/** worker-supervisor.js の固定 role 名。 */
const WORKER_SUPERVISOR_ROLE = 'worker-supervisor';

// Upgrade bridge for processes started before the rename.  This role is read
// only by the compatibility checks; new processes always acquire the
// WORKER_SUPERVISOR_ROLE lease.
const LEGACY_INBOX_SUPERVISOR_ROLE = 'inbox-supervisor';
const POLL_PR_MONITOR_ROLE = 'poll-pr-monitor';

/**
 * msg-poll の role lease 名（msgpoll-<self>）を組み立てる。
 * 構築を一箇所に集約し、MSGPOLL_ORCHESTRATOR_ROLE もここから導出する。
 * @param {string} self 自分の名前（worker 名、または 'orchestrator'）
 * @returns {string}
 */
function msgPollRole(self) {
  return `msgpoll-${self}`;
}

/** orchestrator モードの msg-poll.js が自身に使う role lease 名。msgPollRole() から導出。 */
const MSGPOLL_ORCHESTRATOR_ROLE = msgPollRole('orchestrator');

/** 引き継ぎ（--force）で所有者の終了を待つ上限時間（ms）。 */
const HANDOFF_WAIT_MS = 10000;

/** 引き継ぎ待機中の再取得ポーリング間隔（ms）。 */
const HANDOFF_POLL_MS = 500;

// リースキーに使えない文字（Windows のパス無効文字）をアンダースコアに置換する。
const INVALID_PATH_CHAR_RE = /[/\\:*?"<>|\x00-\x1f]/g;

/**
 * 固定 role から role lease のリースキーを生成する。
 *
 * role は内部定数（worker-supervisor, msgpoll-<self>）由来のため通常は安全だが、
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
 * ensure-worker-supervisor.js などが registry とは独立に二重起動を事前検知するための
 * 読み取り専用チェック。書き込みはしない。
 *
 * @param {object} opt
 * @param {string} opt.workspace
 * @param {string} opt.role
 * @returns {boolean}
 */
function isResidentLeaseLive({ workspace, role }) {
  const store = createResidentLeaseStore(workspace);
  const existing = store.read(roleLeaseKey(role));
  if (existing) validateResidentMetadata(existing, role);
  if (typeof liveness().observeResource === 'function') {
    const observed = liveness().observeResource({ workspace, kind: 'resident', name: role });
    if (observed.state === 'unknown') {
      const error = new Error(`role "${role}" の決定論的endpointを確認できません`);
      error.code = 'LIVENESS_UNKNOWN';
      throw error;
    }
    return observed.state === 'alive';
  }
  return isLeaseLive(store.read(roleLeaseKey(role)));
}

function validateResidentMetadata(entry, role) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Number.isInteger(entry.pid) || entry.pid <= 0) {
    throw new Error(`resident lease "${role}" の形式が不正です`);
  }
  const hasResourceKey = entry.resourceKey !== undefined && entry.resourceKey !== null;
  const hasInstanceId = entry.instanceId !== undefined && entry.instanceId !== null;
  if (hasResourceKey !== hasInstanceId
      || (hasResourceKey && (typeof entry.resourceKey !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.resourceKey)
        || typeof entry.instanceId !== 'string' || entry.instanceId.length === 0))) {
    throw new Error(`resident lease "${role}" のresource metadataが不正です`);
  }
}

function acquireResidentEndpointLease(options) {
  const {
    workspace, role, handoff = false, takeover = false,
    deadlineMs = HANDOFF_WAIT_MS, processRef = null,
  } = options;
  const checker = liveness();
  if (takeover && !handoff) throw new Error('resident lease: plugin takeover requires handoff mode');
  const identity = { workspace, kind: 'resident', name: role };
  const selfRef = checker.prepareSelf(identity);
  if (processRef && !checker.sameRef(processRef, selfRef)) {
    throw new Error('resident lease: 不透明な参照が自プロセスの決定論的endpointを示していません');
  }
  const store = createResidentLeaseStore(workspace);
  const key = roleLeaseKey(role);
  let existing = store.read(key);
  if (existing) validateResidentMetadata(existing, role);

  let takeoverRef = null;
  if (takeover) {
    takeoverRef = checker.createProcessRef(process.pid, {
      workspace,
      kind: 'resident-takeover',
      name: role,
      instanceId: require('crypto').randomUUID(),
    });
  }

  let claimed = false;
  try {
    const deadline = Date.now() + (handoff ? deadlineMs : 0);
    if (takeoverRef) {
      let takeoverClaimed = false;
      while (Date.now() < deadline && !takeoverClaimed) {
        const gate = checker.observeResource({ workspace, kind: 'resident-takeover', name: role });
        if (gate.state === 'unknown') {
          const error = new Error(`role "${role}" のtakeover endpointを確認できません`);
          error.code = 'LIVENESS_UNKNOWN';
          throw error;
        }
        if (gate.state === 'alive') {
          const ownerPid = gate.manifest?.pid;
          if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) {
            throw new Error(`role "${role}" のtakeover endpoint所有PIDが停止対象として不正です`);
          }
          try { _killProcessTree(ownerPid); } catch { /* endpoint probe below verifies release */ }
          _sleep(Math.min(HANDOFF_POLL_MS, Math.max(1, deadline - Date.now())));
          continue;
        }
        try {
          checker.claim(takeoverRef);
          takeoverClaimed = true;
        } catch (error) {
          if (error.code !== 'LIVENESS_ENDPOINT_BUSY') throw error;
          _sleep(Math.min(HANDOFF_POLL_MS, Math.max(1, deadline - Date.now())));
        }
      }
      if (!takeoverClaimed) {
        recordAudit(workspace, 'lock-denied', role, { ownerPid: null, reason: 'takeover-lock-timeout' });
        return { acquired: false, reason: 'handoff-timeout', key, ownerPid: null };
      }
    }

    let waitRecorded = false;
    while (true) {
      const observed = checker.observeResource(identity);
      if (observed.state === 'unknown') {
        const error = new Error(`role "${role}" の生存endpointを確認できません`);
        error.code = 'LIVENESS_UNKNOWN';
        throw error;
      }
      if (observed.state === 'dead') break;
      if (!handoff) {
        recordAudit(workspace, 'lock-denied', role, {
          ownerPid: observed.manifest?.pid ?? existing?.pid ?? null,
          reason: 'live-endpoint',
        });
        throw new Error(
          `role "${role}" は既に別プロセス（pid ${observed.manifest?.pid ?? existing?.pid ?? 'unknown'}）で稼働中です。`
          + '重複起動できません。'
        );
      }
      if (Date.now() >= deadline) {
        recordAudit(workspace, 'lock-denied', role, {
          ownerPid: observed.manifest?.pid ?? null,
          reason: 'handoff-timeout',
        });
        return {
          acquired: false,
          reason: 'handoff-timeout',
          key,
          ownerPid: observed.manifest?.pid ?? null,
        };
      }
      if (!waitRecorded) {
        recordAudit(workspace, 'handoff-wait', role, { ownerPid: observed.manifest?.pid ?? null });
        waitRecorded = true;
      }
      if (!takeover) {
        const guardRes = checkResidentForceGuard(options.env || process.env);
        if (!guardRes.allowed) {
          recordAudit(workspace, 'lock-denied', role, {
            ownerPid: observed.manifest?.pid ?? null,
            reason: 'force-disallowed-context',
          });
          throw new Error(guardRes.message);
        }
      }
      const ownerPid = observed.manifest?.pid;
      if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) {
        throw new Error(`role "${role}" のendpoint所有PIDが停止対象として不正です`);
      }
      try {
        if (role.startsWith('msgpoll-')) _killProcess(ownerPid);
        else _killProcessTree(ownerPid);
      } catch { /* the endpoint probe below decides whether ownership ended */ }
      _sleep(Math.min(HANDOFF_POLL_MS, Math.max(1, deadline - Date.now())));
    }

    // The endpoint claim is the exclusive ownership operation. Disk records only supply
    // stop metadata and are overwritten after a successful claim, including valid PR1 records.
    checker.claim(selfRef);
    claimed = true;
    existing = store.read(key);
    if (existing) validateResidentMetadata(existing, role);
    const record = checker.writeRef({
      workerName: role,
      createdAt: new Date().toISOString(),
      phase: 'active',
    }, selfRef);
    try {
      if (existing) store.update(key, record);
      else store.write(key, record);
    } catch (error) {
      // The endpoint is the ownership record. Disk metadata is a stop/reporting aid:
      // liveness readers (isResidentLeaseLive, worker-supervisor's msg-poll observer)
      // consult the endpoint and its manifest, so a failed metadata write does not make
      // this live owner look dead. Failing the start here would stop delivery instead.
      console.warn(`role "${role}" のリースメタデータを保存できません: ${error.message}`);
    }

    return {
      acquired: true,
      key,
      staleReclaimed: Boolean(existing),
      release: () => {
        const current = store.read(key);
        if (current && checker.sameRef(checker.readRef(current), selfRef)) store.remove(key);
        checker.release(selfRef);
      },
    };
  } catch (error) {
    if (claimed) {
      try { checker.release(selfRef); } catch {}
    }
    throw error;
  } finally {
    if (takeoverRef) {
      try { checker.release(takeoverRef); } catch {}
    }
  }
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
 * どの経路でも lease の PID/resourceKey はこのプロセス自身のものを記録する。
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
 * @param {string} [opt.processRef] 呼び出し元が捕捉済みの不透明なプロセス参照
 * @returns {{ acquired: true, key: string, release: () => void, staleReclaimed: boolean }
 *          | { acquired: false, reason: 'handoff-timeout', key: string, ownerPid: number|null }}
 * @throws {Error} live lease が存在する（handoff なし）場合、または監査記録に失敗した場合
 */
function acquireResidentLease({
  workspace,
  role,
  handoff = false,
  takeover = false,
  handoffStopTargets = () => [],
  deadlineMs = HANDOFF_WAIT_MS,
  env = process.env,
  processRef = null,
}) {
  const checker = liveness();
  if (typeof checker.observeResource === 'function'
      && typeof checker.prepareSelf === 'function'
      && typeof checker.claim === 'function') {
    return acquireResidentEndpointLease({
      workspace,
      role,
      handoff,
      takeover,
      handoffStopTargets,
      deadlineMs,
      env,
      processRef,
    });
  }
  const key = roleLeaseKey(role);
  const currentRef = checker.captureSelf();
  const selfRef = processRef || currentRef;
  if (!checker.sameRef(selfRef, currentRef) || checker.observe(selfRef) !== 'alive') {
    throw new Error('resident lease: 不透明な参照が自プロセスを示していません');
  }
  const selfRecord = checker.writeRef({}, selfRef);
  const store = createResidentLeaseStore(workspace);

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

  // ── plugin monitor: 同役割の旧世代を停止して後発プロセスが引き継ぐ ──
  if (takeover) {
    if (!handoff) throw new Error('resident lease: plugin takeover requires handoff mode');
    const takeoverKey = `${key}-plugin-takeover`;
    const deadline = Date.now() + deadlineMs;
    let takeoverLockAcquired = false;
    while (!takeoverLockAcquired && Date.now() < deadline) {
      try {
        acquireLeaseLock(store, takeoverKey, 1, selfRef);
        takeoverLockAcquired = true;
      } catch (error) {
        if (error.code !== 'LEASE_LOCK_HELD') throw error;
        _sleep(Math.min(HANDOFF_POLL_MS, Math.max(1, deadline - Date.now())));
      }
    }
    if (!takeoverLockAcquired) {
      recordAudit(workspace, 'lock-denied', role, { ownerPid: null, reason: 'takeover-lock-timeout' });
      return { acquired: false, reason: 'handoff-timeout', key, ownerPid: null };
    }

    let waitRecorded = false;
    let lastOwnerPid = null;
    try {
      while (Date.now() < deadline) {
        const targets = new Map();
        const currentLease = store.read(key);
        if (currentLease) {
          const leaseRef = checker.readRef(currentLease);
          const leaseState = checker.observe(leaseRef);
          if (leaseState === 'unknown') {
            throw new Error(`resident lease "${role}" の保持者の生死を判定できません`);
          }
          if (leaseState === 'alive') {
            targets.set(currentLease.pid, { pid: currentLease.pid, ref: leaseRef });
            lastOwnerPid = currentLease.pid;
          }
        }

        const extraTargets = handoffStopTargets();
        if (!Array.isArray(extraTargets)) throw new Error('plugin takeover targets must be an array');
        for (const target of extraTargets) {
          const pid = typeof target === 'number' ? target : target && target.pid;
          if (!Number.isInteger(pid) || pid <= 0 || pid === selfRecord.pid) continue;
          const ref = typeof target === 'number' ? checker.captureProcess(pid) : checker.readRef(target);
          const state = checker.observe(ref);
          if (state === 'unknown') {
            throw new Error(`plugin takeover target pid ${pid} の生死を判定できません`);
          }
          if (state !== 'alive') continue;
          const prior = targets.get(pid);
          if (prior && !checker.sameRef(prior.ref, ref)) {
            throw new Error(`plugin takeover target pid ${pid} のプロセス参照が競合しています`);
          }
          targets.set(pid, { pid, ref });
          lastOwnerPid = pid;
        }

        if (targets.size === 0) {
          try {
            const result = acquireLease(store, key, { processRef: selfRef, workerName: role });
            activateLease(store, key, selfRef);
            return {
              acquired: true,
              key,
              release: () => releaseLease(store, key, selfRef),
              staleReclaimed: result.staleReclaimed,
            };
          } catch (error) {
            if (error.code === 'LIVENESS_UNKNOWN' || error.code === 'LIVENESS_CORRUPT') throw error;
            // A non-plugin launcher may have claimed the role during this pass.
          }
        } else {
          if (!waitRecorded) {
            recordAudit(workspace, 'handoff-wait', role, { ownerPid: lastOwnerPid });
            waitRecorded = true;
          }
          const stopProcess = role.startsWith('msgpoll-') ? _killProcess : _killProcessTree;
          for (const { pid, ref } of targets.values()) {
            if (checker.observe(ref) !== 'alive') continue;
            try { stopProcess(pid); } catch {}
          }
        }
        _sleep(Math.min(HANDOFF_POLL_MS, Math.max(1, deadline - Date.now())));
      }
    } finally {
      releaseLeaseLock(store, takeoverKey);
    }

    recordAudit(workspace, 'lock-denied', role, {
      ownerPid: lastOwnerPid,
      reason: 'handoff-timeout',
    });
    return { acquired: false, reason: 'handoff-timeout', key, ownerPid: lastOwnerPid };
  }

  // ── --force: 既存所有者へ停止要求 → 同じ lease を期限付きで再取得 ──
  if (handoff && liveExisting) {
    // 実行文脈ガード（Issue #384 多層防御）
    const guardRes = checkResidentForceGuard(env);
    if (!guardRes.allowed) {
      recordAudit(workspace, 'lock-denied', role, {
        ownerPid: existing.pid,
        reason: 'force-disallowed-context',
      });
      throw new Error(guardRes.message);
    }

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
        if (Number.isFinite(t) && t > 0 && t !== selfRecord.pid) targets.add(t);
      }
      for (const t of targets) {
        try { _killProcessTree(t); } catch {}
      }
      try {
        const res = acquireLease(store, key, { processRef: selfRef, workerName: role });
        activateLease(store, key, selfRef);
        return { acquired: true, key, release: () => releaseLease(store, key, selfRef), staleReclaimed: res.staleReclaimed };
      } catch (error) {
        if (error.code === 'LIVENESS_UNKNOWN' || error.code === 'LIVENESS_CORRUPT') throw error;
      }
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
  const res = acquireLease(store, key, { processRef: selfRef, workerName: role });
  try {
    activateLease(store, key, selfRef);
  } catch (e) {
    // アクティベート（update）失敗は保存処理の一時的な競合（Windows の rename EPERM 等）が
    // 原因で、「別プロセスが稼働中」を意味しない（Issue #252）。リース本体は acquireLease で
    // 作成済み（phase='initializing'）のため、起動を拒否せず警告して継続する。このリースは
    // クリーン終了時（release）に削除され、異常終了時は stale として次回起動時に回収される
    // （lease の保持者はこのプロセス自身で既に alive のため、予約が回収される空白は生じない）。
    console.warn(`role "${role}" のリースアクティベートに失敗しました: ${e.message}`);
  }
  return { acquired: true, key, release: () => releaseLease(store, key, selfRef), staleReclaimed: res.staleReclaimed };
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
function releaseResidentLease({ workspace, role, processRef = null }) {
  const store = createResidentLeaseStore(workspace);
  const checker = liveness();
  const ownerRef = processRef || checker.captureSelf({ workspace, kind: 'resident', name: role });
  releaseLease(store, roleLeaseKey(role), ownerRef);
  if (typeof checker.release === 'function') checker.release(ownerRef);
}

/**
 * 停止確認済みの別プロセスが保持していた role lease を解放する。
 *
 * 強制終了では対象プロセスの exit handler が走らず、通常の
 * releaseResidentLease() が呼ばれないことがある。停止処理側から回収する場合も、
 * PIDだけでなく registry と同じ resourceKey を照合し、PID再利用後の別プロセスの
 * leaseを削除しない。別PIDの lease は停止対象の解放失敗とはみなさないが、同じPIDで
 * resourceKeyだけが不一致の場合はidentity取得結果が分断された可能性を成功扱いにせず、
 * 残留失敗として返す。削除後に再読込して残存を確認するのは自分の leaseだけに限定する。
 *
 * @param {object} opt
 * @param {string} opt.workspace
 * @param {string} opt.role
 * @param {number} opt.pid
 * @param {string} opt.resourceKey
 * @returns {{released:boolean, remaining:boolean, reason?:string}}
 */
function releaseResidentLeaseForProcess({ workspace, role, processRef }) {
  if (typeof processRef !== 'string' || !processRef) {
    return { released: false, remaining: true, reason: 'lease owner identity is incomplete' };
  }

  const store = createResidentLeaseStore(workspace);
  const key = roleLeaseKey(role);
  let lockAcquired = false;
  try {
    // acquireResidentLease() also serializes its stale read/remove/write window with
    // this lock. Without taking the same lock here, a replacement could acquire the
    // lease after the identity check and be removed by the old owner's teardown.
    acquireLeaseLock(store, key);
    lockAcquired = true;

    const existing = store.read(key);
    if (!existing) return { released: false, remaining: false };
    const checker = liveness();
    const existingRef = checker.readRef(existing);
    if (!checker.sameRef(existingRef, processRef)) {
      const existingOwner = checker.writeRef({}, existingRef);
      const stoppedOwner = checker.writeRef({}, processRef);
      const bothEndpointless = existingOwner.resourceKey == null
        && existingOwner.instanceId == null
        && stoppedOwner.resourceKey == null
        && stoppedOwner.instanceId == null;
      if (bothEndpointless && existingOwner.pid === stoppedOwner.pid
          && checker.observe(existingRef) === 'dead') {
        store.remove(key);
        const remaining = store.read(key);
        return remaining
          ? { released: false, remaining: true, reason: 'lease remains after removal' }
          : { released: true, remaining: false };
      }
      return {
        released: false,
        // A different PID means this lease belongs to another process and is
        // outside this stop operation. The same PID with a different start
        // time is ambiguous PID reuse and must remain a reported failure.
        remaining: existingOwner.pid === stoppedOwner.pid,
        reason: 'lease owner identity does not match the stopped process',
      };
    }

    store.remove(key);
    const remaining = store.read(key);
    if (remaining) {
      return { released: false, remaining: true, reason: 'lease remains after removal' };
    }
    return { released: true, remaining: false };
  } finally {
    if (lockAcquired) releaseLeaseLock(store, key);
  }
}

module.exports = {
  createNormalWorkerStore,
  createResidentLeaseStore,
  acquireLease,
  acquireLeaseLock,
  releaseLeaseLock,
  releaseLease,
  activateLease,
  isLeaseLive,
  // 常駐プロセス用 role lease（Issue #240）
  WORKER_SUPERVISOR_ROLE,
  LEGACY_INBOX_SUPERVISOR_ROLE,
  POLL_PR_MONITOR_ROLE,
  MSGPOLL_ORCHESTRATOR_ROLE,
  msgPollRole,
  roleLeaseKey,
  isResidentLeaseLive,
  acquireResidentLease,
  releaseResidentLease,
  releaseResidentLeaseForProcess,
  // テスト用注入
  _setLiveness: (value) => { _injectedLiveness = value; },
  _setKillProcessTree: (fn) => { _killProcessTree = fn; },
  _setKillProcess: (fn) => { _killProcess = fn; },
  _setSleep: (fn) => { _sleep = fn; },
};
