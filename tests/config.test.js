'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  loadJSON,
  collectValidAgentIds,
  closestKnownSkillKey,
  resolveSkillAgentMapWithSources,
  validateConfig,
  validateCouncilConfig,
  USAGE,
} = require('../scripts/config');

const { loadDefaults } = require('../scripts/shared/resolve-config');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'config.js');

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a temp directory with a .gh-maestro dir and an empty config.
 * Returns the temp home dir path. Cleaned up automatically.
 */
function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-config-test-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write config.json into a temp home directory.
 */
function writeConfig(home, data) {
  fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

/**
 * Create a temp workspace directory.
 */
function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-config-ws-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write workspace config into a temp workspace directory.
 */
function writeWorkspaceConfig(ws, data) {
  fs.writeFileSync(
    path.join(ws, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

/**
 * Run config.js as a subprocess with a custom HOME.
 */
function runConfig(args, home, cwd) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // Unset GH_MAESTRO_WORKSPACE so tests don't pick up the real workspace
  delete env.GH_MAESTRO_WORKSPACE;
  // Use os.tmpdir() as default cwd to avoid accidentally picking up
  // a .gh-maestro workspace directory from the home path
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd || os.tmpdir(),
    env,
    encoding: 'utf8',
  });
}

// ── loadJSON ───────────────────────────────────────────────────────────────────

test('loadJSON: 存在しないファイルは null を返す', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'nonexistent.json');
    const result = loadJSON(p);
    assert.equal(result, null);
  });
});

test('loadJSON: 有効な JSON をパースする', () => {
  withTempHome(home => {
    writeConfig(home, { key: 'value', nested: { a: 1 } });
    const p = path.join(home, '.gh-maestro', 'config.json');
    const result = loadJSON(p);
    assert.deepEqual(result, { key: 'value', nested: { a: 1 } });
  });
});

test('loadJSON: パース失敗で _parseError を返す', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ invalid json }}', 'utf8');
    const result = loadJSON(p);
    assert.ok(result._parseError, 'should have _parseError');
    assert.ok(typeof result._parseError === 'string');
  });
});

test('loadJSON: 配列は _parseError を返す', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '[]', 'utf8');
    const result = loadJSON(p);
    assert.ok(result._parseError, 'should have _parseError for array');
  });
});

test('loadJSON: プリミティブ値は _parseError を返す', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '"string"', 'utf8');
    const result = loadJSON(p);
    assert.ok(result._parseError, 'should have _parseError for primitive');
  });
});

// ── collectValidAgentIds ───────────────────────────────────────────────────────

test('collectValidAgentIds: デフォルトのエージェントIDと設定のagentsを収集する', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'my-custom': { command: 'x', promptDelivery: 'flag' },
    },
  };
  const ids = collectValidAgentIds(defaults, config);
  assert.ok(ids.has('claude'));
  assert.ok(ids.has('claude-ds'));
  assert.ok(ids.has('agy'));
  assert.ok(ids.has('my-custom'));
});

test('collectValidAgentIds: config が null でもデフォルトだけを返す', () => {
  const defaults = loadDefaults();
  const ids = collectValidAgentIds(defaults, null);
  assert.ok(ids.has('claude-ds'));
  assert.ok(ids.has('agy'));
});

test('collectValidAgentIds: config の agents が空でもデフォルトを返す', () => {
  const defaults = loadDefaults();
  const ids = collectValidAgentIds(defaults, {});
  assert.ok(ids.has('claude-ds'));
});


// ── closestKnownSkillKey ──────────────────────────────────────────────────────────

test('closestKnownSkillKey: exact match returns the match itself', () => {
  const keys = ['gh-maestro-coder', 'gh-maestro-reviewer', 'gh-maestro-base'];
  assert.equal(closestKnownSkillKey('gh-maestro-coder', keys), 'gh-maestro-coder');
});

