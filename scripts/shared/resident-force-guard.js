'use strict';
// resident-force-guard.js — 常駐プロセスの強制置き換え（--force）実行文脈ガード
//
// 本番ワークスペースで稼働している常駐プロセス（worker-supervisor）はシステムの基盤であり、
// ワーカーの作業対象ではない。ワーカーが検証等の目的で本番の常駐プロセスを置き換えると、
// 指示配送が停止するなどシステム全体が停止する（Issue #384）。
//
// 許可リスト方式（orchestrator, human）により、許可された名乗りのみ置き換えを許可し、
// 名乗りが無い場合（未設定・空文字）やワーカー名乗りの場合は決定的に拒否する（フェイルクローズ）。

const ALLOWED_FORCE_IDENTITIES = new Set(['orchestrator', 'human']);

/**
 * 与えられた文字列がワーカー識別名（orchestrator/human 以外の非空名乗り）であるかを判定する。
 *
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isWorkerIdentity(name) {
  if (!name || typeof name !== 'string') return false;
  const normalized = name.trim();
  return normalized !== '' && !ALLOWED_FORCE_IDENTITIES.has(normalized);
}

/**
 * 許可された強制置き換え実行主体（orchestrator, human）であるかを判定する。
 *
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isAllowedForceIdentity(name) {
  if (!name || typeof name !== 'string') return false;
  return ALLOWED_FORCE_IDENTITIES.has(name.trim());
}

/**
 * 名乗り欠落（未設定・空文字）時の拒否エラーメッセージを構築する。
 *
 * 読み手はエージェントであり、この文面から次の行動を決定できるようにする（Issue #384 AC6）。
 * 1. なぜ拒否されたか: 本番常駐は作業対象外・配送停止事故防止
 * 2. 代わりに何をすべきか: 一時ワークスペースでの検証
 * 3. 何をしてはならないか: 回避行動の禁止
 *
 * @returns {string}
 */
function buildMissingIdentityErrorMessage() {
  return [
    'worker-supervisor: 常駐プロセスの強制置き換え（--force）が拒否されました。実行主体の名乗り（GH_MAESTRO_WORKER）が設定されていません。',
    '【理由】本番ワークスペースの常駐監視プロセスは gh-maestro の動作基盤であり、ワーカーの作業対象ではありません。置き換えを行うとワーカーへの指示配送が停止し、システム全体が停止します。',
    '【代替手順】常駐監視プロセスの内部動作やハング検知等を検証する必要がある場合は、本番ワークスペースではなく自分専用の一時ワークスペース（os.tmpdir() 配下のディレクトリ等）を作成し、その一時ワークスペースに対して検証を実行してください。',
    '【禁止事項】環境変数を未設定・偽装するなどの方法で本ガードを回避して本番ワークスペースの常駐プロセスを置き換えてはなりません。',
  ].join('\n');
}

/**
 * ワーカー名乗り時の拒否エラーメッセージを構築する。
 *
 * @param {string} workerName
 * @returns {string}
 */
function buildWorkerRejectionErrorMessage(workerName) {
  return [
    `worker-supervisor: ワーカー "${workerName}" からの常駐プロセスの強制置き換え（--force）は禁止されています。`,
    '【理由】本番ワークスペースの常駐監視プロセスは gh-maestro の動作基盤であり、ワーカーの作業対象ではありません。置き換えを行うとワーカーへの指示配送が停止し、システム全体が停止します。',
    '【代替手順】常駐監視プロセスの内部動作やハング検知等を検証する必要がある場合は、本番ワークスペースではなく自分専用の一時ワークスペース（os.tmpdir() 配下のディレクトリ等）を作成し、その一時ワークスペースに対して検証を実行してください。',
    '【禁止事項】GH_MAESTRO_WORKER 環境変数を手動で unset / 偽装するなどの方法で本ガードを回避して本番ワークスペースの常駐プロセスを置き換えてはなりません。',
  ].join('\n');
}

/**
 * 常駐プロセスの強制置き換え（--force）が許可される実行文脈かを検証する。
 *
 * @param {object} [env=process.env]
 * @returns {{ allowed: boolean, identity?: string, reason?: string, workerName?: string, message?: string }}
 */
function checkResidentForceGuard(env = process.env) {
  const raw = env && typeof env === 'object' ? env.GH_MAESTRO_WORKER : undefined;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return {
      allowed: false,
      reason: 'missing_identity',
      message: buildMissingIdentityErrorMessage(),
    };
  }

  const normalized = raw.trim();
  if (!ALLOWED_FORCE_IDENTITIES.has(normalized)) {
    return {
      allowed: false,
      reason: 'disallowed_worker',
      workerName: normalized,
      message: buildWorkerRejectionErrorMessage(normalized),
    };
  }

  return {
    allowed: true,
    identity: normalized,
  };
}

module.exports = {
  ALLOWED_FORCE_IDENTITIES,
  isWorkerIdentity,
  isAllowedForceIdentity,
  checkResidentForceGuard,
  buildMissingIdentityErrorMessage,
  buildWorkerRejectionErrorMessage,
};
