'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveAgentConfig,
  resolveSkillAgentMap,
  resolveReviewManagerVisible,
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
        agents: { 'claude-ds': { enterSequence: '\n' } },
      });
      writeWorkspaceConfig(ws, {
        agents: { 'claude-ds': { enterSequence: '\r' } },
      });

      const agent = resolveAgentConfig('claude-ds', { homedir: home, workspace: ws });
      assert.equal(agent.enterSequence, '\r', 'workspace should win over global for non-exec fields');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: workspace config は command を上書きできない（セキュリティ）', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-sec-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { 'claude-ds': { command: 'malicious-cmd', extraArgs: ['--evil'] } },
      });

      const agent = resolveAgentConfig('claude-ds', { homedir: home, workspace: ws });
      assert.ok(agent);
      assert.equal(agent.command, 'claude-ds', 'workspace should not override command');
      assert.deepEqual(agent.extraArgs, ['--dangerously-skip-permissions'], 'workspace should not override extraArgs');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: workspace config が command/extraArgs 以外は上書きできる', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-safe-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { 'claude-ds': { sendTextDelayMs: 9999, enterSequence: '\r' } },
      });

      const agent = resolveAgentConfig('claude-ds', { homedir: home, workspace: ws });
      assert.ok(agent);
      assert.equal(agent.command, 'claude-ds', 'command unchanged');
      assert.equal(agent.sendTextDelayMs, 9999, 'non-exec field overridable');
      assert.equal(agent.enterSequence, '\r', 'non-exec field overridable');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: global config は command/extraArgs を上書きできる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: { 'claude-ds': { command: 'pwsh', extraArgs: ['-NoLogo', '-Command', 'my-wrapper'] } },
    });

    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.ok(agent);
    assert.equal(agent.command, 'pwsh', 'global config should override command');
    assert.deepEqual(agent.extraArgs, ['-NoLogo', '-Command', 'my-wrapper'], 'global config should override extraArgs');
  });
});

test('resolveAgentConfig: デフォルトにないカスタムエージェントを config.json から解決できる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'my-custom-agent': { command: 'custom-cli', label: 'Custom', promptDelivery: 'flag', promptFlag: '-p' },
      },
    });

    const agent = resolveAgentConfig('my-custom-agent', { homedir: home });
    assert.ok(agent, 'config-only agent should be resolved');
    assert.equal(agent.command, 'custom-cli');
    assert.equal(agent.promptDelivery, 'flag');
    assert.equal(agent.promptFlag, '-p');
    assert.equal(agent.label, 'Custom');
  });
});

test('resolveAgentConfig: config-only エージェントに workspace override が上書きされる', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-custom-'));
    try {
      writeConfig(home, {
        agents: {
          'my-agent': { command: 'global-cli', promptDelivery: 'flag', promptFlag: '-g' },
        },
      });
      writeWorkspaceConfig(ws, {
        agents: {
          'my-agent': { promptFlag: '-w' },
        },
      });

      const agent = resolveAgentConfig('my-agent', { homedir: home, workspace: ws });
      assert.ok(agent);
      assert.equal(agent.command, 'global-cli', 'command from global preserved');
      assert.equal(agent.promptFlag, '-w', 'promptFlag overridden by workspace');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: config-only エージェントが command 欠如で null になる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'incomplete-agent': { label: 'No Command', promptDelivery: 'flag' },
      },
    });

    const agent = resolveAgentConfig('incomplete-agent', { homedir: home });
    assert.equal(agent, null, 'agent without command should be null');
  });
});

test('resolveAgentConfig: config-only エージェントが promptDelivery 欠如で null になる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'incomplete-agent': { command: 'some-cli', label: 'No Delivery' },
      },
    });

    const agent = resolveAgentConfig('incomplete-agent', { homedir: home });
    assert.equal(agent, null, 'agent without promptDelivery should be null');
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
    assert.equal(map['gh-maestro-reviewer'], 'codex');
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

// ── resolveReviewManagerVisible ─────────────────────────────────────────────

test('resolveReviewManagerVisible: 未設定なら既定でfalse（headless）', () => {
  withTempHome(home => {
    assert.equal(resolveReviewManagerVisible({ homedir: home }), false);
  });
});

test('resolveReviewManagerVisible: global config のtrueが反映される', () => {
  withTempHome(home => {
    writeConfig(home, { reviewManagerVisible: true });
    assert.equal(resolveReviewManagerVisible({ homedir: home }), true);
  });
});

test('resolveReviewManagerVisible: workspace config が global config より優先される', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-visible-'));
    try {
      writeConfig(home, { reviewManagerVisible: true });
      writeWorkspaceConfig(ws, { reviewManagerVisible: false });
      assert.equal(resolveReviewManagerVisible({ homedir: home, workspace: ws }), false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveReviewManagerVisible: 非boolean値は無視してデフォルト/上位設定にフォールバックする', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-visible-invalid-'));
    try {
      writeConfig(home, { reviewManagerVisible: true });
      writeWorkspaceConfig(ws, { reviewManagerVisible: 'yes' });
      assert.equal(
        resolveReviewManagerVisible({ homedir: home, workspace: ws }), true,
        '不正なworkspace値は無視してglobalにフォールバックする',
      );
      assert.equal(
        resolveReviewManagerVisible({ homedir: home }), true,
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: gh-maestro-reviewer のマッピング結果を解決できる', () => {
  withTempHome(home => {
    const map = resolveSkillAgentMap({ homedir: home });
    const agentId = map['gh-maestro-reviewer'];
    assert.equal(agentId, 'codex');

    const agent = resolveAgentConfig(agentId, { homedir: home });
    assert.ok(agent);
    assert.equal(agent.id, 'codex');
    assert.equal(agent.command, 'codex');
  });
});

test('loadDefaults: codex は承認バイパス/danger-full-accessを持たず、workspace-write + never approvalを使う（Issue #101）', () => {
  const defaults = loadDefaults();
  const codex = defaults.agents.find(a => a.id === 'codex');
  assert.ok(codex, 'codex should exist in defaults');
  assert.ok(
    !codex.extraArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
    'extraArgs should not include the approvals/sandbox bypass flag',
  );
  assert.ok(!codex.execArgs.includes('danger-full-access'), 'execArgs should not request danger-full-access');
  assert.ok(codex.execArgs.includes('workspace-write'), 'execArgs should request workspace-write sandbox');
  // codex exec には --ask-for-approval フラグが存在しない（実機確認済み: `error: unexpected
  // argument '--ask-for-approval' found`）。exec は元々非対話実行のため、承認方針は
  // -c approval_policy=never という設定オーバーライドで表現する。
  assert.ok(!codex.execArgs.includes('--ask-for-approval'), 'exec has no --ask-for-approval flag; must not be used');
  assert.ok(
    codex.execArgs.some(a => a === 'approval_policy=never'),
    'execArgs should set approval_policy=never via -c override',
  );
  assert.ok(
    codex.execArgs.some(a => a === 'sandbox_workspace_write.network_access=true'),
    'execArgs should enable network access within the workspace-write sandbox',
  );
  // 専用worktreeは毎回新規パスのため、Codexの「trusted directory」判定に未登録で
  // codex exec が即エラー終了する（実機確認済み: "Not inside a trusted directory and
  // --skip-git-repo-check was not specified."）。非対話自動実行のため trust プロンプトへの
  // 応答手段がなく、これを付けないと初回実行が必ず失敗する。
  assert.ok(codex.execArgs.includes('--skip-git-repo-check'), 'execArgs should skip the git-repo trust check for fresh worktrees');
});
