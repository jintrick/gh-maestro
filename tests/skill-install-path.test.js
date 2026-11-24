'use strict';
// skill-install-path.test.js
//
// agentId から SKILL.md の実インストール先絶対パスを解決する
// scripts/shared/skill-install-path.js のユニットテスト。
// fsアクセスなしの純粋関数コア（computeSkillMdPath / resolveSkillsFamilyKey）を対象とする。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  computeSkillMdPath,
  resolveSkillsFamilyKey,
} = require('../scripts/shared/skill-install-path');

const YAML_AGENTS_MAP = {
  claude: { dest: '~/.claude/skills', substitutions: {} },
  agy: { dest: '~/.gemini/antigravity-cli/skills', substitutions: {} },
  reasonix: { dest: '~/.reasonix/skills', substitutions: {} },
  codex: { dest: '~/.agents/skills', substitutions: {} },
};

test('resolveSkillsFamilyKey: agentIdがagents.yamlのキーと直接一致する場合はそれを返す', () => {
  assert.equal(resolveSkillsFamilyKey('agy', undefined, YAML_AGENTS_MAP), 'agy');
  assert.equal(resolveSkillsFamilyKey('claude', undefined, YAML_AGENTS_MAP), 'claude');
  // command が未定義（undefined）でも agentId 直接一致で解決する経路
  assert.equal(resolveSkillsFamilyKey('codex', undefined, YAML_AGENTS_MAP), 'codex');
});

test('resolveSkillsFamilyKey: agentIdが一致しなくてもcommand文字列が一致すれば解決する（agy-interactive → agy）', () => {
  assert.equal(resolveSkillsFamilyKey('agy-interactive', 'agy', YAML_AGENTS_MAP), 'agy');
});

test('resolveSkillsFamilyKey: agentIdにもcommandにも一致がなければnull（フェイルクローズ）', () => {
  assert.equal(resolveSkillsFamilyKey('unknown-agent', 'unknown-cmd', YAML_AGENTS_MAP), null);
});

test('computeSkillMdPath: 解決不能な場合はnullを返す', () => {
  assert.equal(computeSkillMdPath(YAML_AGENTS_MAP, 'claude-ds', 'claude-ds', 'gh-maestro-coder'), null);
});

test('computeSkillMdPath: destが定義されていないエントリではnullを返す', () => {
  const brokenMap = { agy: { substitutions: {} } }; // dest欠落
  assert.equal(computeSkillMdPath(brokenMap, 'agy', undefined, 'gh-maestro-explorer'), null);
});


