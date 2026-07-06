'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveAgentConfig,
  resolveSkillAgentMap,
  loadDefaults,
} = require('../scripts/shared/resolve-config');

// ── helpers ──────────────────────────────────────────────────────────────────

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-resolve-config-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(home, data) {
  fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

function writeWorkspaceConfig(ws, data) {
  fs.mkdirSync(path.join(ws, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

// ── loadDefaults ─────────────────────────────────────────────────────────────

test('loadDefaults: agent-defaults.json を読める', () => {
  const defaults = loadDefaults();
  assert.ok(Array.isArray(defaults.agents), 'agents should be an array');
  assert.ok(defaults.agents.length >= 5, 'should have at least 5 agents');
  assert.ok(typeof defaults.skillAgentMap === 'object', 'skillAgentMap should be an object');
});

test('loadDefaults: 各エージェントが id, command, runtime, promptDelivery を持つ', () => {
  const defaults = loadDefaults();
  for (const agent of defaults.agents) {
    assert.ok(agent.id, `agent should have id: ${JSON.stringify(agent)}`);
    assert.ok(agent.command, `agent ${agent.id} should have command`);
    assert.ok(agent.runtime, `agent ${agent.id} should have runtime`);
    assert.ok(agent.promptDelivery, `agent ${agent.id} should have promptDelivery`);
  }
});

test('loadDefaults: runtime が agents.yaml のキー (claude|agy|codex) のいずれか', () => {
  const defaults = loadDefaults();
  const validRuntimes = new Set(['claude', 'agy', 'codex']);
  for (const agent of defaults.agents) {
    assert.ok(
      validRuntimes.has(agent.runtime),
      `agent ${agent.id}: runtime "${agent.runtime}" should be one of claude|agy|codex`,
    );
  }
});

test('loadDefaults: reasonix が dynamicCommand を持つ', () => {
  const defaults = loadDefaults();
  const reasonix = defaults.agents.find(a => a.id === 'reasonix');
  assert.ok(reasonix, 'reasonix should exist in defaults');
  assert.equal(reasonix.dynamicCommand, true, 'reasonix should have dynamicCommand: true');
  assert.equal(reasonix.skillsViaMd, true, 'reasonix should have skillsViaMd: true');
});

// ── resolveAgentConfig ───────────────────────────────────────────────────────

test('resolveAgentConfig: デフォルトからエージェントを解決できる', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.ok(agent, 'agent should be resolved');
    assert.equal(agent.id, 'claude-ds');
    assert.equal(agent.command, 'claude-ds');
    assert.equal(agent.promptDelivery, 'system-prompt-file');
  });
});

test('resolveAgentConfig: agentId が null なら null を返す', () => {
  withTempHome(home => {
    assert.equal(resolveAgentConfig(null, { homedir: home }), null);
  });
});

test('resolveAgentConfig: 存在しないエージェントIDは null を返す', () => {
  withTempHome(home => {
    assert.equal(resolveAgentConfig('nonexistent-agent', { homedir: home }), null);
  });
});

test('resolveAgentConfig: ~/.gh-maestro/config.json の override がデフォルトを上書きする', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'claude-ds': { command: 'pwsh', extraArgs: ['-NoLogo', '-Command', 'claude-ds-wrapper'] },
      },
    });

    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.equal(agent.command, 'pwsh');
    assert.deepEqual(agent.extraArgs, ['-NoLogo', '-Command', 'claude-ds-wrapper']);
    // 上書きされていないフィールドはデフォルトのまま
    assert.equal(agent.promptDelivery, 'system-prompt-file');
  });
});

test('resolveAgentConfig: workspace config が global config を上書きする', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-'));
    try {
      writeConfig(home, {
        agents: { 'claude-ds': { command: 'global-cmd' } },
      });
      writeWorkspaceConfig(ws, {
        agents: { 'claude-ds': { command: 'workspace-cmd' } },
      });

      const agent = resolveAgentConfig('claude-ds', { homedir: home, workspace: ws });
      assert.equal(agent.command, 'workspace-cmd', 'workspace should win over global');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: 解決順序 — workspace > global > defaults', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-order-'));
    try {
      // デフォルト: command='claude-ds', extraArgs=['--dangerously-skip-permissions']
      // global: command='global-claude'
      // workspace: extraArgs=['--custom-flag']
      writeConfig(home, {
        agents: { 'claude-ds': { command: 'global-claude' } },
      });
      writeWorkspaceConfig(ws, {
        agents: { 'claude-ds': { extraArgs: ['--custom-flag'] } },
      });

      const agent = resolveAgentConfig('claude-ds', { homedir: home, workspace: ws });
      assert.equal(agent.command, 'global-claude', 'global overrides default command');
      assert.deepEqual(agent.extraArgs, ['--custom-flag'], 'workspace overrides global extraArgs');
      assert.equal(agent.promptDelivery, 'system-prompt-file', 'default field unchanged');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: デフォルトにないカスタムエージェントは config から解決できる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'my-custom-agent': { command: 'custom-cli', label: 'Custom', promptDelivery: 'flag', promptFlag: '-p' },
      },
    });

    // デフォルトに無いエージェントは global override だけでは解決できない
    // （merge のベースとなる defaultAgent が存在しないため）
    const agent = resolveAgentConfig('my-custom-agent', { homedir: home });
    // デフォルトにベースが無いので null
    assert.equal(agent, null, 'agent not in defaults should return null even if in config');
  });
});

