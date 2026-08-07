'use strict';
// resident-audit.js — 常駐プロセスの排他制御（role lease）の監査イベント記録
//
// 責務:
//   msg-poll.js / inbox-supervisor.js などの常駐プロセスが role lease の排他制御で
//   「起動を拒否された（lock-denied）」「既存所有者の終了を待って引き継ぎに入った
//   （handoff-wait）」場合に、その事実を workspace runtime の共通領域へ同期記録する。
//
//   orchestrator は各巡回（msg-poll.js orchestrator モード）で未処理イベントを
//   読み出し、処理済み化（削除）してから標準出力へ出力する。GitHub への投稿は
//   しない（投稿判断は orchestrator 側の責務）。
//
//   Issue #240: 常駐プロセスの多重起動を排他制御する role lease を導入する際、
//   「誰がいつ拒否されたか」を誰も観測できないまま黙って失敗させないための
//   観測経路。fail-closed-safety-guards.md 準拠で、記録できないまま排他制御を
//   素通りさせない（I/O失敗は例外を伝播し、呼び出し元は本稼働へ進まない）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const path = require('path');
const fs = require('fs');
const { workspaceRuntimeDir, assertValidWorkspace, assertDisjointRoots } = require('./storage-layout');

/** 記録するイベント種別（取得側が未知種別を誤って受理しないよう固定値で宣言する）。 */
const EVENT_TYPES = Object.freeze(['lock-denied', 'handoff-wait']);

// 同一プロセス内でのファイル名一意化用。プロセス間は pid + Date.now() で分離する。
let _seq = 0;

/**
 * 監査イベントの保存先ディレクトリを返す。
 * ワークスペース検証は fail closed で行う（不正な workspace で書いてはいけない）。
 *
 * @param {string} workspace
 * @returns {string}
 */
function auditDir(workspace) {
  assertValidWorkspace(workspace);
  return path.join(workspaceRuntimeDir(workspace), 'resident-audit');
}

/**
 * 監査イベントを同期記録する。
 *
 * 1イベント1ファイル（<unixMs>-<pid>-<seq>.json）。同期I/Oで即座にディスクへ反映し、
 * 記録後のクラッシュでもイベント自体は残る。I/O失敗は例外を伝播する（fail closed）。
 *
 * @param {object} opt
 * @param {string} opt.workspace ワークスペース絶対パス
 * @param {string} opt.type      EVENT_TYPES のいずれか
 * @param {string} opt.role      固定role名（例: inbox-supervisor, msgpoll-orchestrator）
 * @param {object} [opt.detail]  監査に残す付加情報（ownerPid 等）
 * @returns {string} 書き込んだファイルの絶対パス
 * @throws {Error} 未知の種別 / workspace 検証失敗 / I/O失敗
 */
function recordResidentAuditEvent({ workspace, type, role, detail }) {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`resident-audit: 未知のイベント種別です: ${type}`);
  }
  // runtime root の誤設定（managed root との衝突）で managed root 配下を汚染しないよう、
  // 書き込みの前段で fail closed に中断する（process-lifecycle.js の pidsDir と同型のガード）。
  assertDisjointRoots();
  const dir = auditDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  _seq += 1;
  const id = `${Date.now()}-${process.pid}-${_seq}`;
  const file = path.join(dir, `${id}.json`);
  const event = {
    schemaVersion: 1,
    type,
    role,
    createdAt: new Date().toISOString(),
    detail: detail || {},
  };
  // 'wx'（新規作成のみ）で記録し、ファイル名衝突があれば fail closed で例外にする。
  fs.writeFileSync(file, JSON.stringify(event, null, 2), { encoding: 'utf8', flag: 'wx' });
  return file;
}

/**
 * 未処理の監査イベントを一覧で返す（処理済み化は呼び出し側が removeResidentAuditEvent で行う）。
 *
 * 破損・読めないファイルは読み飛ばす（読めないイベントを勝手に削除・処理済み扱いにしない）。
 *
 * @param {string} workspace
 * @returns {Array<{ file: string, event: object }>} ファイル名順（生成順）
 */
function listUnprocessedResidentAuditEvents(workspace) {
  const dir = auditDir(workspace);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const events = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const event = JSON.parse(raw);
      if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;
      events.push({ file, event });
    } catch {
      // 破損ファイルは残す（後続の人間調査に使える）。読み飛ばすだけ。
      continue;
    }
  }
  events.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return events;
}

/**
 * 処理済みの監査イベントファイルを削除する。
 *
 * 呼び出し側は「出力 → 削除」の順で呼ぶこと。削除前にクラッシュしても
 * イベントが失われず次回再出力される（握り潰ししない）。既に無い場合は何もしない。
 *
 * @param {string} workspace
 * @param {string} file listUnprocessedResidentAuditEvents が返した file 絶対パス
 */
function removeResidentAuditEvent(workspace, file) {
  const dir = auditDir(workspace);
  const resolvedFile = path.resolve(file);
  const resolvedDir = path.resolve(dir);
  // このモジュールが管理するディレクトリ配下のファイルだけを削除対象にする
  // （誤ったパス指定による無関係ファイルの削除を防ぐ）。
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
    throw new Error(`resident-audit: 監査ディレクトリ外のファイルを削除しようとしました: ${file}`);
  }
  try {
    fs.unlinkSync(resolvedFile);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

module.exports = {
  EVENT_TYPES,
  recordResidentAuditEvent,
  listUnprocessedResidentAuditEvents,
  removeResidentAuditEvent,
  auditDir,
};