test('closestKnownSkillKey: returns closest prefix match', () => {
  const keys = ['gh-maestro-coder', 'gh-maestro-reviewer', 'gh-maestro-base'];
  const result = closestKnownSkillKey('gh-maestro-review-manager', keys);
  assert.equal(result, 'gh-maestro-reviewer');
});

test('closestKnownSkillKey: empty knownKeys returns null', () => {
  assert.equal(closestKnownSkillKey('anything', []), null);
});

test('closestKnownSkillKey: null knownKeys returns null', () => {
  assert.equal(closestKnownSkillKey('anything', null), null);
});

test('closestKnownSkillKey: short mismatch returns null', () => {
  const keys = ['gh-maestro-coder', 'gh-maestro-reviewer'];
  assert.equal(closestKnownSkillKey('xyz', keys), null);
});

test('closestKnownSkillKey: totally different key returns null', () => {
  const keys = ['gh-maestro-coder', 'gh-maestro-reviewer', 'gh-maestro-base'];
  assert.equal(closestKnownSkillKey('completely-unrelated', keys), null);
});

test('closestKnownSkillKey: 共通接頭辞のみ一致し個別名が異なる場合は null を返す', () => {
  const keys = ['gh-maestro-coder', 'gh-maestro-reviewer', 'gh-maestro-base'];
  assert.equal(closestKnownSkillKey('gh-maestro-foo', keys), null);
});

// ── resolveSkillAgentMapWithSources ─────────────────────────────────────────────

test('resolveSkillAgentMapWithSources: デフォルトのみですべて default ソース', () => {
  const defaults = loadDefaults();
  const { map, sources } = resolveSkillAgentMapWithSources(defaults, null, null);
  assert.equal(map['gh-maestro-coder'], 'claude-ds');
  assert.equal(sources['gh-maestro-coder'], 'default');
  assert.equal(sources['gh-maestro-explorer'], 'default');
});

test('resolveSkillAgentMapWithSources: global config が上書きする', () => {
  const defaults = loadDefaults();
  const globalConfig = {
    skillAgentMap: { 'gh-maestro-coder': 'agy' },
  };
  const { map, sources } = resolveSkillAgentMapWithSources(defaults, globalConfig, null);
  assert.equal(map['gh-maestro-coder'], 'agy');
  assert.equal(sources['gh-maestro-coder'], 'global');
  // unrelated entry unchanged
  assert.equal(map['gh-maestro-base'], 'claude-ds');
  assert.equal(sources['gh-maestro-base'], 'default');
});

test('resolveSkillAgentMapWithSources: workspace config がさらに上書きする', () => {
  const defaults = loadDefaults();
  const globalConfig = {
    skillAgentMap: { 'gh-maestro-coder': 'agy' },
  };
  const wsConfig = {
    skillAgentMap: { 'gh-maestro-coder': 'codex' },
  };
  const { map, sources } = resolveSkillAgentMapWithSources(defaults, globalConfig, wsConfig);
  assert.equal(map['gh-maestro-coder'], 'codex');
  assert.equal(sources['gh-maestro-coder'], 'workspace');
});

test('resolveSkillAgentMapWithSources: 新しいスキルを追加できる', () => {
  const defaults = loadDefaults();
  const globalConfig = {
    skillAgentMap: { 'gh-maestro-custom-reviewer': 'claude' },
  };
  const { map, sources } = resolveSkillAgentMapWithSources(defaults, globalConfig, null);
  assert.equal(map['gh-maestro-custom-reviewer'], 'claude');
  assert.equal(sources['gh-maestro-custom-reviewer'], 'global');
  // defaults still present for existing skills
  assert.ok(map['gh-maestro-coder']);
});

// ── validateConfig ─────────────────────────────────────────────────────────────

test('validateConfig: 正常な config は問題なし', () => {
  withTempHome(home => {
    const defaults = loadDefaults();
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'claude-ds' },
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });
    const p = path.join(home, '.gh-maestro', 'config.json');
    const config = loadJSON(p);
    const issues = validateConfig('global', p, config, defaults);
    assert.deepEqual(issues, []);
  });
});

