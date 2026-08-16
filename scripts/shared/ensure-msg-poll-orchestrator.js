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
// ループ防止（構造的）: この関数が spawn する msg-poll orchestrator は、オーケストレーター
// セッションの親セッション死で exit 3 になるまで常駐し続ける。自滅通知（watchdog）は
// recipient=orchestrator で送られ、この関数の呼び出し経路（recipient !== 'orchestrator' の
// 送信・spawn-worker）とは重ならないため、自滅→再起動→即自滅の無限ループは形成されない。
//
// 自動復活の有界化（PR #302 指摘）: この関数は spawn-worker.js と msg-send.js の通常処理から
// 繰り返し呼ばれるため、msg-poll が復活できない状態（セッションPID解決失敗・起動直後の
// 異常終了・lease 拒否など）では「呼び出しのたびに高々1回」だけでは全体として無制限に
// 子プロセスとログが増え続けてしまう。そこで「最後に spawn を試みた時点」を
// .gh-maestro/msg-poll-autostart-attempt.json に記録し、クールダウン中（既定5分）の再試行を
// スキップすることで、試行を期限（決定的コードの時刻比較）で有界にする。生存を観測したら
// 記録を消し、以後の試行を妨げない。lease 拒否と起動直後の異常終了はどちらも「次のトリガー
// 時点では稼働中ではない」としか見えないため、同じ単一の上限管理に含まれる。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('../child-process');
const { isResidentLeaseLive, MSGPOLL_ORCHESTRATOR_ROLE } = require('./worker-lease');
const { isMigrationInProgress } = require('./migration-marker');

// process-lifecycle への依存は呼び出し時点で解決する（Issue #267）。ensure-inbox-supervisor.js
// と同様、評価時に捕捉すると module.exports 未確定の undefined を掴むため、
// 最初の呼び出し時まで解決を遅らせる。テスト注入（_set*）は注入値が優先される。
let _injectedFindSessionRootPid = null;
let _injectedFindRunningInstance = null;

function _findSessionRootPid() {
  const fn = _injectedFindSessionRootPid ?? require('../process-lifecycle').findSessionRootPid;
  return fn();
}

function _findRunningInstance(workspace, opts) {
  const fn = _injectedFindRunningInstance ?? require('../process-lifecycle').findRunningInstance;
  return fn(workspace, opts);
}

let _spawn = (cmd, args, opts) => spawn(cmd, args, opts);
let _isResidentLeaseLive = isResidentLeaseLive;

// 自動復活の有界化（PR #302 指摘）。直前の spawn 試行からこの時間内は再試行しない。
// 連続失敗時は「クールダウン毎に高々1回」に抑える。primary経路（Monitor アラーム→即再起動）
// とは別の安全網であり、数分単位の遅延は許容する。
const AUTOSTART_COOLDOWN_MS = 5 * 60 * 1000; // 5分

/**
 * 自動復活の試行記録ファイルのパス（.gh-maestro/ は install.js 管理外の per-workspace 領域）。
 */
function autostartAttemptPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'msg-poll-autostart-attempt.json');
}

/**
 * 最後に spawn を試みた時点（エポックms）を返す。記録が無い・壊れている・未来時刻は null
 * （= クールダウンに掛からない）。比較に使うため、型検証してから返す（PR #100 準拠）。
 */
function readAutostartAttempt(workspace) {
  try {
    const parsed = JSON.parse(fs.readFileSync(autostartAttemptPath(workspace), 'utf8'));
    const lastAttemptAt = parsed && parsed.lastAttemptAt;
    if (typeof lastAttemptAt !== 'number' || !Number.isFinite(lastAttemptAt)) return null;
    if (lastAttemptAt > Date.now()) return null; // 未来時刻の記録は信頼しない
    return lastAttemptAt;
  } catch {
    return null;
  }
}

/**
 * spawn を試みた時点を記録する（best-effort）。spawn 自体が失敗しても記録は残り、
 * 次のトリガーで再試行を抑制する。記録に失敗した場合は fail-open（従来どおり次回試行）。
 */
