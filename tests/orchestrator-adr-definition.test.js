'use strict';

// ADR定義が「どこに在るか」という構造的性質だけを見るテスト（Issue #421）。
// 個々のADRが3条件を満たすかどうかの判定は推論であり、機械的に検証・強制しない。
// ここで守るのは配置だけである。判断が決まった場で照合する部分（いつ書くか・3条件・
// 作文禁止・遵守の限界・満たさない判断の行き先）がSKILL.md本文に直接あり、書くと
// 決めた後にだけ要る部分（書式・採番・改訂の扱い）がアセットにあること。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SKILL_DIR = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const ASSET_PATH = path.join(SKILL_DIR, 'adr.md');
const SECTION_HEADING = '### 設計判断の記録（ADR）';

function readAdrSection() {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const start = content.indexOf(SECTION_HEADING);
  assert.notEqual(start, -1, 'ADRの定義節が存在すること');

  const rest = content.slice(start + SECTION_HEADING.length);
  const end = rest.search(/\r?\n### /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test('オーケストレーターSKILL.mdのADR定義節が書式を持つ adr.md を開く契機を参照する', () => {
  const section = readAdrSection();
  assert.match(section, /adr\.md/, 'ADRの定義節が adr.md を参照すること');
});

test('書くと決めた後にだけ要る詳細がアセットにある', () => {
  const asset = fs.readFileSync(ASSET_PATH, 'utf8');
  const required = [
    [/書式/, '書式と見出し'],
    [/採番|最大番号/, '採番'],
    [/## 決めたこと[\s\S]*## なぜ[\s\S]*## 却下した案/, '見出しの雛形'],
    [/覆した/, '既存ADRを覆したときの扱い'],
  ];

  for (const [pattern, label] of required) {
    assert.match(asset, pattern, `adr.mdが「${label}」を含むこと`);
  }
});
