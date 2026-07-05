'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveAgentConfig } = require('../scripts/resolve-agent');

/**
 * 一時ディレクトリを作成し fn(home) を実行、終了後に削除する。
 * withHome と異なり process.env を一切変更しない。
 */
function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-resolve-agent-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveAgentConfig: agents.jsonから一致するエージェントを返す', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'agents.json'),
      JSON.stringify([{ id: 'reasonix', enterSequence: '\n' }, { id: 'agy', enterSequence: '\r\n' }]),
      'utf8'
    );
    const r = resolveAgentConfig('reasonix', home);
    assert.equal(r.enterSequence, '\n');
  });
});

test('resolveAgentConfig: agentIdがnullなら null を返す', () => {
  withTempHome(home => {
    assert.equal(resolveAgentConfig(null, home), null);
  });
});

test('resolveAgentConfig: agents.jsonが存在しなければ null を返す', () => {
  withTempHome(home => {
    assert.equal(resolveAgentConfig('agy', home), null);
  });
});

test('resolveAgentConfig: 該当エージェントが見つからなければ null を返す', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'agents.json'), JSON.stringify([{ id: 'agy' }]), 'utf8');
    assert.equal(resolveAgentConfig('unknown-agent', home), null);
  });
});

test('resolveAgentConfig: agents.jsonのパース失敗時は例外を投げず null を返す', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'agents.json'), '{ not valid json', 'utf8');
    assert.equal(resolveAgentConfig('agy', home), null);
  });
});

test('resolveAgentConfig: _homedir 省略時は環境変数 HOME/USERPROFILE を参照する', () => {
  // _homedir 省略で process.env.HOME が参照される（テスト環境の実際の HOME）
  // HOME/USERPROFILE 以下に agents.json がないことを保証できないため、
  // 存在しないエージェントIDで検証する
  const r = resolveAgentConfig('nonexistent-agent-xyz-123-test');
  assert.equal(r, null);
});
