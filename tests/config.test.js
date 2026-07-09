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
  shallowEqual,
  resolveSkillAgentMapWithSources,
  validateConfig,
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

// ── shallowEqual ───────────────────────────────────────────────────────────────

test('shallowEqual: 同一オブジェクトは true', () => {
  assert.equal(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }), true);
});

test('shallowEqual: 異なる値は false', () => {
  assert.equal(shallowEqual({ a: 1 }, { a: 2 }), false);
});

test('shallowEqual: キー数が異なる場合は false', () => {
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 2 }), false);
});

test('shallowEqual: null 同士は false', () => {
  assert.equal(shallowEqual(null, null), false);
});

test('shallowEqual: 一方が null は false', () => {
  assert.equal(shallowEqual({ a: 1 }, null), false);
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

// ── CLI integration: --help ────────────────────────────────────────────────────

test('CLI: --help は usage を表示し exit 0', () => {
  withTempHome(home => {
    const r = runConfig(['--help'], home);
    assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('config.js'), 'stdout should include script name');
    assert.ok(r.stdout.includes('use'), 'stdout should mention use subcommand');
    assert.ok(r.stdout.includes('status'), 'stdout should mention status subcommand');
    assert.ok(r.stdout.includes('doctor'), 'stdout should mention doctor subcommand');
  });
});

test('CLI: -h も同様', () => {
  withTempHome(home => {
    const r = runConfig(['-h'], home);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('config.js'));
  });
});

test('CLI: サブコマンドなしは usage を stderr に出して exit 1', () => {
  withTempHome(home => {
    const r = runConfig([], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('config.js'), 'stderr should include usage');
  });
});

test('CLI: 不明なサブコマンドはエラーで exit 1', () => {
  withTempHome(home => {
    const r = runConfig(['unknown-subcommand'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('unknown'), 'stderr mentions unknown');
  });
});

// ── CLI integration: use ───────────────────────────────────────────────────────

test('CLI use: プロファイルを適用できる', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy' });
    assert.ok(r.stdout.includes('peak'), 'stdout includes profile name');
  });
});

test('CLI use: プロファイル名がない場合はエラー', () => {
  withTempHome(home => {
    const r = runConfig(['use'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('profile name required'), r.stderr);
  });
});

test('CLI use: 存在しないプロファイルはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    const r = runConfig(['use', 'nonexistent'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('not found'), r.stderr);
    assert.ok(r.stderr.includes('peak'), 'should list available profiles');
  });
});

test('CLI use: プロファイルがない状態で use すると利用可能一覧なし', () => {
  withTempHome(home => {
    writeConfig(home, {});

    const r = runConfig(['use', 'any'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('No profiles defined'), r.stderr);
  });
});

test('CLI use: プロファイルの skillAgentMap が空オブジェクトはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        bad: { skillAgentMap: {} },
      },
    });

    const r = runConfig(['use', 'bad'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('no valid skillAgentMap'), r.stderr);
  });
});

test('CLI use: 未知のエージェントID を含むプロファイルはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        bad: { skillAgentMap: { 'gh-maestro-coder': 'no-such-agent' } },
      },
    });

    const r = runConfig(['use', 'bad'], home);
    assert.notEqual(r.status, 0);
    assert.ok(
      r.stderr.includes('not found') || r.stderr.includes('no-such-agent'),
      `stderr should mention bad agent: ${r.stderr}`,
    );
  });
});

test('CLI use: カスタムエージェントをプロファイルで参照できる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'my-agent': { command: 'my-cli', promptDelivery: 'flag' },
      },
      profiles: {
        custom: { skillAgentMap: { 'gh-maestro-coder': 'my-agent' } },
      },
    });

    const r = runConfig(['use', 'custom'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'my-agent' });
  });
});

test('CLI use: 既存のエージェント設定は保持される', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'claude-ds': { command: 'pwsh' },
      },
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy' });
    assert.ok(config.agents, 'agents section preserved');
    assert.ok(config.agents['claude-ds'], 'claude-ds override preserved');
  });
});

test('CLI use: プロファイル適用で前の skillAgentMap を上書きマージする', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'codex', 'gh-maestro-base': 'codex' },
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    // Apply peak
    let r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy', 'gh-maestro-base': 'codex' });
  });
});

