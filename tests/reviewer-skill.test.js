'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REVIEWER_DIR = path.join(__dirname, '..', 'skills', 'gh-maestro-reviewer');

function readSkillAsset(name) {
  return fs.readFileSync(path.join(REVIEWER_DIR, name), 'utf8');
}

test('gh-maestro-reviewer: 共通SKILL.mdは起動フェーズに応じた手順ファイルを案内する', () => {
  // 参照先（フェーズ別の手順ファイル名）だけを確かめる。文言は検査しない。
  const skill = readSkillAsset('SKILL.md');
  assert.match(skill, /phase1-planning\.md/);
  assert.match(skill, /phase2-integration\.md/);
});

test('gh-maestro-reviewer: フェーズ1手順は print-review-leaves と葉の識別子を参照する', () => {
  const phase1 = readSkillAsset('phase1-planning.md');
  // 参照先: 葉の一覧を出すスクリプトと、実装の葉の識別子（scripts/shared/review-aspects.js）
  assert.match(phase1, /node "\{\{SCRIPTS_PATH\}\}\/print-review-leaves\.js"/);
  assert.match(phase1, /correctness\/logic-invariants/);
  assert.match(phase1, /resilience-security\/failure-recovery/);
  assert.match(phase1, /maintainability\/design-quality/);
  assert.match(phase1, /test-quality\/test-quality/);
});

test('gh-maestro-reviewer: フェーズ2手順は finalize-review.js と統合の入力フィールドを参照する', () => {
  const phase2 = readSkillAsset('phase2-integration.md');
  // 参照先: 統合を行うスクリプトと、統合 findings の入力フィールド名
  assert.match(phase2, /finalize-review\.js/);
  assert.match(phase2, /verified_references/);
});
