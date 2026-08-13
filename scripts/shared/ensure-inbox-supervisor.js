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
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('../child-process');
const { isResidentLeaseLive, INBOX_SUPERVISOR_ROLE } = require('./worker-lease');
const { isMigrationInProgress } = require('./migration-marker');

// process-lifecycle への依存は呼び出し時点で解決する（Issue #267）。CLI 主経路
// （require.main === module）から sweepRegistry 経由でこのモジュールが require される
// 可能性を踏まえ、評価時に捕捉すると module.exports 未確定の undefined を掴むため、
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
 * inbox-supervisor.js が稼働していなければ、detachedプロセスとして自動起動を試みる。
 * best-effort。失敗しても例外を投げず、呼び出し元の処理を継続させる。
 *
 * @param {object} params
 * @param {string} params.workspace   - ワークスペース絶対パス
 * @param {string} params.scriptsPath - inbox-supervisor.js が置かれているディレクトリ
 */
function ensureInboxSupervisorRunning({ workspace, scriptsPath }) {
  if (!workspace || !scriptsPath) return;

  // migrate-records.js の移行実行中（マーカーファイル存在中）は自動起動を見送る。
  // 移行中に復活すると移行先の空状態で記録を上書きしかけるため（Issue #256）。
  // 既存の live 判定と同様、起動を見送るだけで例外は投げない。
  if (isMigrationInProgress(workspace)) return;

  try {
    if (_findRunningInstance(workspace, { script: 'inbox-supervisor.js', workerName: null })) {
      return; // 既に稼働中 → spawn・セッションPID解決とも不要
    }
    // registry に無くても role lease が live なら二重起動を避けて spawn しない。
    // lease が排他の正本（Issue #240）。workspace 表記の差異は role lease 側の正規化で吸収される。
    if (_isResidentLeaseLive({ workspace, role: INBOX_SUPERVISOR_ROLE })) {
      return;
    }
  } catch {
    // 判定失敗時はfail-openで従来通りspawnを試みる（多重起動はinbox-supervisor.js自身のlease取得が防ぐ）
  }

  let logFd;
  try {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    logFd = fs.openSync(path.join(ghDir, 'inbox-supervisor-autostart.log'), 'a');

    const args = [
      path.join(scriptsPath, 'inbox-supervisor.js'),
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
  ensureInboxSupervisorRunning,
  _setSpawn: (fn) => { _spawn = fn; },
  _setFindSessionRootPid: (fn) => { _injectedFindSessionRootPid = fn; },
  _setFindRunningInstance: (fn) => { _injectedFindRunningInstance = fn; },
  _setIsResidentLeaseLive: (fn) => { _isResidentLeaseLive = fn; },
};