// ── CLI integration: status ────────────────────────────────────────────────────

test('CLI status: デフォルトマップを表示できる', () => {
  withTempHome(home => {
    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    // Should include default mappings
    assert.ok(r.stdout.includes('gh-maestro-coder'), 'includes coder skill');
    assert.ok(r.stdout.includes('gh-maestro-explorer'), 'includes explorer skill');
    assert.ok(r.stdout.includes('default'), 'includes source column');
  });
});

test('CLI status: global override されたエントリのソースが表示される', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'agy' },
    });

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('global'), 'includes global source');
  });
});

test('CLI status: workspace override の command/extraArgs 警告を表示する', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, {
        agents: {
          'claude-ds': { command: 'evil', extraArgs: ['--bad'] },
        },
      });

      const r = runConfig(['status', '--workspace', ws], home);
      assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
      assert.ok(
        r.stdout.includes('IGNORED'),
        `should warn about ignored overrides: ${r.stdout}`,
      );
      assert.ok(r.stdout.includes('claude-ds'), 'should mention agent id');
    });
  });
});

test('CLI status: workspace なしでは workspace config 警告は出ない', () => {
  withTempHome(home => {
    writeConfig(home, {});
    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('IGNORED'), 'should not mention IGNORED without workspace');
  });
});

test('CLI status: config.json がない場合でもデフォルトマップを表示する', () => {
  withTempHome(home => {
    // No config.json written
    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('gh-maestro-coder'), 'includes default map');
  });
});

// ── CLI integration: doctor ────────────────────────────────────────────────────

test('CLI doctor: 正常な config は OK を表示する', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'claude-ds' } },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('OK'), `should say OK: ${r.stdout}`);
  });
});

test('CLI doctor: config がない場合も OK を表示する', () => {
  withTempHome(home => {
    // No config.json
    const r = runConfig(['doctor'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('OK'), 'no config is OK');
  });
});

test('CLI doctor: パースエラーは exit code 1 で報告する', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ bad json', 'utf8');

    const r = runConfig(['doctor'], home);
    assert.notEqual(r.status, 0, `should fail: ${r.status}`);
    assert.ok(r.stdout.includes('[ERROR]'), 'should include ERROR');
  });
});

test('CLI doctor: 未知のエージェントID は警告する', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'no-such-agent' },
    });

    const r = runConfig(['doctor'], home);
    assert.ok(
      r.stdout.includes('[WARN]') && r.stdout.includes('no-such-agent'),
      `should warn: ${r.stdout}`,
    );
  });
});

test('CLI doctor: 不完全なカスタムエージェントはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'incomplete': { label: 'No command or delivery' },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.notEqual(r.status, 0, 'should exit with error');
    assert.ok(
      r.stdout.includes('[ERROR]') && r.stdout.includes('incomplete'),
      `should report incomplete agent: ${r.stdout}`,
    );
  });
});

test('CLI doctor: プロファイルの空 skillAgentMap はエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        empty: { skillAgentMap: {} },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.notEqual(r.status, 0, 'should exit with error');
    assert.ok(
      r.stdout.includes('[ERROR]') && r.stdout.includes('empty'),
      `should report empty profile: ${r.stdout}`,
    );
  });
});

test('CLI doctor: workspace config も検証する', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, { skillAgentMap: { 'x': 'bad-agent' } });

      const r = runConfig(['doctor', '--workspace', ws], home);
      assert.ok(
        r.stdout.includes('[WARN]') || r.stdout.includes('workspace'),
        `should include workspace issues: ${r.stdout}`,
      );
    });
  });
});

test('CLI doctor: workspace config のパースエラーを報告する', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      fs.writeFileSync(path.join(ws, '.gh-maestro', 'config.json'), '{ bad', 'utf8');

      const r = runConfig(['doctor', '--workspace', ws], home);
      assert.notEqual(r.status, 0, 'workspace parse error should fail');
      assert.ok(
        r.stdout.includes('[ERROR]') && r.stdout.includes('workspace'),
        `should report workspace error: ${r.stdout}`,
      );
    });
  });
});

