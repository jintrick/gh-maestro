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

// テストでは生存確認の入力を注入した同じ API を使う。
let _injectedLiveness = null;
function liveness() { return _injectedLiveness || require('./process-liveness'); }

// テストで注入可能にする（実プロセスに触れない）。
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
 * @param {{pid: number, startTime: string}} [identity] ロック保持者として共有するidentity
 * @returns {boolean} 取得できれば true
 * @throws {Error} live な保持者がいる、またはリトライ上限超過
 */
function acquireLeaseLock(store, key, maxRetries = 5, ownerRef = null) {
  // identity を明示された場合は、捕捉済みの起動時刻をそのまま検証する。
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

    // ロックが存在 → 現在の保持者を読み直し、PID+startTime の同一性まで確認してから
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
      throw new Error(
        `worker "${key}" の起動処理が別プロセス（pid ${holder.pid}）で進行中です。` +
        `しばらくお待ちください。`
      );
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
 * ワーカー起動後に activateLease() で実際のワーカーPIDに更新する。
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
  const requireDead = (entry) => {
    if (!entry) return;
    const state = checker.observe(checker.readRef(entry));
    if (state === 'alive') throw new Error(`worker "${workerName}" は既に稼働中です（pid ${entry.pid}）。重複起動できません。`);
    if (state !== 'dead') {
      const error = new Error(`worker "${workerName}" の lease 保持者 ${JSON.stringify(entry)} の生死を判定できません`);
      error.code = 'LIVENESS_UNKNOWN';
      throw error;
    }
  };
  const quickCheck = store.read(key);
  requireDead(quickCheck);

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

    requireDead(existing);

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
        requireDead(retryRead);
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
 * PID・startTime で更新する。
 *
 * store.update() は temp+rename による原子更新のため、並行 read が
 * 空ファイルや不完全 JSON を読むことは構造的に起きない。
 *
 * @param {object} store lease store
 * @param {string} key リースキー
 * @param {object} opt
 * @param {string} opt.processRef ワーカープロセスの不透明な参照
 */
function activateLease(store, key, processRef) {
  const existing = store.read(key);
  if (!existing) return; // 何らかの理由でリースが消えている → 何もしない

  if (liveness().observe(processRef) !== 'alive') {
    throw new Error('worker lease: アクティベート対象の生存を確認できません');
  }
  store.update(key, liveness().writeRef({
    ...existing,
    // ワーカープロセス起動まで完了したら active（initializing → active。Issue #207）
    phase: 'active',
  }, processRef));
}

// ── 常駐プロセス用 role lease（Issue #240） ────────────────────────────────
//
// msg-poll.js / worker-supervisor.js などの常駐プロセスは、固定の role 名を
// リースキーとして workspace ごとに排他する。通常ワーカー lease と異なり
// 起動元（launcher）がいないため、lease の PID/startTime は実際に稼働する
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
 * @param {string} [opt.processRef] 呼び出し元が捕捉済みの不透明なプロセス参照
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
  env = process.env,
  processRef = null,
}) {
  const checker = liveness();
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
        if (error.code === 'LIVENESS_UNKNOWN') throw error;
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
    // （spawn-worker.js の activateWorkerLease 失敗処理と同型）。
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
  releaseLease(store, roleLeaseKey(role), processRef || liveness().captureSelf());
}

/**
 * 停止確認済みの別プロセスが保持していた role lease を解放する。
 *
 * 強制終了では対象プロセスの exit handler が走らず、通常の
 * releaseResidentLease() が呼ばれないことがある。停止処理側から回収する場合も、
 * PIDだけでなく registry と同じ startTime を照合し、PID再利用後の別プロセスの
 * leaseを削除しない。別PIDの lease は停止対象の解放失敗とはみなさないが、同じPIDで
 * startTimeだけが不一致の場合はidentity取得結果が分断された可能性を成功扱いにせず、
 * 残留失敗として返す。削除後に再読込して残存を確認するのは自分の leaseだけに限定する。
 *
 * @param {object} opt
 * @param {string} opt.workspace
 * @param {string} opt.role
 * @param {number} opt.pid
 * @param {string} opt.startTime
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
  _setSleep: (fn) => { _sleep = fn; },
};
