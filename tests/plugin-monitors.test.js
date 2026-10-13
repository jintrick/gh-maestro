'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..', 'plugin');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8'));
}

test('plugin manifest and monitors: fixed interactive session monitors have no dynamic arguments', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  const monitors = readJson('monitors/monitors.json');

  assert.equal(manifest.name, 'gh-maestro');
  assert.equal(typeof manifest.version, 'string');
  assert.ok(Array.isArray(monitors));
  assert.deepEqual(monitors.map((entry) => entry.name), [
    'gh-maestro-inbox',
    'gh-maestro-pr',
  ]);

  for (const entry of monitors) {
    assert.deepEqual(Object.keys(entry).sort(), ['command', 'description', 'name', 'when']);
    assert.equal(entry.when, 'on-skill-invoke:gh-maestro');
    assert.match(entry.command, /^node "/);
    assert.match(entry.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//);
    assert.match(entry.command, /\$\{CLAUDE_PROJECT_DIR\}/);
    assert.doesNotMatch(entry.command, /--issue(?:\s|=)/);
    assert.doesNotMatch(entry.command, /persistent|timeout|user_config/i);
  }
});

test('plugin manifest hooks: orchestratorの発言ごとの hook を固定引数で登録する', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  const scriptArg = '${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-turn-hook.js';
  const expected = {
    UserPromptExpansion: { mode: 'mark', matcher: '^gh-maestro$' },
    UserPromptSubmit: { mode: 'prompt' },
    Stop: { mode: 'stop', async: true },
  };
  assert.deepEqual(Object.keys(manifest.hooks).sort(), Object.keys(expected).sort());
  for (const [event, spec] of Object.entries(expected)) {
    const groups = manifest.hooks[event];
    assert.equal(groups.length, 1, event);
    assert.equal(groups[0].matcher, spec.matcher, event);
    assert.equal(groups[0].hooks.length, 1, event);
    const entry = groups[0].hooks[0];
    assert.equal(entry.type, 'command');
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, [scriptArg, spec.mode]);
    assert.equal(entry.async, spec.async, event);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'orchestrator-turn-hook.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'orchestrator-turn-reminder.md')));
});
