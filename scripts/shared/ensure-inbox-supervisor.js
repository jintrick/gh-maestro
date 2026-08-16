'use strict';
// ensure-inbox-supervisor.js
//
// inbox-supervisor.js（セッション再開系ワーカーへの配送を担う常駐プロセス）が
// 稼働していなければ、detachedプロセスとして自動起動する。
//
// 背景: 従来はorchestrator（LLMエージェント）がSKILL.mdの指示を読んで自分でBashツールを
// 呼び出し手動起動する設計だった。これは「起動を怠ると配送が一切行われない」という
// 決定的でない（エージェントの記憶に依存する）弱点があり、実際に起動されないまま
// ワーカーへの追加指示が永久に届かない実障害が発生した。この関数を
// spawn-worker.js（ワーカー作成時）とmsg-send.js（ワーカー宛て送信時）の両方から
// 呼ぶことで、エージェントの記憶に頼らず決定的に起動を保証する。
//
// セッションPIDはこの関数の呼び出し元（まだ生存が保証されている今の時点）で解決し、
// 子（inbox-supervisor.js）へ --session-pid として明示的に渡す。
// 実障害: 子に解決を委ねると、子自身のfindSessionRootPidは「自分の直近の親」から
// 親チェーンを遡るが、その直近の親は本関数の呼び出し元（msg-send.js/spawn-worker.js。
// fire-and-forgetで即終了する使い捨てCLI）であり、子の起動から間もなく消える。
// 消えた後にさらに1階層上（本当のセッション本体）へ遡ろうとするとWMI照会が
// 対象なしで失敗し、遡行はその場で静かに止まって「直近の使い捨てCLI」を
// セッション本体と誤認する。結果、そのCLIが（設計通り）即座に消えたことを
// 「オーケストレーターセッションが死んだ」と誤判定し、子が数十秒で自滅していた。
// 呼び出し元がまだ生きている時点で解決すれば、この取りこぼしは起きない。
//
// 既に稼働中のSupervisorがいれば、spawnもセッションPID解決もスキップする
// （二重起動はinbox-supervisor.js自身のロックでも防がれるが、事前チェックで
// 無駄なspawnと毎回のセッションPID解決コストを避ける）。この関数はbest-effortの
// fire-and-forgetであり、起動の成否を待たず・呼び出し元をブロックしない。
//
// migrate-records.js の移行実行中（.gh-maestro/.migration-in-progress マーカー存在中）も
// 自動起動をスキップする。移行中に復活すると、移行先の空状態で記録を上書きしかける
// 事故が実際に起きたため（Issue #256）。マーカーの作成・削除は migrate-records.js が行う。
//
// 自動復活の有界化（Issue #303 / PR #302 同型）: この関数は spawn-worker.js と msg-send.js の
// 通常処理から繰り返し呼ばれるため、inbox-supervisor が復活できない状態（自滅・lease拒否等）では
// 無制限にプロセスとログが増加してしまう。そこで .gh-maestro/inbox-supervisor-autostart-attempt.json に
// 最後に spawn を試みた時点を記録し、クールダウン中（既定5分）の再試行をスキップする。
// 共通基盤 ensure-resident-daemon.js 経由で一本化。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { INBOX_SUPERVISOR_ROLE } = require('./worker-lease');
const {
  ensureResidentDaemon,
  createDaemonHooks,
  AUTOSTART_COOLDOWN_MS,
} = require('./ensure-resident-daemon');

const hooks = createDaemonHooks();

/**
 * inbox-supervisor.js が稼働していなければ、detachedプロセスとして自動起動を試みる。
 * best-effort。失敗しても例外を投げず、呼び出し元の処理を継続させる。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - inbox-supervisor.js が置かれているディレクトリ
 */
function ensureInboxSupervisorRunning({ workspace, scriptsPath }) {
  ensureResidentDaemon({
    workspace,
    scriptsPath,
    scriptName: 'inbox-supervisor.js',
    role: INBOX_SUPERVISOR_ROLE,
    logFileName: 'inbox-supervisor-autostart.log',
    attemptName: 'inbox-supervisor',
    buildArgs: ({ workspace: ws, sessionPid }) => {
      const args = ['--workspace', ws];
      if (sessionPid) args.push('--session-pid', String(sessionPid));
      return args;
    },
    hooks,
  });
}

module.exports = {
  ensureInboxSupervisorRunning,
  AUTOSTART_COOLDOWN_MS,
  _setSpawn: hooks.setSpawn,
  _setFindSessionRootPid: hooks.setFindSessionRootPid,
  _setFindRunningInstance: hooks.setFindRunningInstance,
  _setIsResidentLeaseLive: hooks.setIsResidentLeaseLive,
};