test('validateConfig: _parseError の config はエラーを報告する', () => {
  const defaults = loadDefaults();
  const config = { _parseError: 'Unexpected token' };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].includes('[ERROR]'));
  assert.ok(issues[0].includes('Unexpected token'));
});

test('validateConfig: null config は空配列を返す（ファイルなしはエラーではない）', () => {
  const defaults = loadDefaults();
  const issues = validateConfig('global', '/tmp/nonexistent.json', null, defaults);
  assert.deepEqual(issues, []);
});

test('validateConfig: skillAgentMap の未知のエージェントID は警告', () => {
  const defaults = loadDefaults();
  const config = { skillAgentMap: { 'gh-maestro-coder': 'nonexistent-agent-42' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('unknown agent') && i.includes('[WARN]')));
});

test('validateConfig: skillAgentMap の空のエージェントID はエラー', () => {
  const defaults = loadDefaults();
  const config = { skillAgentMap: { 'gh-maestro-coder': '' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('empty agent ID') && i.includes('[ERROR]')));
});

test('validateConfig: skillAgentMap がオブジェクトでなければエラー', () => {
  const defaults = loadDefaults();
  const config = { skillAgentMap: 'not-an-object' };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('skillAgentMap must be an object')));
});

test('validateConfig: agents がオブジェクトでなければエラー', () => {
  const defaults = loadDefaults();
  const config = { agents: 'invalid' };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('agents must be an object')));
});

test('validateConfig: agents エントリがオブジェクトでなければエラー', () => {
  const defaults = loadDefaults();
  const config = { agents: { 'bad-agent': 'not-an-object' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('must be an object') && i.includes('bad-agent')));
});

test('validateConfig: カスタムエージェントが command 欠如でエラー', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'custom-agent': { promptDelivery: 'flag' },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('custom-agent') && i.includes('missing') && i.includes('[ERROR]'),
  ));
});

test('validateConfig: カスタムエージェントが promptDelivery 欠如でエラー', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'custom-agent': { command: 'my-cli' },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('custom-agent') && i.includes('missing') && i.includes('[ERROR]'),
  ));
});

test('validateConfig: デフォルトにあるエージェントの override はエラーにならない', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'claude-ds': { command: 'pwsh' },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.deepEqual(issues, []);
});

test('validateConfig: extendsで既存エージェントを継承するカスタムエージェントはエラーにならない（command/promptDeliveryを自分では持たない）', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'codex-terra': { extends: 'codex', command: 'codex-terra' },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.deepEqual(issues, []);
});

test('validateConfig: extends + 配列追記（extraArgs）のカスタムエージェントはエラーにならない', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'claude-opus': { extends: 'claude', command: 'claude-opus', extraArgs: ['--model', 'opus'] },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.deepEqual(issues, []);
});

test('validateConfig: extends先が存在しないカスタムエージェントはエラーになる', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'broken-agent': { extends: 'no-such-agent' },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('broken-agent') && i.includes('missing') && i.includes('[ERROR]'),
  ));
});

test('validateConfig: 既存デフォルトのagentId（例: codex）を壊れたextendsで上書きしてもエラーになる（PR #170レビュー指摘）', () => {
  const defaults = loadDefaults();
  const config = {
    // "codex" はagent-defaults.jsonに既に存在するが、resolveAgentConfig()は
    // override.extendsを総入れ替えとして扱うため、このextendsが壊れていれば
    // codexにマッピングされた全スキルの起動が壊れる。defaultAgentIds.has('codex')
    // が真であることを理由にこのチェックをスキップしてはならない。
    agents: {
      codex: { extends: 'no-such-agent' },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('codex') && i.includes('extends') && i.includes('[ERROR]'),
  ), `既存デフォルトagentIdへの壊れたextends上書きを検出できていない:\n${issues.join('\n')}`);
});

