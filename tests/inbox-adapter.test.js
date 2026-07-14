'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── 実データ ──────────────────────────────────────────────────────────────

const DEFAULTS_PATH = path.join(__dirname, '..', 'scripts', 'agent-defaults.json');
const realDefaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));

/** 実エージェントを id → config の Map で取得 */
function getAgentMap() {
  return new Map(realDefaults.agents.map(a => [a.id, a]));
}

// ── テスト対象 ────────────────────────────────────────────────────────────

const {
  ADAPTER_METHODS,
  validateAdapterMethods,
  isValidAdapter,
} = require('../scripts/shared/inbox-adapters/adapter-base');

const {
  createClaudeAdapter,
  buildInboxPollPrompt,
  STRATEGY_TYPE,
} = require('../scripts/shared/inbox-adapters/claude-adapter');

const {
  STRATEGY,
  selectStrategy,
} = require('../scripts/shared/inbox-adapters/strategy-selector');

const {
  createSessionResumeAdapter,
  buildSessionResumePrompt,
  STRATEGY_TYPE: SESSION_RESUME_STRATEGY_TYPE,
} = require('../scripts/shared/inbox-adapters/session-resume-adapter');

const {
  resolveAdapter,
} = require('../scripts/shared/inbox-adapters');

// ═══════════════════════════════════════════════════════════════════════════
// adapter-base: インターフェース検証
// ═══════════════════════════════════════════════════════════════════════════

test('ADAPTER_METHODS: 5つの必須メソッドが定義されている', () => {
  assert.deepEqual(ADAPTER_METHODS, [
    'getCapabilities',
    'start',
    'resume',
    'deliverMessage',
    'stop',
  ]);
});

test('validateAdapterMethods: 完全なAdapterは空配列を返す', () => {
  const adapter = {
    getCapabilities: () => ({}),
    start: () => ({}),
    resume: () => ({}),
    deliverMessage: () => ({}),
    stop: () => ({}),
  };
  const missing = validateAdapterMethods(adapter);
  assert.deepEqual(missing, []);
});

test('validateAdapterMethods: メソッド欠落を検出する', () => {
  const partial = {
    getCapabilities: () => ({}),
    start: () => ({}),
  };
  const missing = validateAdapterMethods(partial);
  assert.deepEqual(missing.sort(), ['resume', 'deliverMessage', 'stop'].sort());
});

test('validateAdapterMethods: 全欠落を検出する（null）', () => {
  const missing = validateAdapterMethods(null);
  assert.deepEqual(missing.sort(), [...ADAPTER_METHODS].sort());
});

test('validateAdapterMethods: 全欠落を検出する（非オブジェクト）', () => {
  const missing = validateAdapterMethods('not-an-adapter');
  assert.deepEqual(missing.sort(), [...ADAPTER_METHODS].sort());
});

test('isValidAdapter: 有効なAdapterはtrue', () => {
  const adapter = {
    getCapabilities: () => ({}),
    start: () => ({}),
    resume: () => ({}),
    deliverMessage: () => ({}),
    stop: () => ({}),
  };
  assert.equal(isValidAdapter(adapter), true);
});