// ── saveConfig ─────────────────────────────────────────────────────────────────

test('saveConfig: 設定を書き込める', () => {
  withTempHome(home => {
    const { saveConfig } = require('../scripts/config');
    const configPath = path.join(home, '.gh-maestro', 'config.json');
    // Override CONFIG_PATH for this test — can't directly, so test via use CLI
    writeConfig(home, {
      profiles: {
        test: { skillAgentMap: { 'gh-maestro-coder': 'claude' } },
      },
    });

    const r = runConfig(['use', 'test'], home);
    assert.equal(r.status, 0, r.stderr);

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.skillAgentMap, { 'gh-maestro-coder': 'claude' });
    assert.ok(saved.profiles, 'profiles preserved');
  });
});

test('saveConfig: 新規ファイルを作成できる', () => {
  withTempHome(home => {
    // Remove .gh-maestro dir
    fs.rmSync(path.join(home, '.gh-maestro'), { recursive: true, force: true });

    writeConfig(home, {
      profiles: {
        test: { skillAgentMap: { 'gh-maestro-coder': 'claude' } },
      },
    });

    // writeConfig creates .gh-maestro dir — now use a profile
    const r = runConfig(['use', 'test'], home);
    assert.equal(r.status, 0, r.stderr);

    const configPath = path.join(home, '.gh-maestro', 'config.json');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.skillAgentMap, { 'gh-maestro-coder': 'claude' });
  });
});

// ── Profile differential semantics ─────────────────────────────────────────────

test('Profile semantics: プロファイルはデフォルトに対する差分として機能する', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        partial: { skillAgentMap: { 'gh-maestro-coder': 'codex' } },
      },
    });

    // Apply partial profile
    let r = runConfig(['use', 'partial'], home);
    assert.equal(r.status, 0, r.stderr);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'codex' });

    // Now check status: only coder skill is overridden, rest are defaults
    r = runConfig(['status'], home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('gh-maestro-base'), 'base should still be resolved from defaults');
  });
});

test('Profile semantics: プロファイルの重ね掛け（スタック適用）ができる', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: {
          skillAgentMap: {
            'gh-maestro-coder': 'agy',
            'gh-maestro-explorer': 'claude',
          },
        },
        'avoid-codex': {
          skillAgentMap: {
            'gh-maestro-explorer': 'claude-ds',
          },
        },
      },
    });

    // 1. peakプロファイルを適用
    let r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0, r.stderr);

    let config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, {
      'gh-maestro-coder': 'agy',
      'gh-maestro-explorer': 'claude',
    });

    // 2. avoid-codexプロファイルを重ね掛けで適用
    r = runConfig(['use', 'avoid-codex'], home);
    assert.equal(r.status, 0, r.stderr);

    config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, {
      'gh-maestro-coder': 'agy',
      'gh-maestro-explorer': 'claude-ds',
    });
  });
});

// ── Config parse error handling ────────────────────────────────────────────────

test('CLI use: パース不能な config の場合はエラー', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ corrupt', 'utf8');

    const r = runConfig(['use', 'any'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('cannot parse'), r.stderr);
  });
});

test('CLI status: パース不能な config でもデフォルトマップは表示する', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ corrupt', 'utf8');

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('gh-maestro-coder'), 'includes default map despite parse error');
  });
});

// ── --workspace flag parsing ───────────────────────────────────────────────────

test('CLI: --workspace flag が正しく解析される', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, {
        skillAgentMap: { 'gh-maestro-coder': 'codex' },
      });

      const r = runConfig(['status', '--workspace', ws], home);
      assert.equal(r.status, 0, r.stderr);
      // The workspace value should override the skill map
      assert.ok(r.stdout.includes('workspace'), 'should show workspace source');
    });
  });
});

test('CLI: --workspace の後に値がない場合はデフォルト解決', () => {
  withTempHome(home => {
    writeConfig(home, {});
    // --workspace の後ろに値が来ず、次の引数が不明なフラグの場合
    const r = runConfig(['status', '--workspace'], home);
    assert.equal(r.status, 0, `status exit 0, stderr: ${r.stderr}`);
  });
});
