'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  validateAgentEntry,
  validateAgentDefaults,
  REQUIRED_FIELDS,
} = require('../scripts/shared/validate-agent-defaults');

const DEFAULTS_PATH = path.join(__dirname, '..', 'scripts', 'agent-defaults.json');
const realDefaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 最小限の有効なエージェント定義を返す。
 * テストごとにオーバーライドして使う。
 */
function makeValidAgent(overrides = {}) {
  return {
    id: 'test-agent',
    label: 'Test Agent',
    command: 'test-cli',
    runtime: 'test',
    extraArgs: [],
    promptDelivery: 'positional',
    enterSequence: '\r\n',
    rulesSupported: false,
    asynchronousNotification: false,
    sessionResume: true,
    resumeCommand: '--continue',
    ...overrides,
  };
}

// ── validateAgentDefaults: 実データ ──────────────────────────────────────────

test('validateAgentDefaults: 実データが検証を通過する', () => {
  const issues = validateAgentDefaults(realDefaults);
  // 現在の実データは有効であるはず
  const errors = issues.filter(i => i.startsWith('[ERROR]'));
  assert.deepEqual(errors, [], `実データにエラーがあります:\n${errors.join('\n')}`);
});

test('validateAgentDefaults: 全エージェントが rulesSupported を持っている', () => {
  for (const agent of realDefaults.agents) {
    assert.ok('rulesSupported' in agent, `"${agent.id}" に rulesSupported フィールドがありません`);
    assert.equal(typeof agent.rulesSupported, 'boolean', `"${agent.id}" の rulesSupported は boolean である必要があります`);
  }
});

test('validateAgentDefaults: rulesSupported の値が期待通り', () => {
  const map = new Map(realDefaults.agents.map(a => [a.id, a.rulesSupported]));
  assert.equal(map.get('claude'), true);
  assert.equal(map.get('claude-ds'), true);
  assert.equal(map.get('claude-ds-pro'), true);
  assert.equal(map.get('reasonix'), false);
  assert.equal(map.get('agy'), false);
  assert.equal(map.get('codex'), false);
});

// ── Issue #132: 能力宣言フィールド ────────────────────────────────────────────

test('validateAgentDefaults: 全エージェントが asynchronousNotification を持っている', () => {
  for (const agent of realDefaults.agents) {
    assert.ok('asynchronousNotification' in agent, `"${agent.id}" に asynchronousNotification フィールドがありません`);
    assert.equal(typeof agent.asynchronousNotification, 'boolean', `"${agent.id}" の asynchronousNotification は boolean である必要があります`);
  }
});

test('validateAgentDefaults: 全エージェントが sessionResume を持っている', () => {
  for (const agent of realDefaults.agents) {
    assert.ok('sessionResume' in agent, `"${agent.id}" に sessionResume フィールドがありません`);
    assert.equal(typeof agent.sessionResume, 'boolean', `"${agent.id}" の sessionResume は boolean である必要があります`);
  }
});

test('validateAgentDefaults: 全エージェントが resumeCommand を持っている', () => {
  for (const agent of realDefaults.agents) {
    assert.ok('resumeCommand' in agent, `"${agent.id}" に resumeCommand フィールドがありません`);
    assert.equal(typeof agent.resumeCommand, 'string', `"${agent.id}" の resumeCommand は string である必要があります`);
  }
});

test('validateAgentDefaults: asynchronousNotification の値が期待通り', () => {
  const map = new Map(realDefaults.agents.map(a => [a.id, a.asynchronousNotification]));
  assert.equal(map.get('claude'), true);
  assert.equal(map.get('claude-ds'), true);
  assert.equal(map.get('claude-ds-pro'), true);
  assert.equal(map.get('reasonix'), false);
  assert.equal(map.get('agy'), false);
  assert.equal(map.get('codex'), false);
});

test('validateAgentDefaults: sessionResume の値が期待通り', () => {
  const map = new Map(realDefaults.agents.map(a => [a.id, a.sessionResume]));
  assert.equal(map.get('claude'), true);
  assert.equal(map.get('claude-ds'), true);
  assert.equal(map.get('claude-ds-pro'), true);
  assert.equal(map.get('reasonix'), true);
  assert.equal(map.get('agy'), true);
  assert.equal(map.get('codex'), true);
});

