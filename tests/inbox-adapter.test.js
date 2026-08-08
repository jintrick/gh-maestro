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

// 能力宣言（asynchronousNotification / sessionResume）による戦略選択と、
// "monitor" 戦略の claude-adapter は撤去した。全エージェントが session-resume 方式で
// 固定されており、選択の余地が無い抽象だったため（保留#10/#11）。
const {
  createSessionResumeAdapter,
  buildSessionResumePrompt,
  STRATEGY_TYPE: SESSION_RESUME_STRATEGY_TYPE,
} = require('../scripts/shared/inbox-adapters/session-resume-adapter');

const {
  resolveAdapter,
} = require('../scripts/shared/inbox-adapters');

const {
  buildAgentResumeCommandArgs,
} = require('../scripts/agent-launch');

// ═══════════════════════════════════════════════════════════════════════════
// adapter-base: インターフェース検証
// ═══════════════════════════════════════════════════════════════════════════

test('validateAdapterMethods: 全欠落を検出する（null）', () => {
  const missing = validateAdapterMethods(null);
  assert.deepEqual(missing.sort(), [...ADAPTER_METHODS].sort());
});

test('validateAdapterMethods: 全欠落を検出する（非オブジェクト）', () => {
  const missing = validateAdapterMethods('not-an-adapter');
  assert.deepEqual(missing.sort(), [...ADAPTER_METHODS].sort());
});

test('createSessionResumeAdapter: start がコマンドと引数を返す（reasonix: positional 配送）', () => {
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
  assert.ok(result.args.includes('--print'));
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
  assert.ok(!result.args.includes('--dangerously-skip-permissions'), 'agy: should NOT include extraArgs (added by buildAgentResumeCommandArgs)');
});

test('createSessionResumeAdapter: resume が resumeCommand を正しく使う（codex）', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume();

  assert.equal(result.command, 'codex');
  // resume() は resumeCommand のみ返し、extraArgs（exec等）は buildAgentResumeCommandArgs が追加する
  assert.ok(result.args.includes('resume'), 'should include resume subcommand');
  assert.ok(result.args.includes('--last'), 'should include --last');
  assert.ok(!result.args.includes('exec'), 'should NOT include extraArgs subcommands');
});

test('createSessionResumeAdapter: resume で sessionRef を渡すと resumeCommand 末尾の --last/--continue を置き換える', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume('specific-session-id');

  assert.equal(result.command, 'codex');
  // resumeCommand ["resume", "--last"] の末尾 "--last" が sessionRef に置き換わる
  assert.ok(!result.args.includes('--last'), 'should not include --last when sessionRef replaces it');

  // resume サブコマンドと sessionRef の存在確認
  assert.ok(result.args.includes('resume'), 'should preserve resume subcommand');
  assert.ok(result.args.includes('specific-session-id'), 'should include sessionRef');
  assert.ok(!result.args.includes('exec'), 'should NOT include extraArgs subcommands');

  // 順序検証: resume → sessionRef の順であること
  const resumeIdx = result.args.indexOf('resume');
  const sessionIdx = result.args.indexOf('specific-session-id');
  assert.ok(resumeIdx >= 0 && sessionIdx > resumeIdx,
    `resume(${resumeIdx}) should come before sessionRef(${sessionIdx})`);
});

test('createSessionResumeAdapter: resume で sessionRef を渡すと resumeCommand 末尾の --continue を置き換える（agy: サブコマンドなし）', () => {
  const agent = getAgentMap().get('agy');
  const adapter = createSessionResumeAdapter(agent);
  const result = adapter.resume('specific-conversation-id');

  assert.equal(result.command, 'agy');
  assert.ok(!result.args.includes('--continue'), 'should not include --continue when sessionRef replaces it');
  assert.ok(result.args.includes('specific-conversation-id'), 'should include sessionRef');
  assert.ok(!result.args.includes('--dangerously-skip-permissions'), 'should NOT include extraArgs (added by buildAgentResumeCommandArgs)');
});

// ── resume + buildAgentResumeCommandArgs 結合（extraArgs重複防止の実証） ────

