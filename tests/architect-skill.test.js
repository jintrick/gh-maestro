'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const architectSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-architect', 'SKILL.md'), 'utf8');
const orchestratorSkill = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-orchestrator', 'SKILL.md'), 'utf8');
const architectDoc = fs.readFileSync(path.join(root, 'skills', 'gh-maestro-orchestrator', 'architect.md'), 'utf8');
const orchestratorFullDoc = orchestratorSkill + '\n' + architectDoc;

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

test('orchestrator skill は要件確定、調査、architect起動判断、抽象設計の検討、coder起動、計画評価、実装開始指示の順で基本フローを定義する', () => {
  const requirements = orchestratorSkill.indexOf('### 1. 要件確定');
  const research = orchestratorSkill.indexOf('### 2. 必要な調査');
  const architect = orchestratorSkill.indexOf('### 3. Architect起動判断');
  const design = orchestratorSkill.indexOf('### 4. 抽象設計の検討');
  const coder = orchestratorSkill.indexOf('### 5. Coder起動');
  const planning = orchestratorSkill.indexOf('### 6. 計画評価');
  const startImpl = orchestratorSkill.indexOf('### 7. 実装開始指示');
  assert.ok(requirements < research && research < architect && architect < design && design < coder && coder < planning && planning < startImpl);
  assert.match(orchestratorFullDoc, /必要な explorer\/diagnostician の再調査/);
  assert.match(orchestratorFullDoc, /要件本文を変更できるのは人間との合意/);
  assert.match(orchestratorFullDoc, /既存の `msg-send\.js` 経路/);
  assert.match(orchestratorFullDoc, /下記「反省会」完了後にのみ実行/);
  assert.match(orchestratorFullDoc, /architect は対象 Issue がクローズされるまで任意の相談役として維持/);
  assert.match(orchestratorFullDoc, /相談を開始するかどうか、その時機、相談内容は人間が決める/);
  assert.match(orchestratorFullDoc, /大規模リファクタリング/);
  assert.match(orchestratorFullDoc, /新規案件または新規機能/);
  assert.match(orchestratorFullDoc, /規模や新規性だけを理由に必須起動してはならない/);
  assert.match(orchestratorFullDoc, /抽象設計の論点・選択肢・トレードオフ/);
  assert.match(orchestratorFullDoc, /具体的な実装手順・コード調査/);
  assert.doesNotMatch(orchestratorSkill, /gh-maestro-architect` \|.*実装計画/);
});
