'use strict';
// ensure-msg-poll-orchestrator.js
//
// orchestrator モードの msg-poll.js（inbox監視を担う常駐プロセス）が稼働していなければ、
// detachedプロセスとして自動起動する。
//
// これは「直る」の安全網（Issue #301）。主経路は Monitor アラーム → 即再起動（SKILL.md 規約）
// だが、この関数を spawn-worker.js（ワーカー作成時）と msg-send.js（ワーカー宛て送信時）から
// 呼ぶことで、エージェントの記憶に頼らず、orchestrator が何か行動した瞬間に起動し忘れた
// msg-poll を回収する。ensure-inbox-supervisor.js と同型の設計。
//
// セッションPIDはこの関数の呼び出し元（まだ生存が保証されている今の時点）で解決し、
// 子（msg-poll.js）へ --session-pid として明示的に渡す。子に解決を委ねると、子自身の
// findSessionRootPid が「直近の親（使い捨てCLI）」をセッション本体と誤認して自滅する
// 罠（Issue #256 と同型）があるため。
//
// 既に稼働中の msg-poll（orchestrator モード）がいれば、spawn もセッションPID解決も
// スキップする。二重起動は msg-poll.js 自身の role lease 取得でも防がれるが、事前チェックで
// 無駄な spawn を避ける。この関数は best-effort の fire-and-forget であり、起動の成否を
// 待たず・呼び出し元をブロックしない。
//
// migrate-records.js の移行実行中は自動起動をスキップする（ensure-inbox-supervisor.js と同様、
// Issue #256）。移行中に復活すると移行先の空状態で記録を上書きしかける。
//
// 自動復活の有界化（PR #302 / Issue #303）: この関数は spawn-worker.js と msg-send.js の通常処理から
// 繰り返し呼ばれるため、msg-poll が復活できない状態（セッションPID解決失敗・起動直後の
// 異常終了・lease 拒否など）では「呼び出しのたびに高々1回」だけでは全体として無制限に
// 子プロセスとログが増え続けてしまう。そこで「最後に spawn を試みた時点」を
// .gh-maestro/msg-poll-autostart-attempt.json に記録し、クールダウン中（既定5分）の再試行を
// スキップすることで、試行を期限（決定的コードの時刻比較）で有界にする。生存を観測したら
// 記録を消し、以後の試行を妨げない。共通基盤 ensure-resident-daemon.js 経由で一本化。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { MSGPOLL_ORCHESTRATOR_ROLE } = require('./worker-lease');
const {
  ensureResidentDaemon,
  createDaemonHooks,
  AUTOSTART_COOLDOWN_MS,
} = require('./ensure-resident-daemon');

const hooks = createDaemonHooks();

/**
 * orchestrator モードの msg-poll.js が稼働していなければ、detachedプロセスとして
 * 自動起動を試みる。best-effort。失敗しても例外を投げず、呼び出し元の処理を継続させる。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - msg-poll.js が置かれているディレクトリ
 */
function ensureMsgPollOrchestratorRunning({ workspace, scriptsPath }) {
  ensureResidentDaemon({
    workspace,
    scriptsPath,
    scriptName: 'msg-poll.js',
    role: MSGPOLL_ORCHESTRATOR_ROLE,
    logFileName: 'msg-poll-orchestrator-autostart.log',
    attemptName: 'msg-poll',
    buildArgs: ({ workspace: ws, sessionPid }) => {
      const args = ['orchestrator', '--workspace', ws];
      if (sessionPid) args.push('--session-pid', String(sessionPid));
      return args;
    },
    hooks,
  });
}

module.exports = {
  ensureMsgPollOrchestratorRunning,
  AUTOSTART_COOLDOWN_MS,
  _setSpawn: hooks.setSpawn,
  _setFindSessionRootPid: hooks.setFindSessionRootPid,
  _setFindRunningInstance: hooks.setFindRunningInstance,
  _setIsResidentLeaseLive: hooks.setIsResidentLeaseLive,
};
