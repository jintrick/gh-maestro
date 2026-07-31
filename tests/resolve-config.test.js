'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveAgentConfig,
  resolveSkillAgentMap,
  resolveExtends,
  loadDefaults,
  validateNonInteractiveTokens,
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

test('loadDefaults: 各エージェントが id, command, runtime, promptDelivery を持つ（extends解決後）', () => {
  const defaults = loadDefaults();
  // claude-ds/claude-ds-pro/codex-pro のように extends で大半のフィールドを継承する
  // エントリは、生のままだと runtime 等が無い。resolveExtends で解決した実効値を見る。
  for (const raw of defaults.agents) {
    const agent = resolveExtends(raw, defaults.agents);
    assert.ok(agent.id, `agent should have id: ${JSON.stringify(agent)}`);
    assert.ok(agent.command, `agent ${agent.id} should have command`);
    assert.ok(agent.runtime, `agent ${agent.id} should have runtime`);
    assert.ok(agent.promptDelivery, `agent ${agent.id} should have promptDelivery`);
  }
});

test('loadDefaults: runtime が agents.yaml のキー (claude|agy|codex) のいずれか（extends解決後）', () => {
  const defaults = loadDefaults();
  const validRuntimes = new Set(['claude', 'agy', 'codex']);
  for (const raw of defaults.agents) {
    const agent = resolveExtends(raw, defaults.agents);
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

// ── extends（4種のCLIランタイム以外はモデル違いのラッパーに過ぎない、という運用実態への対応） ──

test('resolveExtends: extends が無ければそのまま返す', () => {
  const defaults = loadDefaults();
  const entry = { id: 'x', command: 'x' };
  assert.equal(resolveExtends(entry, defaults.agents), entry);
});

test('resolveExtends: agent-defaults.json自身のclaude-ds-pro/codex-proがclaude/codexを正しく継承している', () => {
  withTempHome(home => {
    const dsPro = resolveAgentConfig('claude-ds-pro', { homedir: home });
    assert.equal(dsPro.id, 'claude-ds-pro');
    assert.equal(dsPro.command, 'claude-ds-pro');
    assert.equal(dsPro.promptDelivery, 'system-prompt-file');
    assert.equal(dsPro.rulesSupported, true);
    assert.deepEqual(dsPro.resumeCommand, ['--continue']);

    const codexPro = resolveAgentConfig('codex-pro', { homedir: home });
    assert.equal(codexPro.id, 'codex-pro');
    assert.equal(codexPro.command, 'codex-pro');
    assert.equal(codexPro.promptDelivery, 'positional');
    assert.deepEqual(codexPro.resumeCommand, ['resume', '--last']);
    assert.ok(codexPro.extraArgs.includes('--skip-git-repo-check'));
  });
});

test('resolveAgentConfig: ~/.gh-maestro/config.json だけで定義したextendsベースのカスタムエージェントを解決できる（agent-defaults.jsonへの追記不要）', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'codex-terra': { extends: 'codex', command: 'codex-terra' },
      },
    });

    const agent = resolveAgentConfig('codex-terra', { homedir: home });
    assert.ok(agent);
    // idは常に呼び出し元が要求したagentIdに固定される（継承元のidを引きずらない。
    // さもないとworkers.json経由のresumeで継承元そのものを起動してしまう）
    assert.equal(agent.id, 'codex-terra');
    assert.equal(agent.command, 'codex-terra');
    assert.equal(agent.promptDelivery, 'positional');
    assert.deepEqual(agent.resumeCommand, ['resume', '--last']);
  });
});

test('resolveAgentConfig: extends先が存在しないIDだとnullを返す（isValidAgentConfigが不完全な結果を弾く）', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: { 'broken-agent': { extends: 'no-such-agent' } },
    });
    assert.equal(resolveAgentConfig('broken-agent', { homedir: home }), null);
  });
});

test('resolveExtends: 循環参照はフェイルクローズする（無限再帰せず不完全な結果を返す）', () => {
  const cyclic = [
    { id: 'a', command: 'a', extends: 'b' },
    { id: 'b', command: 'b', extends: 'a' },
  ];
  const resolved = resolveExtends(cyclic[0], cyclic);
  // 循環検出時点のエントリ自身のフィールドのみが残り、無限再帰しない
  assert.equal(resolved.id, 'a');
  assert.ok(!('runtime' in resolved), 'circular extends should not fabricate inherited fields');
});

test('resolveAgentConfig: workspace config の extends は無視される（EXEC_SENSITIVE_FIELDS、セキュリティ）', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-extends-sec-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { 'workspace-only-agent': { extends: 'codex', command: 'workspace-only-agent' } },
      });
      // extendsが剥がされると command のみが残り、promptDelivery 等の必須フィールドが
      // 揃わないため isValidAgentConfig で弾かれ null になる（＝丸ごと継承の抜け道にならない）。
      assert.equal(resolveAgentConfig('workspace-only-agent', { homedir: home, workspace: ws }), null);
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
  });
});

test('resolveAgentConfig: reasonix のReview Manager用execArgsにも動的スクリプトパスを付与する', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('reasonix', { homedir: home });
    assert.ok(agent);
    assert.ok(agent.execArgs.includes('run'));
    // Review Manager用のexecArgsは作業ディレクトリを明示する（--dir {workspace}）
    assert.ok(agent.execArgs.includes('--dir'));

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

// ── validateNonInteractiveTokens（Issue #163） ─────────────────────────────────

test('validateNonInteractiveTokens: 全トークンを保持していれば valid', () => {
  const agent = { extraArgs: ['--print', '--verbose'], nonInteractiveTokens: ['--print'] };
  assert.deepEqual(validateNonInteractiveTokens(agent), { valid: true, missing: [] });
});

test('validateNonInteractiveTokens: トークン欠落を missing で報告する', () => {
  const agent = { extraArgs: ['--verbose'], nonInteractiveTokens: ['--print'] };
  const result = validateNonInteractiveTokens(agent);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['--print']);
});