test('isValidAdapter: 不完全なAdapterはfalse', () => {
  assert.equal(isValidAdapter({ getCapabilities: () => ({}) }), false);
  assert.equal(isValidAdapter(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// strategy-selector: 戦略選択ロジック
// ═══════════════════════════════════════════════════════════════════════════

test('STRATEGY: 定数が定義されている', () => {
  assert.equal(STRATEGY.MONITOR, 'monitor');
  assert.equal(STRATEGY.SESSION_RESUME, 'session-resume');
  assert.ok(Object.isFrozen(STRATEGY));
});

// ── 実データ: 6エージェント全員の戦略分類 ─────────────────────────────────

test('selectStrategy: 6エージェント全ての戦略が正しく選ばれる', () => {
  const agents = getAgentMap();

  // asynchronousNotification: true → monitor
  assert.equal(selectStrategy(agents.get('claude')), STRATEGY.MONITOR);
  assert.equal(selectStrategy(agents.get('claude-ds')), STRATEGY.MONITOR);
  assert.equal(selectStrategy(agents.get('claude-ds-pro')), STRATEGY.MONITOR);

  // asynchronousNotification: false, sessionResume: true → session-resume
  assert.equal(selectStrategy(agents.get('reasonix')), STRATEGY.SESSION_RESUME);
  assert.equal(selectStrategy(agents.get('agy')), STRATEGY.SESSION_RESUME);
  assert.equal(selectStrategy(agents.get('codex')), STRATEGY.SESSION_RESUME);
});

// ── 能力宣言が不完全な場合のエラー ────────────────────────────────────────

test('selectStrategy: asynchronousNotification が未宣言だとエラー', () => {
  assert.throws(
    () => selectStrategy({ id: 'test', sessionResume: true }),
    /asynchronousNotification/
  );
});

test('selectStrategy: sessionResume が未宣言だとエラー', () => {
  assert.throws(
    () => selectStrategy({ id: 'test', asynchronousNotification: false }),
    /sessionResume/
  );
});

test('selectStrategy: 両方未宣言だとエラー', () => {
  assert.throws(
    () => selectStrategy({ id: 'test' }),
    /asynchronousNotification/
  );
});

test('selectStrategy: 非オブジェクトだとエラー', () => {
  assert.throws(
    () => selectStrategy(null),
    /agentConfig.*オブジェクト/
  );
});

// ── 型不正 ────────────────────────────────────────────────────────────────

test('selectStrategy: asynchronousNotification が boolean でないとエラー', () => {
  assert.throws(
    () => selectStrategy({ id: 'test', asynchronousNotification: 'yes', sessionResume: true }),
    /asynchronousNotification.*boolean/
  );
});

test('selectStrategy: sessionResume が boolean でないとエラー', () => {
  assert.throws(
    () => selectStrategy({ id: 'test', asynchronousNotification: false, sessionResume: 'yes' }),
    /sessionResume.*boolean/
  );
});

// ── 両方 false → エラー ──────────────────────────────────────────────────

test('selectStrategy: 両方 false だと対応戦略なしエラー', () => {
  assert.throws(
    () => selectStrategy({ id: 'no-cap', asynchronousNotification: false, sessionResume: false }),
    /対応する.*配送戦略/
  );
});

// ── id なしのエラーメッセージ ─────────────────────────────────────────────

test('selectStrategy: id がないエージェントは (idなし) と表示される', () => {
  assert.throws(
    () => selectStrategy({ asynchronousNotification: false, sessionResume: false }),
    /\(idなし\)/
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// buildInboxPollPrompt: Monitor プロンプト生成（内部ヘルパー）
// ═══════════════════════════════════════════════════════════════════════════

test('buildInboxPollPrompt: 既定ではプレースホルダを含む', () => {
  const prompt = buildInboxPollPrompt();
  assert.ok(prompt.includes('Monitorツール'));
  assert.ok(prompt.includes('{{SCRIPTS_PATH}}'));
  assert.ok(prompt.includes('$WORKER_NAME'));
  assert.ok(prompt.includes('$ISSUE'));
  assert.ok(prompt.includes('$WORKSPACE'));
  assert.ok(prompt.includes('msg-poll.js'));
  assert.ok(prompt.includes('msg-read.js'));
  assert.ok(prompt.includes('msg-send.js'));
  assert.ok(prompt.includes('persistent: true'));
  assert.ok(prompt.includes('NEW_MESSAGE:<commentId>'));
});

test('buildInboxPollPrompt: パラメータを指定するとプレースホルダが置換される', () => {
  const prompt = buildInboxPollPrompt({
    scriptsPath: '/home/user/.gh-maestro/scripts',
    workerName: 'issue-5-test',
    issue: '5',
    workspace: '/home/user/work/repo',
  });

  assert.ok(!prompt.includes('{{SCRIPTS_PATH}}'));
  assert.ok(prompt.includes('/home/user/.gh-maestro/scripts'));
  assert.ok(prompt.includes('issue-5-test'));
  assert.ok(prompt.includes('--issue 5'));
  assert.ok(prompt.includes('/home/user/work/repo'));
});

// ═══════════════════════════════════════════════════════════════════════════
// createClaudeAdapter: Claude 用 Adapter
// ═══════════════════════════════════════════════════════════════════════════

test('createClaudeAdapter: agentConfig 必須', () => {
  assert.throws(() => createClaudeAdapter(null), /agentConfig is required/);
  assert.throws(() => createClaudeAdapter({}), /agentConfig.command is required/);
});

// ── getCapabilities ────────────────────────────────────────────────────────

test('createClaudeAdapter: getCapabilities が正しい能力を返す', () => {
  const agents = getAgentMap();

  for (const id of ['claude', 'claude-ds', 'claude-ds-pro']) {
    const agent = agents.get(id);
    const adapter = createClaudeAdapter(agent);
    const caps = adapter.getCapabilities();

    assert.equal(caps.asynchronousNotification, true, `${id}: asynchronousNotification`);
    assert.equal(caps.sessionResume, true, `${id}: sessionResume`);
  }
});

test('createClaudeAdapter: getCapabilities の返り値は Issue #132 の宣言と一致する', () => {
  const agents = getAgentMap();

  for (const id of ['reasonix', 'agy', 'codex']) {
    const agent = agents.get(id);
    const adapter = createClaudeAdapter(agent);
    const caps = adapter.getCapabilities();

    assert.equal(caps.asynchronousNotification, agent.asynchronousNotification,
      `${id}: asynchronousNotification`);
    assert.equal(caps.sessionResume, agent.sessionResume,
      `${id}: sessionResume`);
  }
});

// ── start ──────────────────────────────────────────────────────────────────

test('createClaudeAdapter: start がコマンドと引数を返す（system-prompt-file配送）', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  const result = adapter.start({
    skill: 'gh-maestro-coder',
    promptFile: '/tmp/prompt.md',
    systemPromptText: 'orchestratorです。',
    shortPrompt: 'short',
  });

  assert.equal(typeof result.command, 'string');
  assert.ok(Array.isArray(result.args));
  assert.equal(result.command, agent.command);
  assert.ok(result.args.includes('--append-system-prompt-file'));
  assert.ok(result.args.includes('--dangerously-skip-permissions'));
});

test('createClaudeAdapter: start は options 必須', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  assert.throws(() => adapter.start(null), /start options is required/);
});

// ── resume ─────────────────────────────────────────────────────────────────

test('createClaudeAdapter: resume が --continue を含むコマンドを返す（claude系）', () => {
  for (const id of ['claude', 'claude-ds', 'claude-ds-pro']) {
    const agent = getAgentMap().get(id);
    const adapter = createClaudeAdapter(agent);
    const result = adapter.resume();

    assert.equal(result.command, agent.command, `${id}: command`);
    assert.ok(result.args.includes('--continue'), `${id}: --continue`);
    assert.ok(result.args.includes('--dangerously-skip-permissions'),
      `${id}: --dangerously-skip-permissions`);
  }
});

test('createClaudeAdapter: resume が resumeCommand を正しく使う（codex）', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createClaudeAdapter(agent);
  const result = adapter.resume();

  assert.equal(result.command, 'codex');
  assert.ok(result.args.includes('exec'));
  assert.ok(result.args.includes('resume'));
  assert.ok(result.args.includes('--last'));
});

test('createClaudeAdapter: sessionResume=false で resume を呼ぶとエラー', () => {
  const adapter = createClaudeAdapter({
    id: 'test',
    command: 'test-cli',
    asynchronousNotification: false,
    sessionResume: false,
    extraArgs: [],
    resumeCommand: [],
  });
  assert.throws(
    () => adapter.resume(),
    /sessionResume に対応していない/
  );
});

test('createClaudeAdapter: sessionResume=true だが resumeCommand が空だとエラー', () => {
  const adapter = createClaudeAdapter({
    id: 'test',
    command: 'test-cli',
    asynchronousNotification: false,
    sessionResume: true,
    extraArgs: [],
    resumeCommand: [],
  });
  assert.throws(
    () => adapter.resume(),
    /resumeCommand が設定されていません/
  );
});

test('createClaudeAdapter: resume は id をエラーメッセージに含める', () => {
  const adapter = createClaudeAdapter({
    id: 'my-agent',
    command: 'my-cli',
    sessionResume: false,
    extraArgs: [],
    resumeCommand: [],
  });
  assert.throws(
    () => adapter.resume(),
    /"my-agent"/
  );
});

// ── deliverMessage ─────────────────────────────────────────────────────────

test('createClaudeAdapter: deliverMessage が monitor タイプの結果を返す', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  const result = adapter.deliverMessage({ from: 'orchestrator', body: '修正してください' });

  assert.equal(result.type, STRATEGY_TYPE);
  assert.equal(typeof result.prompt, 'string');
  assert.ok(result.prompt.includes('Monitorツール'));
  assert.ok(result.prompt.includes('修正してください'));
  assert.ok(result.prompt.includes('msg-poll.js'));
});

test('createClaudeAdapter: deliverMessage は message 必須', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  assert.throws(() => adapter.deliverMessage(null), /message is required/);
});

test('createClaudeAdapter: deliverMessage は body が空でもプロンプトを返す', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  const result = adapter.deliverMessage({ from: 'orchestrator', body: '' });

  assert.equal(result.type, STRATEGY_TYPE);
  assert.ok(result.prompt.includes('Monitorツール'));
  // body が空文字の場合はプロンプトのみ
  assert.ok(!result.prompt.includes('以下のメッセージを受信しました'));
});

test('createClaudeAdapter: deliverMessage に opts を渡すとプロンプトに反映される', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  const result = adapter.deliverMessage(
    { from: 'orchestrator', body: 'test' },
    {
      scriptsPath: '/custom/scripts',
      workerName: 'issue-99-fix',
      issue: '99',
      workspace: '/custom/workspace',
    }
  );

  assert.ok(result.prompt.includes('/custom/scripts'));
  assert.ok(result.prompt.includes('issue-99-fix'));
  assert.ok(result.prompt.includes('--issue 99'));
  assert.ok(result.prompt.includes('/custom/workspace'));
});

