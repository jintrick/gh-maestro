'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentCommandArgs } = require('../scripts/agent-launch');

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
