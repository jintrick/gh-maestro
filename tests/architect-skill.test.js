'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const architectSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-architect', 'SKILL.md'), 'utf8');

test('architect skill は投稿の手順（フラグ・実行記録の遷移・宛先）を案内する', () => {
  // 参照先（msg-send.js のフラグ、実行記録の completed 遷移、orchestrator への投稿）だけを確かめる。
  // 見出しや言い回しは検査しない。
  assert.match(architectSkill, /--raw --execution-id/);
  assert.match(architectSkill, /投稿が成功すると、実行記録は `completed`/);
  assert.match(architectSkill, /msg-send\.js" orchestrator/);
});