// ── stop ───────────────────────────────────────────────────────────────────

test('createClaudeAdapter: stop が exit アクションを返す', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);
  const result = adapter.stop();

  assert.equal(result.action, 'exit');
  assert.equal(typeof result.description, 'string');
});

// ── Adapter インターフェース準拠 ───────────────────────────────────────────

test('createClaudeAdapter: 全必須メソッドを実装している', () => {
  const agent = getAgentMap().get('claude');
  const adapter = createClaudeAdapter(agent);

  const missing = validateAdapterMethods(adapter);
  assert.deepEqual(missing, [], `欠落メソッド: ${missing.join(', ')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// createSessionResumeAdapter: セッション再開型エージェント用 Adapter
// ═══════════════════════════════════════════════════════════════════════════

test('createSessionResumeAdapter: agentConfig 必須', () => {
  assert.throws(() => createSessionResumeAdapter(null), /agentConfig is required/);
  assert.throws(() => createSessionResumeAdapter({}), /agentConfig.command is required/);
});

// ── getCapabilities ────────────────────────────────────────────────────────

test('createSessionResumeAdapter: getCapabilities が正しい能力を返す', () => {
  const agents = getAgentMap();

  for (const id of ['reasonix', 'agy', 'codex']) {
    const agent = agents.get(id);
    const adapter = createSessionResumeAdapter(agent);
    const caps = adapter.getCapabilities();

    assert.equal(caps.asynchronousNotification, false, `${id}: asynchronousNotification`);
    assert.equal(caps.sessionResume, true, `${id}: sessionResume`);
  }
});

// ── start ──────────────────────────────────────────────────────────────────

test('createSessionResumeAdapter: start がコマンドと引数を返す（reasonix: send-text-after-launch）', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.start({
    skill: 'gh-maestro-investigator',
    shortPrompt: '調査してください',
  });

  assert.equal(typeof result.command, 'string');
  assert.ok(Array.isArray(result.args));
  assert.equal(result.command, agent.command);
});

test('createSessionResumeAdapter: start がコマンドと引数を返す（agy: flag 配送）', () => {
  const agent = getAgentMap().get('agy');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.start({
    skill: 'gh-maestro-explorer',
    shortPrompt: '調査してください',
  });

  assert.equal(typeof result.command, 'string');
  assert.ok(Array.isArray(result.args));
  assert.equal(result.command, agent.command);
  assert.ok(result.args.includes('-i'));
  assert.ok(result.args.includes('--dangerously-skip-permissions'));
});

test('createSessionResumeAdapter: start がコマンドと引数を返す（codex: positional 配送）', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.start({
    skill: 'gh-maestro-reviewer',
    shortPrompt: 'review してください',
  });

  assert.equal(typeof result.command, 'string');
  assert.ok(Array.isArray(result.args));
  assert.equal(result.command, agent.command);
});

test('createSessionResumeAdapter: start は options 必須', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  assert.throws(() => adapter.start(null), /start options is required/);
});

// ── resume ─────────────────────────────────────────────────────────────────

test('createSessionResumeAdapter: resume が resumeCommand を含むコマンドを返す（reasonix）', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume();

  assert.equal(result.command, agent.command);
  assert.ok(result.args.includes('--continue'), 'reasonix: --continue');
});

test('createSessionResumeAdapter: resume が resumeCommand を含むコマンドを返す（agy）', () => {
  const agent = getAgentMap().get('agy');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume();

  assert.equal(result.command, agent.command);
  assert.ok(result.args.includes('--continue'), 'agy: --continue');
  assert.ok(result.args.includes('--dangerously-skip-permissions'), 'agy: --dangerously-skip-permissions');
});

test('createSessionResumeAdapter: resume が resumeCommand を正しく使う（codex）', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume();

  assert.equal(result.command, 'codex');
  assert.ok(result.args.includes('exec'));
  assert.ok(result.args.includes('resume'));
  assert.ok(result.args.includes('--last'));
});

test('createSessionResumeAdapter: resume で sessionRef を渡すと resumeCommand 末尾の --last/--continue を置き換える（サブコマンドは保持）', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume('specific-session-id');

  assert.equal(result.command, 'codex');
  // resumeCommand ["exec", "resume", "--last"] の末尾 "--last" が sessionRef に置き換わる
  // 前段の exec / resume サブコマンドは保持される
  assert.ok(!result.args.includes('--last'), 'should not include --last when sessionRef replaces it');
  assert.ok(result.args.includes('exec'), 'should preserve exec subcommand');
  assert.ok(result.args.includes('resume'), 'should preserve resume subcommand');
  assert.ok(result.args.includes('specific-session-id'), 'should include sessionRef');
});

test('createSessionResumeAdapter: resume で sessionRef を渡すと resumeCommand 末尾の --continue を置き換える（agy: サブコマンドなし）', () => {
  const agent = getAgentMap().get('agy');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume('specific-conversation-id');

  assert.equal(result.command, 'agy');
  assert.ok(!result.args.includes('--continue'), 'should not include --continue when sessionRef replaces it');
  assert.ok(result.args.includes('specific-conversation-id'), 'should include sessionRef');
  assert.ok(result.args.includes('--dangerously-skip-permissions'), 'should preserve extraArgs');
});

test('createSessionResumeAdapter: sessionResume=false で resume を呼ぶとエラー', () => {
  const adapter = createSessionResumeAdapter({
    id: 'test',
    command: 'test-cli',
    asynchronousNotification: false,
    sessionResume: false,
    extraArgs: [],
    resumeCommand: [],
  });
  assert.throws(
    () => adapter.resume(),
    /sessionResume に対応していない/
  );
});

test('createSessionResumeAdapter: sessionResume=true だが resumeCommand が空だとエラー', () => {
  const adapter = createSessionResumeAdapter({
    id: 'test',
    command: 'test-cli',
    asynchronousNotification: false,
    sessionResume: true,
    extraArgs: [],
    resumeCommand: [],
  });
  assert.throws(
    () => adapter.resume(),
    /resumeCommand が設定されていません/
  );
});

// ── deliverMessage ─────────────────────────────────────────────────────────

test('createSessionResumeAdapter: deliverMessage が session-resume タイプの結果を返す', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.deliverMessage({ from: 'orchestrator', body: '修正してください' });

  assert.equal(result.type, SESSION_RESUME_STRATEGY_TYPE);
  assert.equal(typeof result.prompt, 'string');
  assert.ok(result.prompt.includes('[gh-maestro inbox]'));
  assert.ok(result.prompt.includes('修正してください'));
  assert.ok(result.prompt.includes('msg-send.js'));
  // Monitor 関連の指示を含まない
  assert.ok(!result.prompt.includes('Monitorツール'));
  assert.ok(!result.prompt.includes('msg-poll.js'));
  assert.ok(!result.prompt.includes('msg-read.js'));
});

test('createSessionResumeAdapter: deliverMessage は message 必須', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  assert.throws(() => adapter.deliverMessage(null), /message is required/);
});

test('createSessionResumeAdapter: deliverMessage は body が空でもプロンプトを返す', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.deliverMessage({ from: 'orchestrator', body: '' });

  assert.equal(result.type, SESSION_RESUME_STRATEGY_TYPE);
  assert.ok(result.prompt.includes('[gh-maestro inbox]'));
  // body が空文字なので引用行は含まれない
  assert.ok(!result.prompt.includes('> '));
});

test('createSessionResumeAdapter: deliverMessage の各エージェントで動作する', () => {
  for (const id of ['reasonix', 'agy', 'codex']) {
    const agent = getAgentMap().get(id);
    const adapter = createSessionResumeAdapter(agent);
    const result = adapter.deliverMessage({ from: 'orchestrator', body: `${id}への指示` });

    assert.equal(result.type, SESSION_RESUME_STRATEGY_TYPE, `${id}: type`);
    assert.ok(result.prompt.includes(`${id}への指示`), `${id}: body included`);
  }
});

// ── stop ───────────────────────────────────────────────────────────────────

test('createSessionResumeAdapter: stop が exit アクションを返す', () => {
  const agent = getAgentMap().get('reasonix');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.stop();

  assert.equal(result.action, 'exit');
  assert.equal(typeof result.description, 'string');
});

// ── Adapter インターフェース準拠 ───────────────────────────────────────────

test('createSessionResumeAdapter: 全必須メソッドを実装している', () => {
  for (const id of ['reasonix', 'agy', 'codex']) {
    const agent = getAgentMap().get(id);
    const adapter = createSessionResumeAdapter(agent);

    const missing = validateAdapterMethods(adapter);
    assert.deepEqual(missing, [], `${id}: 欠落メソッド: ${missing.join(', ')}`);
  }
});

// ── buildSessionResumePrompt ───────────────────────────────────────────────

test('buildSessionResumePrompt: 基本的なプロンプトを生成する', () => {
  const prompt = buildSessionResumePrompt({ from: 'orchestrator', body: 'テスト指示' });

  assert.ok(prompt.includes('[gh-maestro inbox]'));
  assert.ok(prompt.includes('orchestrator'));
  assert.ok(prompt.includes('テスト指示'));
  assert.ok(prompt.includes('msg-send.js'));
  assert.ok(!prompt.includes('Monitorツール'));
  assert.ok(!prompt.includes('msg-poll.js'));
});

test('buildSessionResumePrompt: from が無い場合は unknown と表示', () => {
  const prompt = buildSessionResumePrompt({ body: 'test' });
  assert.ok(prompt.includes('(unknown)'));
});

test('buildSessionResumePrompt: body が空の場合は引用行を含まない', () => {
  const prompt = buildSessionResumePrompt({ from: 'test', body: '' });
  assert.ok(!prompt.includes('> '));
});

test('buildSessionResumePrompt: \\r\\n 改行が正しく処理される', () => {
  const prompt = buildSessionResumePrompt({ from: 'test', body: 'line1\r\nline2\r\nline3' });
  // 各行が > で引用されている
  const quotedLines = prompt.split('\n').filter(l => l.startsWith('> '));
  assert.equal(quotedLines.length, 3);
  assert.equal(quotedLines[0], '> line1');
  assert.equal(quotedLines[1], '> line2');
  assert.equal(quotedLines[2], '> line3');
});

// ═══════════════════════════════════════════════════════════════════════════
// index.js: resolveAdapter 統合
// ═══════════════════════════════════════════════════════════════════════════

test('resolveAdapter: claude系は ClaudeAdapter を返す', () => {
  for (const id of ['claude', 'claude-ds', 'claude-ds-pro']) {
    const agent = getAgentMap().get(id);
    const adapter = resolveAdapter(agent);

    // インターフェース準拠
    assert.equal(isValidAdapter(adapter), true, `${id}: isValidAdapter`);

    // getCapabilities が正しい
    const caps = adapter.getCapabilities();
    assert.equal(caps.asynchronousNotification, true, `${id}: caps.asyncNotification`);
    assert.equal(caps.sessionResume, true, `${id}: caps.sessionResume`);
  }
});

test('resolveAdapter: session-resume 戦略のエージェントは SessionResumeAdapter を返す', () => {
  for (const id of ['reasonix', 'agy', 'codex']) {
    const agent = getAgentMap().get(id);
    const adapter = resolveAdapter(agent);

    // インターフェース準拠
    assert.equal(isValidAdapter(adapter), true, `${id}: isValidAdapter`);

    // getCapabilities が正しい
    const caps = adapter.getCapabilities();
    assert.equal(caps.asynchronousNotification, false, `${id}: caps.asyncNotification`);
    assert.equal(caps.sessionResume, true, `${id}: caps.sessionResume`);
  }
});

test('resolveAdapter: session-resume 戦略の adapter.deliverMessage は session-resume タイプを返す', () => {
  for (const id of ['reasonix', 'agy', 'codex']) {
    const agent = getAgentMap().get(id);
    const adapter = resolveAdapter(agent);
    const result = adapter.deliverMessage({ from: 'orchestrator', body: 'テストメッセージ' });

    assert.equal(result.type, SESSION_RESUME_STRATEGY_TYPE, `${id}: type`);
    assert.equal(typeof result.prompt, 'string', `${id}: prompt is string`);
    // Monitor ツールの指示を含まないこと
    assert.ok(!result.prompt.includes('Monitorツール'), `${id}: should not include Monitor references`);
    assert.ok(!result.prompt.includes('msg-poll.js'), `${id}: should not include msg-poll.js`);
  }
});

test('resolveAdapter: 能力宣言が不完全だとエラー', () => {
  assert.throws(
    () => resolveAdapter({ id: 'bad', command: 'x', extraArgs: [] }),
    /asynchronousNotification/
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 既存動作に変更がないことの確認（新規追加のみであることの検証）
// ═══════════════════════════════════════════════════════════════════════════

test('agent-defaults.json: 全エージェントが selectStrategy で分類でき resolveAdapter で解決できる', () => {
  const agents = getAgentMap();
  const results = new Map();

  for (const [id, agent] of agents) {
    const strategy = selectStrategy(agent);
    results.set(id, strategy);
  }

  // 期待値（selectStrategy）
  assert.equal(results.get('claude'), STRATEGY.MONITOR);
  assert.equal(results.get('claude-ds'), STRATEGY.MONITOR);
  assert.equal(results.get('claude-ds-pro'), STRATEGY.MONITOR);
  assert.equal(results.get('reasonix'), STRATEGY.SESSION_RESUME);
  assert.equal(results.get('agy'), STRATEGY.SESSION_RESUME);
  assert.equal(results.get('codex'), STRATEGY.SESSION_RESUME);

  // resolveAdapter も全エージェントで成功すること
  for (const [id, agent] of agents) {
    const adapter = resolveAdapter(agent);
    assert.equal(isValidAdapter(adapter), true, `${id}: resolveAdapter returns valid adapter`);
  }
});
