'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REVIEWER_DIR = path.join(__dirname, '..', 'skills', 'gh-maestro-reviewer');

function readSkillAsset(name) {
  return fs.readFileSync(path.join(REVIEWER_DIR, name), 'utf8');
}

test('gh-maestro-reviewer: 共通SKILL.mdは起動フェーズに応じた手順ファイルだけを案内する', () => {
  const skill = readSkillAsset('SKILL.md');

  assert.match(skill, /phase1-planning\.md/);
  assert.match(skill, /phase2-integration\.md/);
  assert.match(skill, /## レビュー基準（7葉）/);
  assert.match(skill, /## RMの禁止事項/);
  assert.match(skill, /## 出力形式（参考: 最終findings\.jsonのスキーマ）/);

  assert.doesNotMatch(skill, /### 1\. 証拠の取得/);
  assert.doesNotMatch(skill, /### 4\. 結果の受領/);
  assert.doesNotMatch(skill, /coverage_ledger.*leaves/);
});

test('gh-maestro-reviewer: フェーズ1手順にフェーズ2手順を混在させない', () => {
  const phase1 = readSkillAsset('phase1-planning.md');

  assert.match(phase1, /## RMの責務（フェーズ1: 計画）/);
  assert.match(phase1, /### 1\. 証拠の取得/);
  assert.match(phase1, /node "\{\{SCRIPTS_PATH\}\}\/print-review-leaves\.js"/);
  assert.doesNotMatch(phase1, /SHARED_SKILLS_PATH/);
  assert.match(phase1, /coverage ledger/);
  assert.match(phase1, /manifestのJSON構造/);
  assert.doesNotMatch(phase1, /## RMの責務（フェーズ2/);
  assert.doesNotMatch(phase1, /`RESULTS` ファイル/);
  assert.doesNotMatch(phase1, /finalize-review\.js/);
});

test('gh-maestro-reviewer: フェーズ2手順にフェーズ1手順を混在させない', () => {
  const phase2 = readSkillAsset('phase2-integration.md');

  assert.match(phase2, /## RMの責務（フェーズ2: 統合・完否判断）/);
  assert.match(phase2, /### 4\. 結果の受領/);
  assert.match(phase2, /### 5\. 重複指摘の統合/);
  assert.match(phase2, /finalize-review\.js/);
  assert.doesNotMatch(phase2, /## RMの責務（フェーズ1/);
  assert.doesNotMatch(phase2, /### 1\. 証拠の取得/);
  assert.doesNotMatch(phase2, /coverage ledger/);
  assert.doesNotMatch(phase2, /`MANIFEST` パス/);
});
