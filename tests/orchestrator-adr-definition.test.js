'use strict';

// ADR定義が「どこに在るか」という構造的性質だけを見るテスト（Issue #421）。
// 個々のADRが3条件を満たすかどうかの判定は推論であり、機械的に検証・強制しない。
// ここで守るのは、判断が決まった場面で定義が文脈にあること——すなわち3条件と
// 「却下した案を作文しない」旨が、別ファイルへの参照ではなくSKILL.md本文に
// 直接書かれていること——だけである。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'SKILL.md');
const SECTION_HEADING = '### 設計判断の記録（ADR）';

function readAdrSection() {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const start = content.indexOf(SECTION_HEADING);
  assert.notEqual(start, -1, 'ADRの定義節が存在すること');

  const rest = content.slice(start + SECTION_HEADING.length);
  const end = rest.search(/\r?\n### /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test('ADRの定義がオーケストレーターSKILL.mdに揃っている', () => {
  const section = readAdrSection();
  const required = [
    [/いつ書くか/, 'いつ書くか'],
    [/3条件/, 'ADRにする3条件'],
    [/書式/, '書式と見出し'],
    [/採番/, '採番'],
    [/覆した/, '既存ADRを覆したときの扱い'],
    [/3条件を満たさない判断の行き先/, '3条件を満たさない判断の行き先'],
  ];

  for (const [pattern, label] of required) {
    assert.match(section, pattern, `ADRの定義節が「${label}」を含むこと`);
  }
});

test('3条件と作文の禁止がSKILL.md本文にあり、別ファイルへの参照になっていない', () => {
  const section = readAdrSection();

  assert.match(section, /覆すコストが大きい/, '条件1が本文にあること');
  assert.match(section, /なぜこうなっているのか/, '条件2が本文にあること');
  assert.match(section, /実際に選択肢があり/, '条件3が本文にあること');
  assert.match(section, /作文してはならない/, '却下した案を作文しない旨が本文にあること');
  assert.match(section, /機械的に検出も強制もできない/, '遵守の限界が本文にあること');
});

test('ADRの定義節が開発サイクルより前に置かれている', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.ok(
    content.indexOf(SECTION_HEADING) < content.indexOf('## 開発サイクル'),
    'ADRの定義節が工程の記述より前にあること',
  );
});
