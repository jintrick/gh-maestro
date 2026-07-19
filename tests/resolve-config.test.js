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
const { buildAgentCommandArgs } = require('../scripts/agent-launch');

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

test('resolveAgentConfig: グローバルpwshラッパーのReview ManagerはClaudeをストリーム出力で起動する', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'claude-ds-pro': {
          command: 'pwsh',
          extraArgs: ['-Command', 'claude-ds-pro --dangerously-skip-permissions'],
          execArgs: ['-Command', 'claude-ds-pro --dangerously-skip-permissions --print --output-format stream-json --verbose'],
        },
      },
    });
    const agent = resolveAgentConfig('claude-ds-pro', { homedir: home });
    const args = buildAgentCommandArgs({ ...agent, extraArgs: agent.execArgs }, {
      promptFile: 'C:/tmp/review-manager-prompt.md',
      systemPromptText: 'review',
    });
    assert.deepEqual(args, [
      'pwsh', '-Command', 'claude-ds-pro --dangerously-skip-permissions --print --output-format stream-json --verbose',
      '--append-system-prompt-file', 'C:/tmp/review-manager-prompt.md', 'review',
    ]);
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
      assert.deepEqual(
        agent.extraArgs,
        ['--dangerously-skip-permissions', '--print', '--output-format', 'stream-json', '--verbose'],
        'workspace should not override extraArgs'
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: workspace config は execArgs も上書きできない（セキュリティ, PR #103 Review Manager指摘）', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-sec-execargs-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { codex: { execArgs: ['exec', '--sandbox', 'danger-full-access'] } },
      });

      const agent = resolveAgentConfig('codex', { homedir: home, workspace: ws });
      assert.ok(agent);
      assert.ok(
        !agent.execArgs.includes('danger-full-access'),
        'workspace should not be able to swap execArgs for a config missing the sandbox/trust safety flags',
      );
      assert.ok(agent.execArgs.includes('--skip-git-repo-check'), 'default execArgs should be preserved');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test('resolveAgentConfig: workspace config は Review Manager用プロンプト設定を上書きできない（セキュリティ）', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-sec-exec-prompt-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { agy: { execPromptDelivery: 'positional', execPromptFlag: '--malicious' } },
      });

      const agent = resolveAgentConfig('agy', { homedir: home, workspace: ws });
      assert.ok(agent);
      assert.equal(agent.execPromptDelivery, 'flag');
      assert.equal(agent.execPromptFlag, '--print');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
test('resolveAgentConfig: workspace config は resumeCommand も上書きできない（セキュリティ, Issue \\#132）', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-sec-resume-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { codex: { resumeCommand: ['exec', 'resume', '--dangerous'] } },
      });

      const agent = resolveAgentConfig('codex', { homedir: home, workspace: ws });
      assert.ok(agent);
      assert.ok(
        !agent.resumeCommand.includes('--dangerous'),
        'workspace should not be able to inject dangerous flags via resumeCommand',
      );
      assert.ok(agent.resumeCommand.includes('--last'), 'default resumeCommand should be preserved');
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
    assert.equal(map['gh-maestro-architect'], 'codex-pro');
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
    // extraArgs には少なくとも 'run'（非対話1回実行モード）が含まれる
    assert.ok(
      agent.extraArgs.some(a => a === 'run'),
      'extraArgs should include run',
    );
    // enterSequence は維持される
    assert.equal(agent.enterSequence, '\r');
  });
});

test('resolveAgentConfig: reasonix のReview Manager用execArgsにも動的スクリプトパスを付与する', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('reasonix', { homedir: home });
    assert.ok(agent);
    assert.ok(agent.execArgs.includes('run'));
    assert.ok(agent.execArgs.includes('--show-thinking'));

    if (agent.command === 'node') {
      assert.ok(agent.execArgs[0].endsWith('reasonix.js'));
      assert.equal(agent.execArgs[1], 'run');
    }
  });
});
test('resolveAgentConfig: global extraArgs 上書き後も dynamicCommand 解決が保持される（Issue #124）', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        reasonix: { extraArgs: ['--my-override-flag'] },
      },
    });

    const agent = resolveAgentConfig('reasonix', { homedir: home });
    assert.ok(agent, 'reasonix should be resolved with override');

    // command は動的解決が保持される
    assert.ok(
      agent.command === 'node' || agent.command === 'reasonix',
      `reasonix command should be 'node' or 'reasonix', got: ${agent.command}`,
    );

    // 上書きした extraArgs の値が含まれている（mergeAgentConfig の配列ごと置換）
    assert.ok(
      agent.extraArgs.some(a => a === '--my-override-flag'),
      'extraArgs should include the overridden --my-override-flag',
    );

    // デフォルトの --yolo は上書きにより消える（mergeAgentConfig の既存挙動）
    assert.equal(
      agent.extraArgs.some(a => a === '--yolo'), false,
      'default --yolo should be gone after extraArgs override',
    );

    // 動的解決が 'node' になった場合、extraArgs の先頭にスクリプトパスが付与されている
    if (agent.command === 'node') {
      assert.ok(
        agent.extraArgs[0] && agent.extraArgs[0].endsWith('reasonix.js'),
        'first extraArg should be the dynamically resolved reasonix.js path when command is node',
      );
      // 動的解決の先頭要素が上書き値より前に来ている
      assert.equal(
        agent.extraArgs[1], '--my-override-flag',
        'overridden flag should come after the dynamically resolved script path',
      );
    }
  });
});

test('resolveAgentConfig: command 明示上書き時は dynamicCommand 解決をスキップする（PR #129 レビュー指摘）', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        reasonix: {
          command: 'my-custom-wrapper',
          extraArgs: ['--custom-flag'],
        },
      },
    });

    const agent = resolveAgentConfig('reasonix', { homedir: home });
    assert.ok(agent, 'reasonix should be resolved with command override');

    // command はユーザー指定のまま（dynamicCommand 解決で上書きされない）
    assert.equal(
      agent.command, 'my-custom-wrapper',
      'user-overridden command should be preserved, not replaced by dynamic resolution',
    );

    // extraArgs はユーザー指定のまま（動的解決のスクリプトパスが付与されない）
    assert.deepEqual(
      agent.extraArgs, ['--custom-flag'],
      'extraArgs should only contain user-specified values, no dynamic script path',
    );

    // 他のフィールドは維持される
    assert.equal(agent.enterSequence, '\r', 'enterSequence should be preserved');
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

test('resolveAgentConfig: gh-maestro-architect は codex-pro に解決される', () => {
  withTempHome(home => {
    const map = resolveSkillAgentMap({ homedir: home });
    const agent = resolveAgentConfig(map['gh-maestro-architect'], { homedir: home });
    assert.equal(agent.id, 'codex-pro');
    assert.equal(agent.command, 'codex-pro');
  });
});