test('validateAgentDefaults: resumeCommand の値が期待通り', () => {
  const map = new Map(realDefaults.agents.map(a => [a.id, a.resumeCommand]));
  assert.equal(map.get('claude'), '--continue');
  assert.equal(map.get('claude-ds'), '--continue');
  assert.equal(map.get('claude-ds-pro'), '--continue');
  assert.equal(map.get('reasonix'), '--continue');
  assert.equal(map.get('agy'), '--continue');
  assert.equal(map.get('codex'), 'exec resume --last');
});

// ── validateAgentEntry: 必須フィールド ────────────────────────────────────────

test('validateAgentEntry: 正常なエントリは空配列を返す', () => {
  const agent = makeValidAgent();
  const issues = validateAgentEntry(agent, 0);
  assert.deepEqual(issues, []);
});

test('validateAgentEntry: id 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.id;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"id"')), `id欠落検出: ${issues.join('\n')}`);
});

test('validateAgentEntry: label 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.label;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"label"') && i.includes('ありません')));
});

test('validateAgentEntry: command 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.command;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"command"')));
});

test('validateAgentEntry: runtime 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.runtime;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"runtime"')));
});

test('validateAgentEntry: extraArgs 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.extraArgs;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"extraArgs"')));
});

test('validateAgentEntry: promptDelivery 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.promptDelivery;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"promptDelivery"')));
});

test('validateAgentEntry: enterSequence 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.enterSequence;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"enterSequence"')));
});

test('validateAgentEntry: rulesSupported 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.rulesSupported;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"rulesSupported"') && i.includes('ありません')),
    `rulesSupported欠落: ${issues.join('\n')}`);
});

test('validateAgentEntry: asynchronousNotification 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.asynchronousNotification;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"asynchronousNotification"') && i.includes('ありません')),
    `asynchronousNotification欠落: ${issues.join('\n')}`);
});

test('validateAgentEntry: sessionResume 欠落を検出する', () => {
  const agent = makeValidAgent();
  delete agent.sessionResume;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('"sessionResume"') && i.includes('ありません')),
    `sessionResume欠落: ${issues.join('\n')}`);
});

test('validateAgentEntry: sessionResume=true で resumeCommand がなければエラー', () => {
  const agent = makeValidAgent({ sessionResume: true });
  delete agent.resumeCommand;
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('resumeCommand') && i.includes('必須')),
    `resumeCommand欠落（条件付き）: ${issues.join('\n')}`);
});

test('validateAgentEntry: sessionResume=false で resumeCommand がなくてもエラーにならない', () => {
  const agent = makeValidAgent({ sessionResume: false });
  delete agent.resumeCommand;
  const issues = validateAgentEntry(agent, 0);
  const errors = issues.filter(i => i.startsWith('[ERROR]'));
  assert.deepEqual(errors, [], `sessionResume=falseなのにresumeCommand欠落エラー: ${errors.join('\n')}`);
});

test('validateAgentEntry: resumeCommand が string でないとエラー', () => {
  const agent = makeValidAgent({ resumeCommand: 123 });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('resumeCommand') && i.includes('string')),
    `resumeCommand型不正: ${issues.join('\n')}`);
});

// ── validateAgentEntry: 型チェック ───────────────────────────────────────────

test('validateAgentEntry: extraArgs が配列でないとエラー', () => {
  const agent = makeValidAgent({ extraArgs: 'not-an-array' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('extraArgs') && i.includes('array')));
});

test('validateAgentEntry: extraArgs の要素が文字列でないとエラー', () => {
  const agent = makeValidAgent({ extraArgs: ['valid', 123] });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('extraArgs[1]') && i.includes('文字列')));
});

test('validateAgentEntry: rulesSupported が boolean でないとエラー', () => {
  const agent = makeValidAgent({ rulesSupported: 'yes' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('rulesSupported') && i.includes('boolean')),
    `型不一致: ${issues.join('\n')}`);
});

test('validateAgentEntry: asynchronousNotification が boolean でないとエラー', () => {
  const agent = makeValidAgent({ asynchronousNotification: 'yes' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('asynchronousNotification') && i.includes('boolean')),
    `asynchronousNotification型不正: ${issues.join('\n')}`);
});

test('validateAgentEntry: sessionResume が boolean でないとエラー', () => {
  const agent = makeValidAgent({ sessionResume: 'yes' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('sessionResume') && i.includes('boolean')),
    `sessionResume型不正: ${issues.join('\n')}`);
});

