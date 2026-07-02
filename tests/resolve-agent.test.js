'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveAgentConfig } = require('../scripts/resolve-agent');

function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-resolve-agent-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn(dir);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveAgentConfig: agents.jsonから一致するエージェントを返す', () => {
  withHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'agents.json'),
      JSON.stringify([{ id: 'reasonix', enterSequence: '\n' }, { id: 'agy', enterSequence: '\r\n' }]),
      'utf8'
    );
    const r = resolveAgentConfig('reasonix');
    assert.equal(r.enterSequence, '\n');
  });
});

test('resolveAgentConfig: agentIdがnullなら null を返す', () => {
  withHome(() => {
    assert.equal(resolveAgentConfig(null), null);
  });
});

test('resolveAgentConfig: agents.jsonが存在しなければ null を返す', () => {
  withHome(() => {
    assert.equal(resolveAgentConfig('agy'), null);
  });
});

test('resolveAgentConfig: 該当エージェントが見つからなければ null を返す', () => {
  withHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'agents.json'), JSON.stringify([{ id: 'agy' }]), 'utf8');
    assert.equal(resolveAgentConfig('unknown-agent'), null);
  });
});

test('resolveAgentConfig: agents.jsonのパース失敗時は例外を投げず null を返す', () => {
  withHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'agents.json'), '{ not valid json', 'utf8');
    assert.equal(resolveAgentConfig('agy'), null);
  });
});