test('validateNonInteractiveTokens: 複数トークンの一部欠落のみ報告する', () => {
  const agent = { extraArgs: ['run', '--dir', '/tmp'], nonInteractiveTokens: ['run', 'exec'] };
  const result = validateNonInteractiveTokens(agent);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['exec']);
});

test('validateNonInteractiveTokens: nonInteractiveTokens 未宣言のエージェントは常に valid（agy等）', () => {
  const agent = { extraArgs: ['--dangerously-skip-permissions'] };
  assert.deepEqual(validateNonInteractiveTokens(agent), { valid: true, missing: [] });
});

test('validateNonInteractiveTokens: agent が null でも例外を投げず valid', () => {
  assert.deepEqual(validateNonInteractiveTokens(null), { valid: true, missing: [] });
});

test('validateNonInteractiveTokens: extraArgs 未定義でも nonInteractiveTokens があれば欠落報告', () => {
  const agent = { nonInteractiveTokens: ['run'] };
  const result = validateNonInteractiveTokens(agent);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['run']);
});

test('resolveAgentConfig: claude-ds は extends 経由で nonInteractiveTokens: ["--print"] を継承する', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.deepEqual(agent.nonInteractiveTokens, ['--print']);
  });
});

test('resolveAgentConfig: codex-pro は extends 経由で nonInteractiveTokens: ["exec"] を継承する', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('codex-pro', { homedir: home });
    assert.deepEqual(agent.nonInteractiveTokens, ['exec']);
  });
});

test('resolveAgentConfig: reasonix は動的解決後も run トークンを保持し valid（Issue #163）', () => {
  withTempHome(home => {
    const agent = resolveAgentConfig('reasonix', { homedir: home });
    assert.ok(agent);
    assert.deepEqual(agent.nonInteractiveTokens, ['run']);
    // 動的解決で command=node の場合は先頭にスクリプトパスが付与されるが、run は残る
    assert.equal(validateNonInteractiveTokens(agent).valid, true);
  });
});

test('resolveAgentConfig: config.json で extraArgs から --print を欠落させると validateNonInteractiveTokens が検出する', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'claude-ds': { extraArgs: ['--dangerously-skip-permissions'] },
      },
    });
    const agent = resolveAgentConfig('claude-ds', { homedir: home });
    assert.ok(agent);
    // extraArgs は上書きで配列ごと置換されるが、nonInteractiveTokens は
    // デフォルト（claude からの継承）のまま残る → 欠落を機械的に検出できる
    assert.deepEqual(agent.nonInteractiveTokens, ['--print']);
    assert.equal(agent.extraArgs.includes('--print'), false);
    const result = validateNonInteractiveTokens(agent);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ['--print']);
  });
});

test('validateNonInteractiveTokens: argsArray 指定で execArgs を検証できる（execArgs 経由の起動漏れ, Issue #163 BLOCKER）', () => {
  const agent = {
    extraArgs: ['exec', '--skip-git-repo-check'],
    execArgs: ['--skip-git-repo-check'], // exec を欠落
    nonInteractiveTokens: ['exec'],
  };
  // extraArgs は保持している → 省略時（extraArgs 検証）では valid
  assert.equal(validateNonInteractiveTokens(agent).valid, true);
  // Review Manager 系起動は execArgs ?? extraArgs を使うため、execArgs を渡すと
  // 欠落を検出できる（修正前はこのケースが素通りしていた）
  const result = validateNonInteractiveTokens(agent, agent.execArgs);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['exec']);
});

test('validateNonInteractiveTokens: argsArray が execArgs ?? extraArgs なら RM 起動経路の実態を検証できる', () => {
  const agent = {
    extraArgs: ['exec', '--skip-git-repo-check'],
    nonInteractiveTokens: ['exec'],
  };
  // execArgs 未定義 → RM は extraArgs にフォールバック → extraArgs が保持していれば valid
  assert.equal(validateNonInteractiveTokens(agent, agent.execArgs ?? agent.extraArgs).valid, true);
});

test('validateNonInteractiveTokens: argsArray が null の場合は欠落として扱う（フェイルクローズ）', () => {
  const agent = { extraArgs: ['--print'], nonInteractiveTokens: ['--print'] };
  const result = validateNonInteractiveTokens(agent, null);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['--print']);
});

test('resolveAgentConfig: workspace config は nonInteractiveTokens を上書きできない（セキュリティ, Issue #163 Review Manager指摘）', () => {
  withTempHome(home => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-ws-nonint-'));
    try {
      writeWorkspaceConfig(ws, {
        agents: { codex: { nonInteractiveTokens: [] } },
      });

      const agent = resolveAgentConfig('codex', { homedir: home, workspace: ws });
      assert.ok(agent);
      // workspace による nonInteractiveTokens: [] の上書きは EXEC_SENSITIVE_FIELDS で
      // 除去される → デフォルトの ['exec'] が残り、安全ガードは無効化できない
      assert.deepEqual(agent.nonInteractiveTokens, ['exec']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