test('resolveAgentConfig: config.json が存在しなければデフォルトだけを使う', () => {
  withTempHome(home => {
    // config.json を作らない
    const agent = resolveAgentConfig('agy', { homedir: home });
    assert.ok(agent);
    assert.equal(agent.command, 'agy');
    assert.equal(agent.promptDelivery, 'flag');
  });
});

test('resolveAgentConfig: config.json のパース失敗時はデフォルトにフォールバック', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), '{ invalid json', 'utf8');

    const agent = resolveAgentConfig('agy', { homedir: home });
    assert.ok(agent, 'should fall back to defaults on parse error');
    assert.equal(agent.command, 'agy');
  });
});

test('resolveAgentConfig: config.json が配列の場合はデフォルトにフォールバック', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), '[]', 'utf8');

    const agent = resolveAgentConfig('agy', { homedir: home });
    assert.ok(agent, 'should fall back to defaults for array config');
  });
});

// ── resolveSkillAgentMap ─────────────────────────────────────────────────────

test('resolveSkillAgentMap: デフォルトのマッピングを返す', () => {
  withTempHome(home => {
    const map = resolveSkillAgentMap({ homedir: home });
    assert.equal(map['gh-maestro-coder'], 'claude-ds');
    assert.equal(map['gh-maestro-base'], 'claude-ds');
    assert.equal(map['gh-maestro-senior-coder'], 'claude-ds-pro');
    assert.equal(map['gh-maestro-investigator'], 'reasonix');
    assert.equal(map['gh-maestro-explorer'], 'agy');
  });
});

test('resolveSkillAgentMap: global config がマッピングを上書きする', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: {
        'gh-maestro-coder': 'custom-agent',
      },
    });

    const map = resolveSkillAgentMap({ homedir: home });
    assert.equal(map['gh-maestro-coder'], 'custom-agent', 'global override should win');
    // 上書きされていないエントリはデフォルトのまま
    assert.equal(map['gh-maestro-explorer'], 'agy');
  });
});

test('resolveSkillAgentMap: workspace config が global config を上書きする', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-skillmap-'));
    try {
      writeConfig(home, {
        skillAgentMap: { 'gh-maestro-coder': 'global-agent' },
      });
      writeWorkspaceConfig(ws, {
        skillAgentMap: { 'gh-maestro-coder': 'workspace-agent' },
      });

      const map = resolveSkillAgentMap({ homedir: home, workspace: ws });
      assert.equal(map['gh-maestro-coder'], 'workspace-agent', 'workspace should win over global');
      assert.equal(map['gh-maestro-investigator'], 'reasonix', 'unrelated entry unchanged');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ── reasonix 動的コマンド解決 ────────────────────────────────────────────────

test('resolveAgentConfig: reasonix の command が動的に解決される', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('reasonix', { homedir: home });
    assert.ok(agent, 'reasonix should be resolved');
    // npm root -g の結果に依存するため、command が 'node' または 'reasonix' のいずれか
    assert.ok(
      agent.command === 'node' || agent.command === 'reasonix',
      `reasonix command should be 'node' or 'reasonix', got: ${agent.command}`,
    );
    // extraArgs には少なくとも '--yolo' が含まれる
    assert.ok(
      agent.extraArgs.some(a => a === '--yolo'),
      'extraArgs should include --yolo',
    );
    // skillsViaMd は維持される
    assert.equal(agent.skillsViaMd, true);
    // enterSequence は維持される
    assert.equal(agent.enterSequence, '\r');
  });
});

// ── 設定マージの境界ケース ──────────────────────────────────────────────────

test('resolveAgentConfig: override が空オブジェクトの場合はデフォルトがそのまま返る', () => {
  withTempHome(home => {
    writeConfig(home, { agents: { 'claude-ds': {} } });
    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.equal(agent.command, 'claude-ds', 'empty override should not change anything');
  });
});

test('resolveAgentConfig: workspace 未指定時は global config のみ考慮', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: { 'claude-ds': { enterSequence: '\n' } },
    });

    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.equal(agent.enterSequence, '\n', 'global override should apply');
    assert.equal(agent.command, 'claude-ds', 'default field unchanged');
  });
});
