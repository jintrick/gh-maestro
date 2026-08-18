'use strict';
// plan-comment.js — Issue の pin 済み計画コメントの識別・抽出・マーカー処理

// 計画コメントを識別するための機械可読マーカー。本文先頭行に埋め込む。
const PLAN_MARKER = '<!-- gh-maestro-plan:v1 -->';

/**
 * コメントオブジェクトが pin 済みの計画コメントであるかを判定する。
 * マーカーは本文の1行目に単独で配置されている必要がある（引用や本文中での言及は対象外）。
 *
 * @param {object} comment
 * @returns {boolean}
 */
function isPlanComment(comment) {
  if (!comment || comment.pin == null || typeof comment.body !== 'string') {
    return false;
  }
  const firstLine = comment.body.split('\n')[0].trim();
  return firstLine === PLAN_MARKER;
}

/**
 * コメント配列から pin 済みの計画コメントを抽出する。
 *
 * @param {object[]} comments
 * @returns {object[]}
 */
function findPlanComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.filter(isPlanComment);
}

/**
 * 本文先頭の計画マーカー行を除去して返す。
 *
 * @param {string} body
 * @returns {string}
 */
function stripPlanMarker(body) {
  if (!body) return '';
  const lines = body.split('\n');
  if (lines.length > 0 && lines[0].trim() === PLAN_MARKER) {
    lines.shift();
  }
  return lines.join('\n');
}

module.exports = {
  PLAN_MARKER,
  isPlanComment,
  findPlanComments,
  stripPlanMarker,
};
