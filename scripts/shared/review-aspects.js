'use strict';
// 共有: skills/gh-maestro-reviewer/ 配下から既知の観点（葉）名を動的に取得する。
// ハードコードした一覧を持たず、実際に存在するファイルをスキャンして一致判定に使う。

const fs = require('fs');
const path = require('path');

const DEFAULT_REVIEWER_SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'gh-maestro-reviewer');

/**
 * skills/gh-maestro-reviewer/<幹>/<葉>.md をスキャンし、葉名（拡張子なし）の一覧を返す。
 * SKILL.md（幹直下のファイル）は葉として扱わない。
 *
 * @param {string} [reviewerSkillDir]
 * @returns {string[]} ソート済みの葉名一覧
 */
function listKnownAspects(reviewerSkillDir = DEFAULT_REVIEWER_SKILL_DIR) {
  const aspects = [];
  let trunkEntries;
  try {
    trunkEntries = fs.readdirSync(reviewerSkillDir, { withFileTypes: true });
  } catch {
    return aspects;
  }
  for (const trunk of trunkEntries) {
    if (!trunk.isDirectory()) continue;
    const trunkDir = path.join(reviewerSkillDir, trunk.name);
    let leafEntries;
    try {
      leafEntries = fs.readdirSync(trunkDir);
    } catch {
      continue;
    }
    for (const leaf of leafEntries) {
      if (!leaf.endsWith('.md')) continue;
      aspects.push(path.basename(leaf, '.md'));
    }
  }
  return aspects.sort();
}

module.exports = { listKnownAspects, DEFAULT_REVIEWER_SKILL_DIR };
