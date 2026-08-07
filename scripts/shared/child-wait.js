'use strict';
// child-wait.js — 子プロセスの終了をタイムアウト付きで待つ共有ヘルパー。
//
// 背景: run-council-jobs.js の launchParticipantJob と run-council-investigation.js の
// launchInvestigationJob が、それぞれ「setTimeout → killProcessTree → cleanup登録 →
// close/error で解決」を独立に実装していた（Issue #232 反省会指摘 #2）。
// Windows で親シェルのみ kill すると子孫（ログインシェル → エージェントCLI）が
// 孤児として残るため、タイムアウト時はプロセスツリーごと終了する
// （killProcessTree: Windows taskkill /T、Unix プロセスグループ kill）。
//
// 設計: 「タイムアウト→ツリーkill・close/error 解決・クリーンアップ登録」の核を
// 本ヘルパーに持たせ、close 後の差分（stderr→ログfdの閉鎖・promptファイル後始末・
// stdout からの JSON 抽出・スキーマ検証）は呼び出し側に委ねる。onCleanup は
// close / error どちらの経路でも丁度1回実行される（クリーンアップの二重実行を防ぐ）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { killProcessTree } = require('../kill-tree');

/**
 * 子プロセスの close / error を待つ。timeoutMs 到達時はプロセスツリーごと終了させる。
 *
 * @param {object} opts
 * @param {object} opts.child      spawn 済みの ChildProcess（stdout 等は呼び出し側が事前に購読する）
 * @param {number} opts.timeoutMs  この時間内に close / error が来なければ killProcessTree(child.pid)
 * @param {Function} [opts.onCleanup] close / error のどちらかで丁度1回だけ呼ばれる後始末
 *   （clearTimeout はヘルパー内で行う。呼び出し側は独自の掃除だけを渡す）
 * @returns {Promise<number>} 子プロセスの終了コード（close）
 * @throws {Error} child 'error' イベント（spawn 後の起動失敗など）
 */
function waitChildExit({ child, timeoutMs, onCleanup }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (onCleanup) onCleanup(); } catch {}
      fn(arg);
    };

    timer = setTimeout(() => {
      // タイムアウト: プロセスツリーごと終了（Windows で子孫が孤児化しない）。
      // kill 後は child 'close' イベントで resolve される。
      try { killProcessTree(child.pid); } catch {}
    }, timeoutMs);

    child.on('close', (code) => finish(resolve, code));
    child.on('error', (err) => finish(reject, err));
  });
}

module.exports = { waitChildExit };
