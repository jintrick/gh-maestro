'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { buildSyncedClaudeMd, BEGIN, END } = require('../scripts/sync-agents-md');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'sync-agents-md.js');

function withProject(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-sync-agents-test-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runScript(cwd) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
}

// ── buildSyncedClaudeMd ────────────────────────────────────────────────────────

test('buildSyncedClaudeMd: マーカー間をAGENTS.mdの内容で置き換える', () => {
  const claude = `# CLAUDE\n\n${BEGIN}\nold content\n${END}\n\nfooter`;
  const result = buildSyncedClaudeMd(claude, 'new agents content');
  assert.ok(result.includes('new agents content'));
  assert.ok(!result.includes('old content'));
  assert.ok(result.includes('footer'));
});

test('buildSyncedClaudeMd: マーカーがなければエラーを投げる', () => {
  assert.throws(() => buildSyncedClaudeMd('# CLAUDE\n\nno markers here', 'agents'), /マーカー/);
});

// ── syncAgentsMd (integration) ─────────────────────────────────────────────────

test('syncAgentsMd: AGENTS.md を CLAUDE.md のマーカー間に同期する', () => {
  withProject(base => {
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide\n\nsome rule');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'),
      `# CLAUDE\n\n${BEGIN}\n${END}\n\nfooter`);

    const r = runScript(base);
    assert.equal(r.status, 0, r.stderr);

    const out = fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf8');
    assert.ok(out.includes('some rule'));
  });
});

test('syncAgentsMd: AGENTS.md がなければエラー終了する', () => {
  withProject(base => {
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), `# CLAUDE\n\n${BEGIN}\n${END}`);
    const r = runScript(base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AGENTS\.md/);
  });
});

test('syncAgentsMd: CLAUDE.md がなければエラー終了する', () => {
  withProject(base => {
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide');
    const r = runScript(base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CLAUDE\.md/);
  });
});

test('syncAgentsMd: マーカーがなければエラー終了する', () => {
  withProject(base => {
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), '# CLAUDE\n\nno markers');
    const r = runScript(base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /マーカー/);
  });
});