test('validateConfig: profiles がオブジェクトでなければエラー', () => {
  const defaults = loadDefaults();
  const config = { profiles: 'invalid' };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('profiles must be an object')));
});

test('validateConfig: プロファイルエントリがオブジェクトでなければエラー', () => {
  const defaults = loadDefaults();
  const config = { profiles: { bad: 'not-an-object' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('must be an object') && i.includes('bad')));
});

test('validateConfig: プロファイルの skillAgentMap 欠如はエラー', () => {
  const defaults = loadDefaults();
  const config = { profiles: { empty: {} } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i => i.includes('skillAgentMap') && i.includes('empty')));
});

test('validateConfig: プロファイルの skillAgentMap が空オブジェクトはエラー', () => {
  const defaults = loadDefaults();
  const config = { profiles: { empty: { skillAgentMap: {} } } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('empty') && (i.includes('empty') || i.includes('missing')),
  ));
});

test('validateConfig: プロファイル内の未知のエージェントID は警告', () => {
  const defaults = loadDefaults();
  const config = {
    profiles: {
      test: { skillAgentMap: { 'gh-maestro-coder': 'unknown-agent' } },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('unknown agent') && i.includes('[WARN]') && i.includes('test'),
  ));
});

test('validateConfig: プロファイル内の空エージェントID はエラー', () => {
  const defaults = loadDefaults();
  const config = {
    profiles: {
      test: { skillAgentMap: { 'gh-maestro-coder': '' } },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('empty agent ID') && i.includes('[ERROR]') && i.includes('test'),
  ));
});

test('validateConfig: プロファイル内のエージェントID が config の agents にあれば OK', () => {
  const defaults = loadDefaults();
  const config = {
    agents: {
      'my-custom': { command: 'x', promptDelivery: 'flag' },
    },
    profiles: {
      test: { skillAgentMap: { 'gh-maestro-coder': 'my-custom' } },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  // No issues about unknown agent IDs for my-custom
  const unknownIssues = issues.filter(i => i.includes('unknown agent'));
  assert.deepEqual(unknownIssues, []);
});

test('validateConfig: 未知のスキルキーをトップレベルで警告する', () => {
  const defaults = loadDefaults();
  const config = { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('unknown skill key') && i.includes('[WARN]') && i.includes('gh-maestro-review-manager'),
  ));
});

test('validateConfig: 未知のスキルキーに "did you mean" サジェストを含む', () => {
  const defaults = loadDefaults();
  const config = { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('did you mean') && i.includes('gh-maestro-reviewer'),
  ), 'should suggest gh-maestro-reviewer');
});

test('validateConfig: 通常のスキルキーは警告にならない', () => {
  const defaults = loadDefaults();
  const config = { skillAgentMap: { 'gh-maestro-coder': 'claude-ds' } };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  const unknownKeyIssues = issues.filter(i => i.includes('unknown skill key'));
  assert.deepEqual(unknownKeyIssues, []);
});

test('validateConfig: プロファイル内の未知のスキルキーを警告する', () => {
  const defaults = loadDefaults();
  const config = {
    profiles: {
      bad: { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('unknown skill key') && i.includes('[WARN]') && i.includes('bad'),
  ));
});

test('validateConfig: プロファイルの未知スキルキーに "did you mean" サジェストを含む', () => {
  const defaults = loadDefaults();
  const config = {
    profiles: {
      bad: { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } },
    },
  };
  const issues = validateConfig('global', '/tmp/config.json', config, defaults);
  assert.ok(issues.some(i =>
    i.includes('did you mean') && i.includes('gh-maestro-reviewer') && i.includes('bad'),
  ), 'should suggest gh-maestro-reviewer in profile context');
});

// ── CLI integration: --help ────────────────────────────────────────────────────





