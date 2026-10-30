'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseFrontmatter } = require('../scripts/sync-rules');
const { prepareScriptGuidance, renderNotificationGuidance } = require('../scripts/shared/orchestrator-guidance');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'SKILL.md');
const SKILL_DIR = path.dirname(SKILL_PATH);
const STAGE_HEADING_RE = /^### (\d+)\. ([^\r\n]+)$/gm;
const STAGE_COUNT_RE = /<!--\s*gh-maestro-structure:\s*stages=(\d+)\s*-->/g;
const STAGE_STRUCTURE_RE = /<!--\s*gh-maestro-structure:\s*middle-items=(\d+)\s*-->/g;

function readDevelopmentCycle() {
  const lines = fs.readFileSync(SKILL_PATH, 'utf8').split(/\r?\n/);
  const start = lines.findIndex(line => line === '## 開発サイクル');
  assert.notEqual(start, -1, '開発サイクルの見出しが行全体で存在すること');
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
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
  const stage = fs.readFileSync(path.join(SKILL_DIR, 'stage-2-research.md'), 'utf8');

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

test('開発サイクルが工程1〜9で構成され、工程3に「抽象設計の検討」が中項目として含まれる', () => {
  const cycle = readDevelopmentCycle();
  const declaredTotal = readDeclaredStageTotal(cycle);
  assert.equal(declaredTotal, 9, '大項目数の構造宣言が9であること');

  const stage3 = readStage(cycle, 3);
  assert.equal(readDeclaredMiddleItemTotal(stage3, 3), 1, '工程3の中項目構造宣言が1件であること');
  assert.match(
    stage3,
    /3-\[1\/1\]\s*抽象設計の検討【任意】/,
    '工程3の中項目に「3-[1/1] 抽象設計の検討【任意】」が存在すること',
  );
});

test('12手順書の合図宣言が存在し、通知・script合図が実際の配信経路に結び付いている', () => {
  const expectedFiles = [
    'stage-1-requirements.md', 'stage-2-research.md', 'stage-3-architect.md',
    'stage-4-coder.md', 'stage-5-plan-review.md', 'stage-6-implementation-start.md',
    'stage-7-review-merge.md', 'stage-8-deployment-check.md', 'stage-9-retrospective.md',
    'triage.md', 'retrospective.md', 'lightweight-pr.md',
  ];
  const eventTableStart = fs.readFileSync(SKILL_PATH, 'utf8').indexOf('## イベントの受け口');
  const eventTableEnd = fs.readFileSync(SKILL_PATH, 'utf8').indexOf('## 横断的な手続き', eventTableStart);
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const eventTable = skill.slice(eventTableStart, eventTableEnd);
  const signalsByFile = new Map();

  for (const file of expectedFiles) {
    const content = fs.readFileSync(path.join(SKILL_DIR, file), 'utf8');
    const { signals } = parseFrontmatter(content);
    assert.ok(Array.isArray(signals), `${file}にsignals宣言があること`);
    assert.ok(signals.length > 0, `${file}に少なくとも1つ合図があること`);
    signalsByFile.set(file, signals);
    if (file === 'stage-1-requirements.md') {
      assert.deepEqual(signals, ['none'], 'stage-1は合図なしを宣言すること');
    } else {
      assert.ok(!signals.includes('none'), `${file}が他の合図とnoneを併記しないこと`);
    }

    for (const signal of signals) {
      if (signal.startsWith('notify:')) {
        const name = signal.slice('notify:'.length);
        assert.match(eventTable, new RegExp(`\\|[^\\n]*${name}[^\\n]*\\|`), `${file}の通知合図 ${name} がイベント表にあること`);
        const prompt = `<task-notification><event>${name}:42</event></task-notification>`;
        const output = renderNotificationGuidance({ workspace: path.dirname(SKILL_DIR), skillDirectory: SKILL_DIR, prompt });
        assert.match(output, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}で${file}が配信されること`);
        assert.ok(output.length <= 9000, `${name}の追加文脈が9000文字以下であること`);
      } else if (signal.startsWith('script:')) {
        const [, scriptName, value] = /^script:([^:]+):(.+)$/.exec(signal) || [];
        assert.ok(scriptName && value, `${file}のscript合図形式が有効であること`);
        const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);
        assert.ok(fs.existsSync(scriptPath), `${scriptName}がscripts/に存在すること`);
        assert.match(fs.readFileSync(scriptPath, 'utf8'), /prepareScriptGuidance/, `${scriptName}が共有合図関数を呼ぶこと`);
        const output = prepareScriptGuidance({
          workspace: path.dirname(SKILL_DIR), skillDirectory: SKILL_DIR, scriptName, signal: value,
          env: { GH_MAESTRO_WORKER: 'orchestrator' },
        });
        assert.match(output, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${signal}で${file}が配信されること`);
        assert.ok(output.length <= 9000, `${signal}の追加文脈が9000文字以下であること`);
      } else {
        assert.equal(file, 'stage-1-requirements.md', `${file}の未知の合図形式`);
      }
    }
  }

  assert.deepEqual([...signalsByFile.keys()].sort(), [...expectedFiles].sort());
  const merged = renderNotificationGuidance({
    workspace: path.dirname(SKILL_DIR), skillDirectory: SKILL_DIR,
    prompt: '<task-notification><event>PR_MERGED:42</event></task-notification>',
  });
  assert.ok(merged.length <= 9000, `PR_MERGEDの合計追加文脈が9000文字以下であること（${merged.length}）`);
});

test('工程7に修正push後のexplorer事実確認が番号付き中項目としてある', () => {
  const cycle = readDevelopmentCycle();
  const stage7 = readStage(cycle, 7);
  assert.equal(readDeclaredMiddleItemTotal(stage7, 7), 6);
  assert.match(stage7, /7-\[4\/6\].*修正push後の事実確認/);
  const handbook = fs.readFileSync(path.join(SKILL_DIR, 'stage-7-review-merge.md'), 'utf8');
  assert.match(handbook, /PR_PUSH/);
  assert.match(handbook, /explorer/);
  assert.match(handbook, /checkout/);
});
