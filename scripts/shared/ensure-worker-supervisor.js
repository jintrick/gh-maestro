'use strict';
// ensure-worker-supervisor.js
//
// worker-supervisor.js（セッション再開系ワーカーへの配送を担う常駐プロセス）が
// 稼働していなければ、detachedプロセスとして自動起動する。
//
// 背景: 従来はorchestrator（LLMエージェント）がSKILL.mdの指示を読んで自分でBashツールを
// 呼び出し手動起動する設計だった。これは「起動を怠ると配送が一切行われない」という
// 決定的でない（エージェントの記憶に依存する）弱点があり、実際に起動されないまま
// ワーカーへの追加指示が永久に届かない実障害が発生した。この関数を
// spawn-worker.js（ワーカー作成時）とmsg-send.js（ワーカー宛て送信時）の両方から
// 呼ぶことで、エージェントの記憶に頼らず決定的に起動を保証する。
//
// worker-supervisor は Claude 親セッションではなく orchestrator msg-poll のrole leaseを
// 監視し、msg-poll が世代交代したときも同じプロセスから新しい世代へ再接続する。
// msg-poll leaseが無い/判定不能なときにSupervisorだけ先行起動すると孤立常駐するため、
// requiresRoleでliveなmsg-pollの存在を確認してからspawnする。
// 既にSupervisorがいればspawnを省略する。この関数はbest-effortのfire-and-forgetであり、
// 起動の成否を待たず・呼び出し元をブロックしない。
//
// migrate-records.js の移行実行中（.gh-maestro/.migration-in-progress マーカー存在中）も
// 自動起動をスキップする。移行中に復活すると、移行先の空状態で記録を上書きしかける
// 事故が実際に起きたため（Issue #256）。マーカーの作成・削除は migrate-records.js が行う。
//
// 自動復活の有界化（Issue #303 / PR #302 同型）: この関数は spawn-worker.js と msg-send.js の
// 通常処理から繰り返し呼ばれるため、worker-supervisor が復活できない状態（自滅・lease拒否等）では
// 無制限にプロセスとログが増加してしまう。そこで .gh-maestro/worker-supervisor-autostart-attempt.json に
// 最後に spawn を試みた時点を記録し、クールダウン中（既定5分）の再試行をスキップする。
// 共通基盤 ensure-resident-daemon.js 経由で一本化。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const {
  WORKER_SUPERVISOR_ROLE,
  LEGACY_INBOX_SUPERVISOR_ROLE,
  MSGPOLL_ORCHESTRATOR_ROLE,
} = require('./worker-lease');
const {
  ensureResidentDaemon,
  createDaemonHooks,
  AUTOSTART_COOLDOWN_MS,
} = require('./ensure-resident-daemon');

const hooks = createDaemonHooks();

/**
 * worker-supervisor.js が稼働していなければ、detachedプロセスとして自動起動を試みる。
 * best-effort。失敗しても例外を投げず、呼び出し元の処理を継続させる。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - worker-supervisor.js が置かれているディレクトリ
 */
function ensureWorkerSupervisorRunning({ workspace, scriptsPath }) {
  ensureResidentDaemon({
    workspace,
    scriptsPath,
    scriptName: 'worker-supervisor.js',
    role: WORKER_SUPERVISOR_ROLE,
    logFileName: 'worker-supervisor-autostart.log',
    attemptName: 'worker-supervisor',
    legacyScriptNames: ['inbox-supervisor.js'],
    legacyRoles: [LEGACY_INBOX_SUPERVISOR_ROLE],
    requiresRole: MSGPOLL_ORCHESTRATOR_ROLE,
    buildArgs: ({ workspace: ws }) => ['--workspace', ws],
    hooks,
  });
}

module.exports = {
  ensureWorkerSupervisorRunning,
  AUTOSTART_COOLDOWN_MS,
  _setSpawn: hooks.setSpawn,
  _setFindRunningInstance: hooks.setFindRunningInstance,
  _setIsResidentLeaseLive: hooks.setIsResidentLeaseLive,
};