// ── CLI integration: use ───────────────────────────────────────────────────────












// CLI status の実サブプロセス統合テストは tests/slow/config-status.test.js
// （`npm run test:slow`）に分離した。checkAgentExists() が未知コマンド1件につき
// pwshを最大2回起動するため、デフォルトの `npm test` に含めると1テストあたり
// 数十秒かかっていた。

// ── CLI integration: doctor ────────────────────────────────────────────────────











// ── saveConfig ─────────────────────────────────────────────────────────────────



// ── Profile differential semantics ─────────────────────────────────────────────

// 'Profile semantics: プロファイルはデフォルトに対する差分として機能する' は
// config.js status を呼ぶため tests/slow/config-status.test.js に移動した。




// ── Config parse error handling ────────────────────────────────────────────────


// ── --workspace flag parsing ───────────────────────────────────────────────────

// 'CLI: --workspace flag が正しく解析される' と
// 'CLI: --workspace の後に値がない場合はデフォルト解決' は config.js status を
// 呼ぶため tests/slow/config-status.test.js に移動した。

// ── CLI integration: status の非対話化トークン警告（Issue #163） ───────────────
// 通常の status 実サブプロセステストは checkAgentExists がログインシェルを起動するため
// tests/slow/config-status.test.js に分離している。ここでは skillAgentMap の全対象
// エージェントを command=process.execPath に上書きし、checkAgentExists が同一コマンドに
// 対して1回（pwsh/bash）だけ起動するよう高速化した上で、警告出力をデフォルトの npm test
// で検証する。


// ── validateCouncilConfig（Issue #230） ───────────────────────────────────────

test('validateCouncilConfig: 正常な council は問題なし', () => {
  const issues = validateCouncilConfig('global', {
    groups: { default: { agents: ['claude', 'agy'], category: 'general' } },
    investigationAgent: 'claude',
  });
  assert.deepEqual(issues, []);
});

test('validateCouncilConfig: council 未定義は問題なし（任意）', () => {
  assert.deepEqual(validateCouncilConfig('global', undefined), []);
});

test('validateCouncilConfig: council がオブジェクトでなければエラー', () => {
  const issues = validateCouncilConfig('global', ['not', 'an', 'object']);
  assert.ok(issues.some(i => i.includes('council must be an object') && i.includes('[ERROR]')));
});

test('validateCouncilConfig: default グループ欠落はファイル単位ではエラーにしない', () => {
  // review指摘 #4: global に default があり workspace が groups を追加する分割設定が
  // false positive にならないよう、"default" 必須はマージ後検証（validateCouncilMerged）の責務。
  const issues = validateCouncilConfig('global', {
    groups: { tech: { agents: ['claude'] } },
  });
  assert.ok(!issues.some(i => i.includes('"default" group is required')));
});

test('validateCouncilConfig: groups がオブジェクトでなければエラー', () => {
  const issues = validateCouncilConfig('global', { groups: 'nope' });
  assert.ok(issues.some(i => i.includes('council.groups') && i.includes('must be an object') && i.includes('[ERROR]')));
});

test('validateCouncilConfig: 空配列 agents はエラー', () => {
  const issues = validateCouncilConfig('global', {
    groups: { default: { agents: [] } },
  });
  assert.ok(issues.some(i => i.includes('non-empty array') && i.includes('[ERROR]')));
});

test('validateCouncilConfig: 重複エージェントIDは警告', () => {
  const issues = validateCouncilConfig('global', {
    groups: { default: { agents: ['claude', 'claude'] } },
  });
  assert.ok(issues.some(i => i.includes('duplicate agent ID') && i.includes('[WARN]')));
});

test('validateCouncilConfig: 解決不能なエージェントIDは警告', () => {
  const issues = validateCouncilConfig('global', {
    groups: { default: { agents: ['no-such-agent'] } },
  });
  assert.ok(issues.some(i => i.includes('unknown/unresolvable agent ID "no-such-agent"') && i.includes('[WARN]')));
});

