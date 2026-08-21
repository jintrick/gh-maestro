'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const architectSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-architect', 'SKILL.md'), 'utf8');

test('architect skill は通信・完了・入力境界・手順・再試行を構造化して明記する', () => {
  for (const heading of ['通信規約', '起動時に与えられる情報', '入力の境界', '手順', '投稿失敗と再試行']) {
    assert.match(architectSkill, new RegExp(`## ${heading}`));
  }
  assert.match(architectSkill, /## ゴールと(?:終了条件|責務)/);
  assert.match(architectSkill, /要件定義の変更/);
  assert.match(architectSkill, /自律的なリポジトリ探索/);
  assert.match(architectSkill, /--raw --execution-id/);
  assert.match(architectSkill, /投稿が成功すると、実行記録は `completed`/);
  assert.match(architectSkill, /msg-send\.js" orchestrator/);
});
