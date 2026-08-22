'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentCommandArgs, buildAgentResumeCommandArgs, RESUME_REPORTING_REMINDER } = require('../scripts/shared/agent-launch');

test('buildAgentCommandArgs: system-prompt-file delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'claude',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'system-prompt-file',
  }, {
    promptFile: 'C:/tmp/prompt.md',
    systemPromptText: 'start',
  });

  assert.deepEqual(args, [
    'claude',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file',
    'C:/tmp/prompt.md',
    'start',
  ]);
});

test('buildAgentCommandArgs: flag delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'agy',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'flag',
    promptFlag: '-i',
  }, {
    shortPrompt: 'start',
  });

  assert.deepEqual(args, ['agy', '--dangerously-skip-permissions', '-i', 'start']);
});

test('buildAgentCommandArgs: positional delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'codex',
    extraArgs: ['--no-alt-screen'],
    promptDelivery: 'positional',
  }, {
    shortPrompt: 'start',
  });

  assert.deepEqual(args, ['codex', '--no-alt-screen', 'start']);
});

test('buildAgentCommandArgs: send-text-after-launch delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'node',
    extraArgs: ['reasonix.js', '--yolo'],
    promptDelivery: 'send-text-after-launch',
  });

  assert.deepEqual(args, ['node', 'reasonix.js', '--yolo']);
});

test('buildAgentCommandArgs: unknown delivery fails clearly', () => {
  assert.throws(() => buildAgentCommandArgs({
    command: 'x',
    promptDelivery: 'unknown',
  }), /unknown promptDelivery/);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildAgentResumeCommandArgs
// ═══════════════════════════════════════════════════════════════════════════

test('buildAgentResumeCommandArgs: flag delivery（agy）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'agy',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'flag',
    promptFlag: '-i',
  }, ['--continue'], { shortPrompt: '新着メッセージです' });

  assert.deepEqual(argv, ['agy', '--dangerously-skip-permissions', '--continue', '-i', '新着メッセージです']);
  assert.equal(afterLaunchText, null);
});

test('buildAgentResumeCommandArgs: positional delivery（codex）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'codex',
    extraArgs: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    promptDelivery: 'positional',
  }, ['resume', '--last'], { shortPrompt: '新着メッセージです' });

  // 非対話トークン exec は extraArgs 由来の1回のみ。resumeCommand（resumeArgs）には含めない
  assert.deepEqual(argv, ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--last', '新着メッセージです']);
  assert.equal(afterLaunchText, null);
  assert.equal(argv.filter(a => a === 'exec').length, 1, 'exec should appear exactly once');
});

test('buildAgentResumeCommandArgs: send-text-after-launch delivery（reasonix）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'node',
    extraArgs: ['reasonix.js', '--yolo'],
    promptDelivery: 'send-text-after-launch',
  }, ['--continue'], { shortPrompt: '新着メッセージです' });

  assert.deepEqual(argv, ['node', 'reasonix.js', '--yolo', '--continue']);
  assert.equal(afterLaunchText, '新着メッセージです');
});

test('buildAgentResumeCommandArgs: system-prompt-file delivery（claude系。--continueはシステムプロンプトを復元しないため、resumeのたびに報告プロトコルのリマインダーを--append-system-promptで再注入する）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'claude-ds-pro',
    extraArgs: ['--dangerously-skip-permissions', '--print'],
    promptDelivery: 'system-prompt-file',
  }, ['--continue'], { shortPrompt: '新着メッセージです' });

  assert.deepEqual(argv, [
    'claude-ds-pro', '--dangerously-skip-permissions', '--print', '--continue',
    '--append-system-prompt', RESUME_REPORTING_REMINDER,
    '新着メッセージです',
  ]);
  assert.equal(afterLaunchText, null);
});

test('buildAgentResumeCommandArgs: リマインダーはmsg-send.jsの正確な呼び出し構文と位置引数禁止の警告を含む', () => {
  assert.match(RESUME_REPORTING_REMINDER, /msg-send\.js/);
  assert.match(RESUME_REPORTING_REMINDER, /--stdin/);
  assert.match(RESUME_REPORTING_REMINDER, /位置引数/);
});

test('buildAgentResumeCommandArgs: 未知のdeliveryはエラー', () => {
  assert.throws(() => buildAgentResumeCommandArgs({
    command: 'claude',
    promptDelivery: 'unknown',
  }, ['--continue'], { shortPrompt: 'x' }), /promptDelivery "unknown" に対応していません/);
});

test('buildAgentResumeCommandArgs: resumeArgsが配列でないとエラー', () => {
  assert.throws(() => buildAgentResumeCommandArgs({
    command: 'agy', promptDelivery: 'flag', promptFlag: '-i',
  }, null, { shortPrompt: 'x' }), /resumeArgs must be an array/);
});

test('buildAgentResumeCommandArgs: shortPrompt必須', () => {
  assert.throws(() => buildAgentResumeCommandArgs({
    command: 'agy', promptDelivery: 'flag', promptFlag: '-i',
  }, ['--continue'], {}), /shortPrompt is required/);
});
