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

test('resolveAgentConfig: _homedir 省略時は環境変数 HOME を参照する', () => {
  // _homedir 省略時に process.env.HOME から agents.json を解決することを
  // 明示的に検証する。一時ディレクトリに agents.json を用意し HOME を差し替える。
  // テストファイル内は直列実行のため save/restore で他テストに影響しない。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-env-home-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gh-maestro', 'agents.json'),
      JSON.stringify([{ id: 'env-agent', enterSequence: '\r\n' }]),
      'utf8'
    );
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    delete process.env.USERPROFILE;
    try {
      const r = resolveAgentConfig('env-agent');
      assert.ok(r, 'env-agent が見つかるべき');
      assert.equal(r.enterSequence, '\r\n');
    } finally {
      process.env.HOME = prevHome;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
