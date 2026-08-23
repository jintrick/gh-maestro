#!/usr/bin/env node
'use strict';
// watchdog-exit-notify.js
// 監視プロセス（msg-poll.js / poll-pr.js / poll-reviews.js / inbox-supervisor.js）が
// 非ゼロ終了したとき、orchestrator へ終了を通知する共有ヘルパー。
//
// 各監視プロセスは process.on('exit') からこの関数を呼ぶ。best-effort であり、
// 通知の失敗（監査記録の失敗・送信先Issueの欠如等）で throw せず、プロセスの終了を
// 妨げない。正常終了（exit 0 = SIGINT / SIGTERM / MERGED / CLOSED）では何もしない。
//
// 親セッション消滅（dead-man's switch の検出）は exit 0 ではなく
// PARENT_DEATH_EXIT_CODE（3）で終了し、この関数が専用の本文で通知する（Issue #301）。
// exit 3 は非ゼロのため、Monitor の「非ゼロ終了 = 異常のアラーム」経路にも載る
// （監視中に止まっても沈黙しない）。
//
// 監視プロセスの内部通知は Issue コメントへ投稿せず、poller が消費する監査キューへ
// 記録する。msg-poll.js 自身だけは終了直前に自分の監査キューを読めないため、Monitorの
// stdoutへ直接出力する。

const path = require('path');
const fs = require('fs');
const { recordResidentNotification, formatResidentNotification } = require('./resident-audit');

/**
 * 親セッション消滅による自滅終了（dead-man's switch 検出）の終了コード。
 * exit 0 にすると正常終了として扱われ、Monitor の異常終了アラーム経路と
 * watchdog 通知の両方が無効化されるため、非ゼロコードを割り当てる（Issue #301）。
 */
const PARENT_DEATH_EXIT_CODE = 3;

/**
 * orchestrator への監視プロセス終了通知。
 * 非ゼロ終了時にのみ通知する。best-effort（throwしない）。
 *
 * @param {object} params
 * @param {string} params.workspace ワークスペース
 * @param {string} params.scriptName この監視プロセスのスクリプト名（--from に使う）
 * @param {string} [params.issue] 送信先Issue番号（省略時は workers.json の先頭ワーカーのIssueを解決）
 * @returns {boolean} 通知を投稿したか（正常終了・送信先なし・投稿失敗は false）
 */
function notifyWatchdogExit({ workspace, scriptName, issue }) {
  // 非ゼロ終了のときだけ通知する。正常終了（exit 0）は何もしない。
  const exitCode = Number.isFinite(process.exitCode) ? process.exitCode : 0;
  if (exitCode === 0) return false;

  const resolvedIssue = issue || resolveNotifyIssue(workspace);
  if (scriptName === 'msg-poll.js') {
    const isParentDeath = exitCode === PARENT_DEATH_EXIT_CODE;
    const body = isParentDeath
      ? `監視プロセス ${scriptName} が親セッションの消滅を検出して自動終了しました（exit code ${PARENT_DEATH_EXIT_CODE}）。監視していたセッションが終了したため、その監視も停止しています。`
      : `⚠️ 監視プロセス ${scriptName} が異常終了しました（exit code ${exitCode}）。プロセスが予期せず終了したため、その監視は停止しています。`;
    try {
      // msg-poll自身の監査ファイルは、異常終了した本人が読むため届かない。
      // 終了フックからMonitorのstdoutへ同期出力し、Issueコメントには投稿しない。
      process.stdout.write(`${formatResidentNotification(scriptName, body)}\n`);
      return true;
    } catch (e) {
      process.stderr.write(`watchdog-exit-notify: ${scriptName} 異常終了通知の記録に失敗: ${e.message}\n`);
      return false;
    }
  }
  if (!resolvedIssue) {
    process.stderr.write(`watchdog-exit-notify: ${scriptName} 異常終了（exit ${exitCode}）ですが送信先Issueがありません。通知を送信できません。\n`);
    return false;
  }

  // exit 3（親セッション消滅）は設計された終了のため専用の本文にする。それ以外の
  // 非ゼロは従来どおり異常終了として警告する。
  const isParentDeath = exitCode === PARENT_DEATH_EXIT_CODE;
  const body = isParentDeath
    ? `監視プロセス ${scriptName} が親セッションの消滅を検出して自動終了しました（exit code ${PARENT_DEATH_EXIT_CODE}）。監視していたセッションが終了したため、その監視も停止しています。`
    : `⚠️ 監視プロセス ${scriptName} が異常終了しました（exit code ${exitCode}）。プロセスが予期せず終了したため、その監視は停止しています。`;
  try {
    recordResidentNotification({ workspace, source: scriptName, issue: resolvedIssue, body });
    return true;
  } catch (e) {
    process.stderr.write(`watchdog-exit-notify: ${scriptName} 異常終了通知の記録に失敗: ${e.message}\n`);
    return false;
  }
}

/**
 * orchestrator モードの通知先Issueを解決する。
 * workers.json の先頭ワーカーの issue を使う（msg-poll.js の resolveNotifyIssue と同型）。
 * @param {string} workspace
 * @returns {string|null}
 */
function resolveNotifyIssue(workspace) {
  try {
    const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
    if (fs.existsSync(workersPath)) {
      const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
      const first = Object.values(workers || {}).find((w) => w && w.issue);
      if (first && first.issue) return String(first.issue);
    }
  } catch {}
  return null;
}

module.exports = { notifyWatchdogExit, resolveNotifyIssue, PARENT_DEATH_EXIT_CODE };