test('validateCouncilConfig: 解決不能な investigationAgent は警告', () => {
  const issues = validateCouncilConfig('global', {
    groups: { default: { agents: ['claude'] } },
    investigationAgent: 'no-such-agent',
  });
  assert.ok(issues.some(i => i.includes('council.investigationAgent') && i.includes('unknown/unresolvable')));
});

test('validateCouncilConfig: investigationAgent が文字列でない場合はエラー', () => {
  const issues = validateCouncilConfig('global', {
    groups: { default: { agents: ['claude'] } },
    investigationAgent: 42,
  });
  assert.ok(issues.some(i => i.includes('must be a non-empty string') && i.includes('[ERROR]')));
});

test('validateConfig: council セクションの検証結果が issues に混ざる', () => {
  const defaults = loadDefaults();
  const issues = validateConfig('global', '/tmp/config.json', {
    council: { groups: { default: { agents: ['no-such-agent'] } } },
  }, defaults);
  assert.ok(issues.some(i => i.includes('council.groups') && i.includes('unknown/unresolvable')));
});

// ── validateCouncilMerged（マージ後検証。review指摘 #4/#5） ─────────────────────

/**
 * resolve-config.js の resolveCouncilConfig / resolveAgentConfig を差し替えた状態で
 * config.js を再ロードする。config.js はロード時に resolve-config の名前付きエクスポートを
 * 捕捉するため、キャッシュを消して現在のモックを反映させる。
 * @param {object} overrides  resolve-config.js の exports に対する上書き
 * @returns {object} 再ロードした config.js の module.exports
 */
function loadConfigWithResolveConfig(overrides) {
  const configPath = require.resolve('../scripts/config');
  const resolveConfigPath = require.resolve('../scripts/shared/resolve-config');
  const real = require(resolveConfigPath);
  delete require.cache[configPath];
  require.cache[resolveConfigPath] = {
    id: resolveConfigPath,
    filename: resolveConfigPath,
    loaded: true,
    exports: { ...real, ...overrides },
  };
  try {
    return require(configPath);
  } finally {
    delete require.cache[resolveConfigPath];
    delete require.cache[configPath];
  }
}

test('validateCouncilMerged: マージ解決に成功すれば問題なし', () => {
  const mod = loadConfigWithResolveConfig({
    resolveCouncilConfig: () => ({ groups: { default: { agents: ['claude'] } }, investigationAgent: null }),
  });
  assert.deepEqual(mod.validateCouncilMerged({}), []);
});

test('validateCouncilMerged: マージ解決失敗（null）は ERROR で doctor exit 1 の根拠になる', () => {
  const mod = loadConfigWithResolveConfig({ resolveCouncilConfig: () => null });
  const issues = mod.validateCouncilMerged({ workspace: '/ws', homedir: '/home' });
  assert.ok(issues.some(i => i.includes('failed to resolve') && i.includes('[ERROR]')));
});

test('validateCouncilConfig: resolveAgentConfig に workspace コンテクストが渡る（#5）', () => {
  // workspace のみに定義されたカスタムエージェントを「unknown」と誤判定しないよう、
  // エージェント解決に workspace が渡ることを検証する。
  const seenOpts = [];
  const mod = loadConfigWithResolveConfig({
    resolveAgentConfig: (agentId, opts) => {
      seenOpts.push(opts);
      return agentId === 'ws-only' ? { id: 'ws-only' } : null;
    },
  });
  const issues = mod.validateCouncilConfig('workspace', {
    groups: { default: { agents: ['ws-only'] } },
    investigationAgent: 'ws-only',
  }, { workspace: '/ws', homedir: '/home' });
  assert.deepEqual(issues, []);
  assert.deepEqual(seenOpts, [
    { homedir: '/home', workspace: '/ws' },
    { homedir: '/home', workspace: '/ws' },
  ]);
});
