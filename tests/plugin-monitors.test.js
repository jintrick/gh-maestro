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
