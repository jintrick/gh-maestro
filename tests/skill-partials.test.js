'use strict';
// skill-partials.test.js
//
// 共通部分テンプレート（skills/_partials/*.md）の設計を保護する。
// ワーカースキルの通信ルールが各SKILL.mdへ重複コピペされていた drift 問題（diagnostician
// だけ環境変数の例示が古いスキル名のまま残っていた）を単一ソース化で解消した経緯の回帰防止。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const PARTIALS_DIR = path.join(SKILLS_DIR, '_partials');

// {{COMMUNICATION_RULES}} を差し込む前提のワーカースキル。
const WORKER_SKILLS = [
  'gh-maestro-coder',
  'gh-maestro-senior-coder',
  'gh-maestro-explorer',
  'gh-maestro-diagnostician',
  'gh-maestro-base',
];

test('部分テンプレート本文は skills/_partials/*.md に単一ソースとして存在する', () => {
  for (const name of ['communication-rules.md', 'rules-check-step.md']) {
    const p = path.join(PARTIALS_DIR, name);
    assert.ok(fs.existsSync(p), `${name} が存在しない`);
    assert.ok(fs.readFileSync(p, 'utf8').trim().length > 0, `${name} が空`);
  }
});

test('通信ルールの実行例はシェル非依存のファイル入力を第一に案内する', () => {
  const content = fs.readFileSync(path.join(PARTIALS_DIR, 'communication-rules.md'), 'utf8');
  const firstExample = content.match(/```sh\r?\n([\s\S]*?)\r?\n```/);

  assert.ok(firstExample, '通信ルールの第一実行例が見つからない');
  assert.match(firstExample[1], /--body-file <本文ファイルのパス>/);
  assert.doesNotMatch(firstExample[1], /<<['"]?EOF/);

  const powerShellExample = content.match(/```powershell\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(powerShellExample, 'PowerShellの実行例が見つからない');
  assert.match(powerShellExample[1], /@'\r?\n[\s\S]*\r?\n'@ \| node .*--stdin/);
  assert.match(powerShellExample[1], /<内容>/);
});

test('explorer/diagnosticianの報告コマンドは共通通信ルールだけを参照する', () => {
  const fallbackHeadings = {
    'gh-maestro-explorer': '## 調査しても情報が見つからない場合',
    'gh-maestro-diagnostician': '## 調査しても特定できない場合',
  };

  for (const [skill, heading] of Object.entries(fallbackHeadings)) {
    const content = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
    const sectionStart = content.indexOf(heading);
    const nextSection = content.indexOf('\n## ', sectionStart + heading.length);
    const fallbackSection = content.slice(sectionStart, nextSection === -1 ? content.length : nextSection);
    assert.notEqual(sectionStart, -1, `${skill}の調査失敗時節が見つからない`);
    assert.match(content, /報告は通信ルールのコマンドで送る/);
    assert.match(fallbackSection, /通信ルールに従って/);
    assert.doesNotMatch(content, /node .*msg-send\.js/);
  }
});

test('ワーカースキルの通信ルールは重複コピペではなく {{COMMUNICATION_RULES}} を参照する', () => {
  for (const skill of WORKER_SKILLS) {
    const content = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
    assert.match(content, /\{\{COMMUNICATION_RULES\}\}/, `${skill}/SKILL.md が {{COMMUNICATION_RULES}} を参照していない`);
    // 通信ルール本文の直書きが復活していないこと（部分テンプレート側にしか無いはずの文言）
    assert.doesNotMatch(content, /最終応答として書かず/, `${skill}/SKILL.md に通信ルール本文が直書きされている（コピペ回帰）`);
  }
});

test('_partials は skills の走査で `_` 始まりとしてスキル扱いされない前提を守る', () => {
  // install.js は `_` 始まりディレクトリを skillDirs から除外する。この命名前提が崩れると
  // 部分テンプレートがスキルとして誤インストールされる。
  assert.ok(path.basename(PARTIALS_DIR).startsWith('_'), '部分テンプレート置き場は `_` 始まりである必要がある');
});

test('coder-workflow.md が coder 共通の npm install 制約を保持する', () => {
  const shared = fs.readFileSync(path.join(PARTIALS_DIR, 'coder-workflow.md'), 'utf8');
  assert.match(shared, /-\s+`\$WORKTREE`\s+ルートで\s+`npm install`\s+\/\s+`npm ci`\s+は実行しない。ルートで\s+npm install\s+を実行するとワークスペース共有の\s+`node_modules`\s+を破壊する/);
  for (const skill of ['gh-maestro-coder', 'gh-maestro-senior-coder']) {
    const content = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
    assert.match(content, /\{\{CODER_WORKFLOW\}\}/);
    assert.doesNotMatch(content, /自動リンク済み|ルートで `npm install`/);
  }
});

test('質問投稿後のターン終了規約は役割に応じた共通ファイルに集約する', () => {
  const turnEndRule = '質問の投稿が成功したら、そのターンで追加の調査・実装・計画・完了報告を続けず、ワーカー自身の手順を終了する。回答は次の resume で受け取る。';
  const sharedWorkflow = fs.readFileSync(path.join(PARTIALS_DIR, 'coder-workflow.md'), 'utf8');
  assert.match(sharedWorkflow, /msg-send\.js"? --body-file <質問本文ファイルのパス>/);
  assert.ok(sharedWorkflow.includes(turnEndRule));
  for (const skill of ['gh-maestro-coder', 'gh-maestro-senior-coder']) {
    const content = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
    assert.match(content, /\{\{CODER_WORKFLOW\}\}/);
    assert.doesNotMatch(content, /質問投稿後のターン終了規約/);
  }
  const base = fs.readFileSync(path.join(SKILLS_DIR, 'gh-maestro-base', 'SKILL.md'), 'utf8');
  assert.match(base, /msg-send\.js"? --body-file <質問本文ファイルのパス>/);
  assert.ok(base.includes(turnEndRule));
});

