'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const architectSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-architect', 'SKILL.md'), 'utf8');
const orchestratorSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-orchestrator', 'SKILL.md'), 'utf8');

test('architect skill は要件不変・直接コメント・成功時のみ完了を明記する', () => {
  assert.match(architectSkill, /要件定義を変更しない/);
  assert.match(architectSkill, /自律的なリポジトリ探索/);
  assert.match(architectSkill, /--raw --execution-id/);
  assert.match(architectSkill, /投稿成功時だけ実行記録を完了/);
});

test('orchestrator skill は再調査と要件不変を明記する', () => {
  assert.match(orchestratorSkill, /必要な explorer\/investigator の再調査/);
  assert.match(orchestratorSkill, /要件本文を変更できるのは人間との合意/);
});