function recordAutostartAttempt(workspace) {
  try {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(autostartAttemptPath(workspace), JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');
  } catch {
    // best-effort。失敗しても呼び出し元の処理は継続する。
  }
}

/**
 * 試行記録を消す（生存を観測した時点で呼ぶ）。成功した spawn の直後から記録を残し続けると、
 * 生存中のクールダウン残り時間分だけ次回の復活を遅らせてしまうため。
 */
function clearAutostartAttempt(workspace) {
  try { fs.unlinkSync(autostartAttemptPath(workspace)); } catch {}
}

/**
 * orchestrator モードの msg-poll.js が稼働していなければ、detachedプロセスとして
 * 自動起動を試みる。best-effort。失敗しても例外を投げず、呼び出し元の処理を継続させる。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - msg-poll.js が置かれているディレクトリ
 */
function ensureMsgPollOrchestratorRunning({ workspace, scriptsPath }) {
  if (!workspace || !scriptsPath) return;

  // migrate-records.js の移行実行中（マーカーファイル存在中）は自動起動を見送る。
  // 移行中に復活すると移行先の空状態で記録を上書きしかけるため（Issue #256）。
  // 既存の live 判定と同様、起動を見送るだけで例外は投げない。
  if (isMigrationInProgress(workspace)) return;

  try {
    if (_findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null })) {
      clearAutostartAttempt(workspace); // 生存を観測 → 失敗試行の記録を消す
      return; // 既に稼働中 → spawn・セッションPID解決とも不要
    }
    // registry に無くても role lease が live なら二重起動を避けて spawn しない。
    // lease が排他の正本（Issue #240）。workspace 表記の差異は role lease 側の正規化で吸収される。
    if (_isResidentLeaseLive({ workspace, role: MSGPOLL_ORCHESTRATOR_ROLE })) {
      clearAutostartAttempt(workspace); // 生存を観測 → 失敗試行の記録を消す
      return;
    }
  } catch {
    // 判定失敗時はfail-openで従来通りspawnを試みる（多重起動はmsg-poll.js自身のlease取得が防ぐ）
  }

  // 自動復活の有界化（PR #302 指摘）: 直前の spawn 試行がクールダウン内なら再試行しない。
  // lease 拒否・起動直後の異常終了・spawn 失敗はすべて「次のトリガー時点では稼働中ではない」
  // としか見えないため、この単一の上限管理に含まれる（決定的コードの時刻比較のみで判定）。
  const lastAttemptAt = readAutostartAttempt(workspace);
  if (lastAttemptAt !== null && Date.now() - lastAttemptAt < AUTOSTART_COOLDOWN_MS) {
    return;
  }

  let logFd;
  try {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    logFd = fs.openSync(path.join(ghDir, 'msg-poll-orchestrator-autostart.log'), 'a');

    const args = [
      path.join(scriptsPath, 'msg-poll.js'),
      'orchestrator',
      '--workspace', workspace,
    ];

    try {
      const sessionPid = _findSessionRootPid();
      if (Number.isFinite(sessionPid) && sessionPid > 0) {
        args.push('--session-pid', String(sessionPid));
      }
    } catch {
      // 解決失敗時は従来通り子プロセス側の自動検出にフォールバックする
    }

    // spawn を試みた時点を記録（クールダウン。best-effort）。spawn が失敗しても記録は残り、
    // 次のトリガーで再試行を抑制する。起動直後に msg-poll が異常終了しても同様に抑制される。
    recordAutostartAttempt(workspace);

    const child = _spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best-effort起動なので失敗しても呼び出し元の処理は継続する
  } finally {
    if (logFd !== undefined) {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

module.exports = {
  ensureMsgPollOrchestratorRunning,
  AUTOSTART_COOLDOWN_MS,
  _setSpawn: (fn) => { _spawn = fn; },
  _setFindSessionRootPid: (fn) => { _injectedFindSessionRootPid = fn; },
  _setFindRunningInstance: (fn) => { _injectedFindRunningInstance = fn; },
  _setIsResidentLeaseLive: (fn) => { _isResidentLeaseLive = fn; },
};
