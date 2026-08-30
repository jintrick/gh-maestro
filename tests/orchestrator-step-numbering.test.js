'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'SKILL.md');
const STAGE_HEADING_RE = /^### (\d+)\. ([^\r\n]+)$/gm;
const STAGE_COUNT_RE = /<!--\s*gh-maestro-structure:\s*stages=(\d+)\s*-->/g;
const STAGE_STRUCTURE_RE = /<!--\s*gh-maestro-structure:\s*middle-items=(\d+)\s*-->/g;

function readDevelopmentCycle() {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const start = content.indexOf('## 開発サイクル');
  assert.notEqual(start, -1, '開発サイクルの見出しが存在すること');
  return content.slice(start);
}

function readStage(cycle, stageNumber) {
  const lines = cycle.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^### ${stageNumber}\\. `).test(line));
  assert.notEqual(start, -1, `工程${stageNumber}の大項目が存在すること`);

  const end = lines.findIndex((line, index) => index > start && /^### \d+\. /.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function readStageHeadings(cycle) {
  return [...cycle.matchAll(STAGE_HEADING_RE)].map(match => ({
    number: Number(match[1]),
    title: match[2],
  }));
}

function readDeclaredStageTotal(cycle) {
  const declarations = [...cycle.matchAll(STAGE_COUNT_RE)];
  assert.equal(declarations.length, 1, '大項目数の構造宣言がちょうど1件あること');
  return Number(declarations[0][1]);
}

function readDeclaredMiddleItemTotal(stage, stageNumber) {
  const declarations = [...stage.matchAll(STAGE_STRUCTURE_RE)];
  assert.equal(
    declarations.length,
    1,
    `工程${stageNumber}に中項目数の構造宣言がちょうど1件あること`,
  );
  return Number(declarations[0][1]);
}

test('開発サイクルの大項目が文書上の連番で必須／任意に区分されている', () => {
  const cycle = readDevelopmentCycle();
  const headings = readStageHeadings(cycle);
  const declaredTotal = readDeclaredStageTotal(cycle);

  assert.equal(headings.length, declaredTotal, '大項目数が文書の構造宣言と一致すること');
  assert.ok(declaredTotal > 0, '大項目数の構造宣言が1件以上であること');
  assert.deepEqual(
    headings.map(heading => heading.number),
    Array.from({ length: headings.length }, (_, index) => index + 1),
    '大項目が1から始まる連番であること',
  );
  for (const heading of headings) {
    assert.match(heading.title, /【(?:必須|任意)】/, `大項目${heading.number}に必須／任意の区分があること`);
  }
});

test('文書が宣言した中項目の構造と記載内容が工程ごとに整合している', () => {
  const cycle = readDevelopmentCycle();
  const headings = readStageHeadings(cycle);
  const declaredTotals = new Map(
    headings.map(heading => [
      heading.number,
      readDeclaredMiddleItemTotal(readStage(cycle, heading.number), heading.number),
    ]),
  );
  const matches = [
    ...cycle.matchAll(/^\s*(?:#### |- \*\*|\*\*)(\d+)-\[(\d+)\/(\d+)\][^\r\n]*$/gm),
  ];
  const byStage = new Map();

  for (const match of matches) {
    const stage = Number(match[1]);
    const index = Number(match[2]);
    const total = Number(match[3]);
    assert.ok(declaredTotals.has(stage), `中項目の工程${stage}が大項目として存在すること`);
    assert.ok(index >= 1, `工程${stage}の中項目番号が1以上であること`);
    assert.ok(total >= index, `工程${stage}の中項目総数が番号以上であること`);
    assert.equal(total, declaredTotals.get(stage), `工程${stage}の中項目総数が構造宣言と一致すること`);
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push({ index, total });
  }

  for (const [stage, total] of declaredTotals) {
    const items = byStage.get(stage) || [];
    assert.equal(items.length, total, `工程${stage}の中項目総数が宣言件数と一致すること`);
    const totals = new Set(items.map(item => item.total));
    assert.equal(totals.size, total === 0 ? 0 : 1, `工程${stage}の総数表記が統一されていること`);
    assert.deepEqual(
      items.map(item => item.index),
      Array.from({ length: total }, (_, index) => index + 1),
      `工程${stage}の中項目が文書順の連番であること`,
    );
  }
});

test('工程2の既存判断照合がADRと保留Issueに限定され、広域検索を要求しない', () => {
  const stage = readStage(readDevelopmentCycle(), 2);

  assert.match(stage, /docs\/adr\//, '工程2がADRの確認先を含むこと');
  assert.match(stage, /gh-maestro-pending/, '工程2が保留Issueの確認先を含むこと');
  assert.doesNotMatch(stage, /explorer\s*(?:を|の)?\s*(?:起動|依頼|使用)(?:する|して|せよ|してください)/,
    '工程2がexplorerの起動・依頼を要求しないこと');
  assert.doesNotMatch(stage, /Issue(?:・|\/)PR.*(?:全文|全体).*検索(?:する|して|せよ|してください)/,
    '工程2がIssue・PRの広域検索を要求しないこと');
});

test('開発サイクルに工程番号のない裸の手順番号が残っていない', () => {
  const cycle = readDevelopmentCycle();
  const bareSteps = cycle.split(/\r?\n/).filter(line => /^\s*\d+\.\s/.test(line));

  assert.deepEqual(bareSteps, [], '開発サイクル内に工程番号のない裸の手順番号がないこと');
});
