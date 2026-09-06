'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const setupSkillPath = path.join(ROOT, 'skills', 'gh-maestro-test-setup', 'SKILL.md');
const maestroSkillPath = path.join(ROOT, 'skills', 'gh-maestro', 'SKILL.md');

test('gh-maestro-test-setup: 人間向けの7手順として層分類からorchestrator開始までを定義する', () => {
  assert.equal(fs.existsSync(setupSkillPath), true);
  const content = fs.readFileSync(setupSkillPath, 'utf8');

  assert.match(content, /^name: gh-maestro-test-setup$/m);
  for (const step of ['1.', '2.', '3.', '4.', '5.', '6.', '7.']) {
    assert.match(content, new RegExp(`^${step.replace('.', '\\.')}`, 'm'));
  }
  assert.match(content, /テスト関数単位/);
  assert.match(content, /承認を得るまで待つ/);
  assert.match(content, /重いテストが1つも無い場合は層を分けず/);
  assert.match(content, /既存の `slow`、`integration`、`e2e`/);
  assert.doesNotMatch(content, /spawn-worker\.js|agents\.yaml|msg-send\.js/);
});

test('gh-maestro: 宣言状態に応じてtest-setupスキルを読む起動手順を持つ', () => {
  const content = fs.readFileSync(maestroSkillPath, 'utf8');
  assert.match(content, /TEST_LAYERS_STATUS/);
  assert.match(content, /gh-maestro-test-setup/);
  assert.match(content, /`missing` または `invalid`/);
});
