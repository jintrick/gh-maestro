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

test('plugin manifest hooks: orchestratorの通知用 Stop hook だけを固定引数で登録する', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.deepEqual(Object.keys(manifest.hooks), ['Stop']);
  const groups = manifest.hooks.Stop;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, undefined);
  assert.equal(groups[0].hooks.length, 1);
  const entry = groups[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-stop-hook.js']);
  assert.equal(entry.async, true);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'orchestrator-stop-hook.js')));
});