// ── validateAgentEntry: 条件付き必須 ──────────────────────────────────────────

test('validateAgentEntry: promptDelivery=flag で promptFlag がないとエラー', () => {
  const agent = makeValidAgent({ promptDelivery: 'flag' });
  // promptFlag は makeValidAgent に含まれないので欠落エラーになるはず
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('promptFlag')), `条件付き: ${issues.join('\n')}`);
});

test('validateAgentEntry: promptDelivery=flag で promptFlag が文字列ならOK', () => {
  const agent = makeValidAgent({ promptDelivery: 'flag', promptFlag: '-p' });
  const issues = validateAgentEntry(agent, 0);
  const errors = issues.filter(i => i.startsWith('[ERROR]'));
  assert.deepEqual(errors, [], `errors: ${errors.join('\n')}`);
});

test('validateAgentEntry: promptDelivery=positional で promptFlag がなくてもOK', () => {
  const agent = makeValidAgent({ promptDelivery: 'positional' });
  const issues = validateAgentEntry(agent, 0);
  const errors = issues.filter(i => i.startsWith('[ERROR]'));
  assert.deepEqual(errors, []);
});

// ── validateAgentEntry: 未知フィールド警告 ────────────────────────────────────

test('validateAgentEntry: 未知のフィールドは警告する', () => {
  const agent = makeValidAgent({ unknownField: 'surprise' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[WARN]') && i.includes('unknownField')));
});

test('validateAgentEntry: 未知のフィールドは警告のみでエラーではない', () => {
  const agent = makeValidAgent({ unknownField: 'surprise' });
  const issues = validateAgentEntry(agent, 0);
  const errors = issues.filter(i => i.startsWith('[ERROR]'));
  assert.deepEqual(errors, []);
});

// ── validateAgentEntry: 既知のオプショナルフィールドの型チェック ──────────────

test('validateAgentEntry: dynamicCommand が boolean でないとエラー', () => {
  const agent = makeValidAgent({ dynamicCommand: 'yes' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('dynamicCommand') && i.includes('boolean')));
});

test('validateAgentEntry: execArgs が配列でないとエラー', () => {
  const agent = makeValidAgent({ execArgs: 'not-an-array' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('execArgs') && i.includes('array')));
});

test('validateAgentEntry: 未知の promptDelivery は警告する', () => {
  const agent = makeValidAgent({ promptDelivery: 'unknown-mode' });
  const issues = validateAgentEntry(agent, 0);
  assert.ok(issues.some(i => i.includes('[WARN]') && i.includes('unknown-mode')));
});

// ── validateAgentDefaults: 構造エラー ────────────────────────────────────────

test('validateAgentDefaults: 非オブジェクトはエラー', () => {
  const issues = validateAgentDefaults(null);
  assert.ok(issues.some(i => i.includes('[ERROR]')));
});

test('validateAgentDefaults: agents が配列でないとエラー', () => {
  const issues = validateAgentDefaults({ agents: 'not-array' });
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('配列')));
});

test('validateAgentDefaults: 重複 id を検出する', () => {
  const data = {
    agents: [
      makeValidAgent({ id: 'dup' }),
      makeValidAgent({ id: 'unique' }),
      makeValidAgent({ id: 'dup' }),
    ],
  };
  const issues = validateAgentDefaults(data);
  assert.ok(issues.some(i => i.includes('[ERROR]') && i.includes('重複') && i.includes('dup')));
});

// ── validation SSOT: フィールド一覧はテスト側で重複定義しない ──────────────────

test('REQUIRED_FIELDS: rulesSupported が必須フィールドに含まれている', () => {
  const fieldNames = REQUIRED_FIELDS.map(([f]) => f);
  assert.ok(fieldNames.includes('rulesSupported'), 'rulesSupported must be in REQUIRED_FIELDS');
});

test('REQUIRED_FIELDS: asynchronousNotification が必須フィールドに含まれている', () => {
  const fieldNames = REQUIRED_FIELDS.map(([f]) => f);
  assert.ok(fieldNames.includes('asynchronousNotification'), 'asynchronousNotification must be in REQUIRED_FIELDS');
});

test('REQUIRED_FIELDS: sessionResume が必須フィールドに含まれている', () => {
  const fieldNames = REQUIRED_FIELDS.map(([f]) => f);
  assert.ok(fieldNames.includes('sessionResume'), 'sessionResume must be in REQUIRED_FIELDS');
});
