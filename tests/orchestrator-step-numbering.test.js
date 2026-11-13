'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseFrontmatter } = require('../scripts/sync-rules');
const { renderNotificationGuidance } = require('../scripts/shared/orchestrator-guidance');

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

function extractEventNames(eventTable) {
  const names = new Set();
  for (const line of eventTable.split(/\r?\n/)) {
    const firstCell = /^\|\s*([^|]+)\|/.exec(line)?.[1];
    if (!firstCell) continue;
    const eventLabel = firstCell.replace(/<[^>]*>/g, ' ');
    for (const match of eventLabel.matchAll(/(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![A-Za-z0-9_])/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function requireDeclaredNotification(signal, eventNames, file) {
  const match = /^notify:([A-Z][A-Z0-9_]*)$/.exec(signal);
  assert.ok(match, `${file}の通知合図形式が有効であること: ${signal}`);
  assert.ok(eventNames.has(match[1]), `${file}の通知合図 ${match[1]} がイベント表の通知名と完全一致すること`);
  return match[1];
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

test('工程2の既存判断照合がADRと保留Issueを確認先として含む', () => {
  const stage = fs.readFileSync(path.join(SKILL_DIR, 'stage-2-research.md'), 'utf8');

  assert.match(stage, /docs\/adr\//, '工程2がADRの確認先を含むこと');
  assert.match(stage, /gh-maestro-pending/, '工程2が保留Issueの確認先を含むこと');
});

test('反省会は素案提示前に提案全体を専用explorerで調査し、影響範囲と弊害を記載する', () => {
  const retrospective = fs.readFileSync(path.join(SKILL_DIR, 'retrospective.md'), 'utf8');
  const stage9 = fs.readFileSync(path.join(SKILL_DIR, 'stage-9-retrospective.md'), 'utf8');
  const investigation = retrospective.indexOf('## 3. 影響範囲と弊害の事前調査');
  const consultation = retrospective.indexOf('## 4. コーダーへの意見聴取');
  const presentation = retrospective.indexOf('## 5. 素案をIssueに提示する');

  assert.ok(investigation >= 0, '影響範囲と弊害の事前調査の節があること');
  assert.ok(investigation < consultation && consultation < presentation, '事前調査が意見聴取と素案提示より前であること');
  assert.match(retrospective, /提案が0件ならexplorerを起動せず/);
  assert.match(retrospective, /反省会専用のexplorerを新規に1つだけ起動し、すべての提案をまとめて依頼する/);
  assert.match(retrospective, /同じIssueで工程2などに起動済みのexplorerを再開せず、提案ごとに起動もしない/);
  assert.match(retrospective, /各提案が触るファイル、呼び出し元、提案の`paths:`に当てはまるファイル、既存コードのうち違反になる件数、既存の規範との重複・食い違い/);
  assert.match(retrospective, /explorerには確認できた事実だけを報告させ、弊害の判断、提案の優先順位、修正方針は求めない/);
  assert.match(stage9, /素案を提示する前に、同スキル断片の影響範囲と弊害の事前調査を完了する/);

  for (const heading of [
    '## 型・制御フローで防止',
    '## Lintで検出',
    '## テストで検出',
    '## .claude/rules/化',
    '## coder SKILL.md への追加',
  ]) {
    const start = retrospective.indexOf(heading);
    const end = retrospective.indexOf('\n## ', start + heading.length);
    const section = retrospective.slice(start, end === -1 ? retrospective.length : end);
    assert.match(section, /影響範囲:/, `${heading}に影響範囲欄があること`);
    assert.match(section, /弊害:/, `${heading}に弊害欄があること`);
  }

  assert.doesNotMatch(retrospective, /既存コードへの影響: 承認後に調査/);
  assert.doesNotMatch(retrospective, /diagnosticianに既存違反の件数と改修範囲を調査させてからIssueを起票/);
});

test('通常のexplorer再利用規則と工程9専用の新規調査が矛盾しない', () => {
  const stage2 = fs.readFileSync(path.join(SKILL_DIR, 'stage-2-research.md'), 'utf8');
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.match(stage2, /工程2など通常の追加調査では、explorerは1つのIssueにつき1つ。クローズまで再利用/);
  assert.match(stage2, /ただし工程9の反省会では、既存explorerを再開せず、反省会専用のexplorerを新規に1つ起動して全提案をまとめて調査する/);
  assert.match(skill, /通常の調査では同一Issueに同じ役割のワーカーを複数起動しない/);
  assert.match(skill, /ただし工程9の反省会では、既存explorerを再開せず、反省会専用のexplorerを新規に1つ起動して全提案をまとめて調査する/);
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

test('工程5の中項目数がIssue #766の受け入れ条件どおり3つである', () => {
  const cycle = readDevelopmentCycle();
  const stage5 = readStage(cycle, 5);

  assert.equal(readDeclaredMiddleItemTotal(stage5, 5), 3, '工程5の中項目数が3つであること');
});

test('15スキル断片の合図宣言が存在し、通知・script合図が実際の配信経路に結び付いている', () => {
  const expectedFiles = [
    'stage-1-requirements.md', 'stage-2-research.md', 'stage-3-architect.md',
    'stage-4-coder.md', 'stage-5-plan-review.md', 'stage-6-implementation-start.md',
    'stage-7-review-merge.md', 'stage-8-deployment-check.md', 'stage-9-retrospective.md',
    'triage.md', 'retrospective.md', 'lightweight-pr.md',
    'premise-check.md', 'premise-check-stage-5.md', 'premise-check-stage-7.md',
  ];
  const actualFiles = fs.readdirSync(SKILL_DIR)
    .filter(file => file.endsWith('.md'))
    .filter((file) => {
      const content = fs.readFileSync(path.join(SKILL_DIR, file), 'utf8');
      const { signals } = parseFrontmatter(content);
      return Array.isArray(signals) && signals.length > 0;
    });
  const expectedFileSet = new Set(expectedFiles);
  const actualFileSet = new Set(actualFiles);
  assert.deepEqual(
    [...actualFileSet].filter(file => !expectedFileSet.has(file)).sort(),
    [],
    'expectedFilesに無い配信合図付きスキル断片が追加されていないこと',
  );
  assert.deepEqual(
    [...expectedFileSet].filter(file => !actualFileSet.has(file)).sort(),
    [],
    'expectedFilesにある配信合図付きスキル断片がすべて存在すること',
  );
  const stage1Premise = fs.readFileSync(path.join(SKILL_DIR, 'premise-check-stage-1.md'), 'utf8');
  assert.equal(
    parseFrontmatter(stage1Premise).signals,
    null,
    'premise-check-stage-1.mdは合図を持たないこと',
  );
  const eventTableStart = fs.readFileSync(SKILL_PATH, 'utf8').indexOf('## イベントの受け口');
  const eventTableEnd = fs.readFileSync(SKILL_PATH, 'utf8').indexOf('## 横断的な手続き', eventTableStart);
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const eventTable = skill.slice(eventTableStart, eventTableEnd);
  const eventNames = extractEventNames(eventTable);
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
        const name = requireDeclaredNotification(signal, eventNames, file);
        const prompt = `<task-notification><event>${name}:42</event></task-notification>`;
        const output = renderNotificationGuidance({ workspace: path.dirname(SKILL_DIR), skillDirectory: SKILL_DIR, prompt });
        assert.match(output, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}で${file}が配信されること`);
        if (name === 'PLAN_REPORTED') {
          assert.match(output, /以下は stage-5-plan-review\.md の現在の内容です。事実として参照してください。/, 'PLAN_REPORTEDで工程5のスキル断片本文が届くこと');
          assert.match(output, /以下は premise-check\.md の現在の内容です。事実として参照してください。/, 'PLAN_REPORTEDで前提確認の共通定義スキル断片本文も届くこと');
          assert.match(output, /以下は premise-check-stage-5\.md の現在の内容です。事実として参照してください。/, 'PLAN_REPORTEDで前提確認の工程5スキル断片本文も届くこと');
          assert.doesNotMatch(output, /以下は premise-check-stage-1\.md の現在の内容です。/, 'PLAN_REPORTEDで工程1スキル断片は届かないこと');
          assert.doesNotMatch(output, /以下は premise-check-stage-7\.md の現在の内容です。/, 'PLAN_REPORTEDで工程7スキル断片は届かないこと');
        }
        if (name === 'PR_REVIEW' || name === 'REVIEW_COMMENT') {
          assert.match(output, /以下は triage\.md の現在の内容です。事実として参照してください。/, `${name}でトリアージのスキル断片本文が届くこと`);
          assert.match(output, /以下は premise-check\.md の現在の内容です。事実として参照してください。/, `${name}で前提確認の共通定義スキル断片本文も届くこと`);
          assert.match(output, /以下は premise-check-stage-7\.md の現在の内容です。事実として参照してください。/, `${name}で前提確認の工程7スキル断片本文も届くこと`);
          assert.doesNotMatch(output, /以下は premise-check-stage-1\.md の現在の内容です。/, `${name}で工程1スキル断片は届かないこと`);
          assert.doesNotMatch(output, /以下は premise-check-stage-5\.md の現在の内容です。/, `${name}で工程5スキル断片は届かないこと`);
        }
        assert.ok(output.length <= 9000, `${name}で届くスキル断片が9000文字以下であること`);
      } else if (signal.startsWith('script:')) {
        const [, scriptName] = /^script:([^:]+):(.+)$/.exec(signal) || [];
        assert.ok(scriptName, `${file}のscript合図形式が有効であること`);
        const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);
        assert.ok(fs.existsSync(scriptPath), `${scriptName}がscripts/に存在すること`);
        const scriptSource = fs.readFileSync(scriptPath, 'utf8');
        assert.match(scriptSource, /prepareScriptGuidance/, `${scriptName}が共有合図関数を呼ぶこと`);
        assert.match(scriptSource, /--guidance-signal/, `${scriptName}が実CLI引数として合図を受け取ること`);
      } else {
        assert.equal(file, 'stage-1-requirements.md', `${file}の未知の合図形式`);
      }
    }
  }

  assert.deepEqual([...signalsByFile.keys()].sort(), [...expectedFiles].sort());
  assert.deepEqual(
    [...signalsByFile.get('premise-check.md')].sort(),
    ['notify:PLAN_REPORTED', 'notify:PR_REVIEW', 'notify:REVIEW_COMMENT'],
    'premise-check.mdがPLAN_REPORTED・PR_REVIEW・REVIEW_COMMENTを宣言すること',
  );
  assert.deepEqual(
    [...signalsByFile.get('premise-check-stage-5.md')].sort(),
    ['notify:PLAN_REPORTED'],
    'premise-check-stage-5.mdがPLAN_REPORTEDだけを宣言すること',
  );
  assert.deepEqual(
    [...signalsByFile.get('premise-check-stage-7.md')].sort(),
    ['notify:PR_REVIEW', 'notify:REVIEW_COMMENT'],
    'premise-check-stage-7.mdがPR_REVIEW・REVIEW_COMMENTだけを宣言すること',
  );
  const merged = renderNotificationGuidance({
    workspace: path.dirname(SKILL_DIR), skillDirectory: SKILL_DIR,
    prompt: '<task-notification><event>PR_MERGED:42</event></task-notification>',
  });
  assert.ok(merged.length <= 9000, `PR_MERGEDで届くスキル断片の合計が9000文字以下であること（${merged.length}）`);
});

test('notify合図はイベント名と完全一致し、部分一致だけする誤記を拒否する', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const eventTableStart = skill.indexOf('## イベントの受け口');
  const eventTableEnd = skill.indexOf('## 横断的な手続き', eventTableStart);
  const eventNames = extractEventNames(skill.slice(eventTableStart, eventTableEnd));

  assert.ok(eventNames.has('PR_PUSH'), 'イベント表からPR_PUSHを通知名として抽出する');
  assert.equal(eventNames.has('PR'), false, 'PR_PUSHの部分文字列や引数プレースホルダーを別通知名にしない');
  assert.equal(requireDeclaredNotification('notify:PR_PUSH', eventNames, 'fixture.md'), 'PR_PUSH');
  assert.throws(
    () => requireDeclaredNotification('notify:PR', eventNames, 'fixture.md'),
    /通知合図 PR がイベント表の通知名と完全一致すること/,
  );
});

test('工程7に修正push後のexplorer事実確認が番号付き中項目としてある', () => {
  const cycle = readDevelopmentCycle();
  const stage7 = readStage(cycle, 7);
  assert.equal(readDeclaredMiddleItemTotal(stage7, 7), 6);
  assert.match(stage7, /7-\[4\/6\].*修正push後の事実確認/);
  const handbook = fs.readFileSync(path.join(SKILL_DIR, 'stage-7-review-merge.md'), 'utf8');
  assert.match(handbook, /PR_PUSH/);
});