test('integrated: codex の resume→buildAgentResumeCommandArgs で extraArgs が1回のみ出現する', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const resumeResult = adapter.resume();
  const message = '新着指示を処理してください';

  const finalResult = buildAgentResumeCommandArgs(
    agent,
    resumeResult.args,
    { shortPrompt: message },
  );

  const argv = finalResult.argv;

  // codex の extraArgs: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]
  // resumeCommand: ["resume", "--last"]
  // 期待 argv: ["codex", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "resume", "--last", "新着指示を処理してください"]

  assert.equal(argv[0], 'codex', 'command should be first');

  // extraArgs が argv 内にそれぞれ1回だけ出現する
  const execCount = argv.filter(a => a === 'exec').length;
  const skipGitCount = argv.filter(a => a === '--skip-git-repo-check').length;
  const bypassCount = argv.filter(a => a === '--dangerously-bypass-approvals-and-sandbox').length;
  assert.equal(execCount, 1, 'exec should appear exactly once');
  assert.equal(skipGitCount, 1, '--skip-git-repo-check should appear exactly once');
  assert.equal(bypassCount, 1, '--dangerously-bypass-approvals-and-sandbox should appear exactly once');

  // resume 固有の引数（resumeCommand）も1回だけ
  const resumeCount = argv.filter(a => a === 'resume').length;
  const lastCount = argv.filter(a => a === '--last').length;
  assert.equal(resumeCount, 1, 'resume should appear exactly once');
  assert.equal(lastCount, 1, '--last should appear exactly once');

  // 末尾にメッセージがある
  assert.equal(argv[argv.length - 1], message, 'message should be last');

  // 順序検証: extraArgs → resumeArgs → message
  const execIdx = argv.indexOf('exec');
  const resumeIdx = argv.indexOf('resume');
  const msgIdx = argv.indexOf(message);
  assert.ok(execIdx < resumeIdx, 'exec(' + execIdx + ') should come before resume(' + resumeIdx + ')');
  assert.ok(resumeIdx < msgIdx, 'resume(' + resumeIdx + ') should come before message(' + msgIdx + ')');
});

test('integrated: codex の sessionRef 付き resume→buildAgentResumeCommandArgs でも extraArgs が1回のみ', () => {
  const agent = getAgentMap().get('codex');
  const adapter = createSessionResumeAdapter(agent);
  const resumeResult = adapter.resume('session-abc-123');
  const message = '続行指示';

  const finalResult = buildAgentResumeCommandArgs(
    agent,
    resumeResult.args,
    { shortPrompt: message },
  );

  const argv = finalResult.argv;

  // extraArgs が1回だけ
  const execCount = argv.filter(a => a === 'exec').length;
  assert.equal(execCount, 1, 'exec should appear exactly once');

  // sessionRef が含まれ、--last は置き換えられている
  assert.ok(argv.includes('session-abc-123'), 'should include sessionRef');
  assert.ok(!argv.includes('--last'), 'should not include --last');
  assert.equal(argv[argv.length - 1], message, 'message should be last');
});

test('integrated: agy の resume→buildAgentResumeCommandArgs で extraArgs が1回のみ出現する', () => {
  const agent = getAgentMap().get('agy');
  const adapter = createSessionResumeAdapter(agent);
  const resumeResult = adapter.resume();
  const message = '指示を処理';

  const finalResult = buildAgentResumeCommandArgs(
    agent,
    resumeResult.args,
    { shortPrompt: message },
  );

  const argv = finalResult.argv;

  // agy の extraArgs: ["--dangerously-skip-permissions", "--print-timeout", "30m0s"]
  const skipPermCount = argv.filter(a => a === '--dangerously-skip-permissions').length;
  assert.equal(skipPermCount, 1, '--dangerously-skip-permissions should appear exactly once');

  // resume 固有の引数（--continue）も1回だけ
  const continueCount = argv.filter(a => a === '--continue').length;
  assert.equal(continueCount, 1, '--continue should appear exactly once');

  // 末尾にメッセージ
  assert.equal(argv[argv.length - 1], message, 'message should be last');
});

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

test('resolveAdapter: session-resume 戦略の adapter.deliverMessage は session-resume タイプを返す', () => {
  for (const id of ['claude', 'claude-ds', 'claude-ds-pro', 'reasonix', 'agy', 'codex']) {
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

