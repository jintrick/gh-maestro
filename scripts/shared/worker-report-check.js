'use strict';
// worker-report-check.js — ワーカーが自分の直近の起動（resume）以降に、
// orchestrator へ報告コメント（msg-send.js経由）を投稿済みかどうかを判定する（Issue #263）。
//
// 判定は「報告コメントの有無」という事実だけで行い、経過時間・ログ更新時刻は使わない。
// 長考しているだけの正常なワーカーを誤って異常扱いしないための制約であり、意図的に
// タイムアウト相当の閾値を持たない。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { parseMarker } = require('../msg-poll');

/**
 * 与えられたコメント一覧の中に、対象ワーカー自身から orchestrator 宛ての報告
 * （marker の from === workerName かつ to === 'orchestrator'）で、直近の起動時刻
 * （startTime）以降に投稿された最新のコメントを取得する。
 *
 * @param {object[]} comments    - gh api の comments 応答（id/created_at/body を含む）
 * @param {string} workerName
 * @param {string|null} startTime  - ワーカープロセスの起動時刻（ISO 8601文字列）
 * @returns {object|null}  最新の報告コメントオブジェクト。該当なしまたは判定不能時は null
 */
function getLatestReportSinceStart(comments, workerName, startTime) {
  if (!startTime) return null;
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  if (!Array.isArray(comments)) return null;

  let latest = null;
  let latestMs = -1;

  for (const c of comments) {
    if (!c || !c.created_at) continue;
    const meta = parseMarker(c.body);
    if (!meta || meta.from !== workerName || meta.to !== 'orchestrator') continue;

    // ISO文字列同士の精度差（ミリ秒 vs 秒）による誤判定を避けるため、数値化してから
    // 比較する（.claude/rules/process-lifecycle-scripts.md 参照）。
    const createdMs = new Date(c.created_at).getTime();
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs >= startMs) {
      if (createdMs >= latestMs) {
        latest = c;
        latestMs = createdMs;
      }
    }
  }
  return latest;
}

/**
 * 与えられたコメント一覧の中に、対象ワーカー自身から orchestrator 宛ての報告
 * （marker の from === workerName かつ to === 'orchestrator'）で、直近の起動時刻
 * （startTime）以降に投稿されたものが含まれるか判定する。
 *
 * to を確認しないと、他ワーカー宛てに転送・言及されただけのコメントや、たまたま
 * from が一致する無関係なマーカー付きコメントまで「orchestratorへの報告」として
 * 誤認しうる。
 *
 * @param {object[]} comments    - gh api の comments 応答（id/created_at/body を含む）
 * @param {string} workerName
 * @param {string|null} startTime  - ワーカープロセスの起動時刻（ISO 8601文字列）
 * @returns {boolean|null}  true=報告済み, false=未報告, null=startTimeが無い/不正で判定不能
 */
function hasReportedSinceStart(comments, workerName, startTime) {
  if (!startTime) return null;
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  if (!Array.isArray(comments)) return null;

  return getLatestReportSinceStart(comments, workerName, startTime) !== null;
}

/**
 * 経過時間を人間可読な形式（例: "3秒", "5分12秒", "1時間2分3秒"）にフォーマットする。
 *
 * @param {string|number|Date} from - 開始日時
 * @param {string|number|Date} [to=Date.now()] - 終了日時（省略時は現在日時）
 * @returns {string}
 */
function formatElapsedTime(from, to = Date.now()) {
  const fromMs = typeof from === 'number' ? from : new Date(from).getTime();
  const toMs = typeof to === 'number' ? to : new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return '0秒';
  }
  const diffMs = Math.max(0, toMs - fromMs);
  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) {
    return `${hours}時間${minutes}分${seconds}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

module.exports = {
  hasReportedSinceStart,
  getLatestReportSinceStart,
  formatElapsedTime,
};
