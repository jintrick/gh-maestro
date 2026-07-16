'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const architectSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-architect', 'SKILL.md'), 'utf8');
const orchestratorSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-orchestrator', 'SKILL.md'), 'utf8');

test('architect skill は通信・完了・入力境界・手順・再試行を構造化して明記する', () => {
  for (const heading of ['通信規約', 'ゴールと終了条件', '起動時に与えられる情報', '入力の境界', '手順', '投稿失敗と再試行']) {
    assert.match(architectSkill, new RegExp(`## ${heading}`));
  }
  assert.match(architectSkill, /要件定義の変更/);
  assert.match(architectSkill, /自律的なリポジトリ探索/);
  assert.match(architectSkill, /--raw --execution-id/);
  assert.match(architectSkill, /投稿が成功し、コメント URL を得られた時だけ/);
  assert.match(architectSkill, /msg-send\.js" orchestrator/);
  assert.match(architectSkill, /\{\{INBOX_POLL_MECHANISM\}\}/);
  assert.match(architectSkill, /ワーカーを終了するかどうかは orchestrator だけが決め/);
  assert.match(architectSkill, /自分で終了してはならない/);
});

test('orchestrator skill は再調査と要件不変を明記する', () => {
  assert.match(orchestratorSkill, /必要な explorer\/investigator の再調査/);
  assert.match(orchestratorSkill, /要件本文を変更できるのは人間との合意/);
  assert.match(orchestratorSkill, /既存の `msg-send\.js` 経路/);
  assert.match(orchestratorSkill, /architect ワーカーの終了ではない/);
});
