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
      return; // 既に稼働中 → spawn・セッションPID解決とも不要
    }
    // registry に無くても role lease が live なら二重起動を避けて spawn しない。
    // lease が排他の正本（Issue #240）。workspace 表記の差異は role lease 側の正規化で吸収される。
    if (_isResidentLeaseLive({ workspace, role: MSGPOLL_ORCHESTRATOR_ROLE })) {
      return;
    }
  } catch {
    // 判定失敗時はfail-openで従来通りspawnを試みる（多重起動はmsg-poll.js自身のlease取得が防ぐ）
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
  _setSpawn: (fn) => { _spawn = fn; },
  _setFindSessionRootPid: (fn) => { _injectedFindSessionRootPid = fn; },
  _setFindRunningInstance: (fn) => { _injectedFindRunningInstance = fn; },
  _setIsResidentLeaseLive: (fn) => { _isResidentLeaseLive = fn; },
};
