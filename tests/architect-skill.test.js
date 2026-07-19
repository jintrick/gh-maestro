'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const architectSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-architect', 'SKILL.md'), 'utf8');
const orchestratorSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-orchestrator', 'SKILL.md'), 'utf8');

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

test('orchestrator skill は要件確定、調査、architect起動判断、coder向け実装指示確定の順で基本フローを定義する', () => {
  const requirements = orchestratorSkill.indexOf('**要件確定**');
  const research = orchestratorSkill.indexOf('**必要な調査**');
  const architect = orchestratorSkill.indexOf('**Architect起動判断**');
  const implementation = orchestratorSkill.indexOf('**Coder向け実装指示の確定**');
  const coder = orchestratorSkill.indexOf('**Coder起動**');
  assert.ok(requirements < research && research < architect && architect < implementation && implementation < coder);
  assert.match(orchestratorSkill, /必要な explorer\/investigator の再調査/);
  assert.match(orchestratorSkill, /要件本文を変更できるのは人間との合意/);
  assert.match(orchestratorSkill, /既存の `msg-send\.js` 経路/);
  assert.match(orchestratorSkill, /人間が削除を許可した後にだけ実行/);
  assert.match(orchestratorSkill, /architect は対象 Issue がクローズされるまで任意の相談役として維持/);
  assert.match(orchestratorSkill, /相談を開始するかどうか、その時機、相談内容は人間が決める/);
  assert.match(orchestratorSkill, /大規模リファクタリング/);
  assert.match(orchestratorSkill, /新規案件または新規機能/);
  assert.match(orchestratorSkill, /規模や新規性だけを理由に必須起動してはならない/);
  assert.match(orchestratorSkill, /抽象設計の論点・選択肢・トレードオフ/);
  assert.match(orchestratorSkill, /具体的な実装手順・コード調査/);
  assert.doesNotMatch(orchestratorSkill, /gh-maestro-architect` \|.*実装計画/);
});
