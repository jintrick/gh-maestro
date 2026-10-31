'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const setupSkillPath = path.join(ROOT, 'skills', 'gh-maestro-test-setup', 'SKILL.md');
const maestroSkillPath = path.join(ROOT, 'skills', 'gh-maestro', 'SKILL.md');

test('gh-maestro-test-setup: frontmatter の name と層・並列数の設定キーを参照する', () => {
  assert.equal(fs.existsSync(setupSkillPath), true);
  const content = fs.readFileSync(setupSkillPath, 'utf8');

  assert.match(content, /^name: gh-maestro-test-setup$/m);
  assert.match(content, /テスト関数単位/);
  assert.match(content, /重いテストが1つも無い場合は層を分けず/);
  assert.match(content, /既存の `slow`、`integration`、`e2e`/);
  assert.match(content, /dynamicConcurrency/);
  assert.match(content, /cpuReserve/);
  assert.match(content, /reviewJobCost/);
  assert.doesNotMatch(content, /spawn-worker\.js|agents\.yaml|msg-send\.js/);
});

test('gh-maestro-orchestrator: stage-7 が slow 層の動的並列数の設定キーと review-job を参照する', () => {
  const content = fs.readFileSync(path.join(ROOT, 'skills', 'gh-maestro-orchestrator', 'stage-7-review-merge.md'), 'utf8');
  assert.match(content, /dynamicConcurrency/);
  assert.match(content, /review-job/);
});

test('gh-maestro: 宣言状態に応じてtest-setupスキルを読む起動手順を持つ', () => {
  const content = fs.readFileSync(maestroSkillPath, 'utf8');
  assert.match(content, /TEST_LAYERS_STATUS/);
  assert.match(content, /gh-maestro-test-setup/);
  assert.match(content, /`missing` または `invalid`/);
});
