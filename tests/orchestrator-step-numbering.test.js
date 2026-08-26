'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'SKILL.md');

function readDevelopmentCycle() {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const start = content.indexOf('## 開発サイクル');
  assert.notEqual(start, -1, '開発サイクルの見出しが存在すること');
  return content.slice(start);
}

test('開発サイクルの13工程が順番どおり必須／任意に区分されている', () => {
  const cycle = readDevelopmentCycle();
  const headings = [...cycle.matchAll(/^### (\d+)\. ([^\r\n]+)$/gm)];
  const expectedTitles = [
    '要件確定',
    '必要な調査',
    'Architect起動判断',
    '抽象設計の検討',
    'Coder起動',
    '計画評価',
    '実装開始指示',
    'PR検出',
    'レビュー監視',
    'コメントトリアージ',
    'マージ',
    '本番公開（CI/CD）確認',
    '反省会と後始末'
  ];

  assert.equal(headings.length, expectedTitles.length, '大項目が13件あること');
  headings.forEach((match, index) => {
    assert.equal(Number(match[1]), index + 1, `大項目${index + 1}の番号が連番であること`);
    assert.ok(match[2].includes(expectedTitles[index]), `大項目${index + 1}の名称が保持されていること`);
    assert.match(match[2], /【(?:必須|任意)】/, `大項目${index + 1}に必須／任意の区分があること`);
  });
});

test('中項目が工程内の総数を含む一意な番号で連番になっている', () => {
  const cycle = readDevelopmentCycle();
  const matches = [
    ...cycle.matchAll(/^(?:#### |- \*\*)(\d+)-\[(\d+)\/(\d+)\][^\r\n]*$/gm)
  ];
  const expectedTotals = new Map([
    [1, 3],
    [6, 5],
    [7, 2],
    [8, 1],
    [11, 1],
    [12, 2],
    [13, 3]
  ]);
  const seen = new Set();
  const byStage = new Map();

  for (const match of matches) {
    const stage = Number(match[1]);
    const index = Number(match[2]);
    const total = Number(match[3]);
    const id = `${stage}-[${index}/${total}]`;
    assert.equal(seen.has(id), false, `中項目${id}が重複していないこと`);
    seen.add(id);
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push({ index, total });
  }

  assert.deepEqual([...byStage.keys()].sort((a, b) => a - b), [...expectedTotals.keys()]);
  for (const [stage, total] of expectedTotals) {
    const items = byStage.get(stage);
    assert.equal(items.length, total, `工程${stage}の中項目総数が一致すること`);
    assert.deepEqual(items.map(item => item.index), Array.from({ length: total }, (_, index) => index + 1));
    assert.ok(items.every(item => item.total === total), `工程${stage}の総数表記が統一されていること`);
  }
});

test('工程番号の呼称・任意工程のスキップ規約があり、裸の手順番号が残っていない', () => {
  const cycle = readDevelopmentCycle();

  assert.match(cycle, /大項目は `1\.`〜`13\.` の固定番号/);
  assert.match(cycle, /中項目は `大項目-\[項目番号\/その工程内の総数\]`/);
  assert.match(cycle, /`6-\[3\/4\]`/);
  assert.match(cycle, /人間に提示・依頼するときは、本文冒頭で実行中の工程番号を名乗る/);
  assert.match(cycle, /任意工程を飛ばす場合は、.*工程番号と理由を明示して名乗る/);
  assert.deepEqual(
    cycle.split(/\r?\n/).filter(line => /^\s*\d+\.\s/.test(line)),
    [],
    '開発サイクル内に工程番号のない裸の手順番号がないこと'
  );
});
