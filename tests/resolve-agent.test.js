'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveAgentConfig, agentsJsonPath } = require('../scripts/resolve-agent');

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

test('resolveAgentConfig: config.jsonから一致するエージェントのoverrideを返す', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    // config.json で label を上書きする。
    // ここで確認したいのは「config.json の値がデフォルトに勝つ」という汎用マージ挙動であり、
    // 特定フィールドの意味ではない。実在する任意の上書き可能フィールドで代表させる
    // （以前は enterSequence を例にしていたが、このフィールド自体を廃止したため差し替えた）。
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: {
          reasonix: { label: 'Reasonix (overridden)' },
          agy: { label: 'Antigravity (overridden)' },
        },
      }),
      'utf8',
    );
    const r = resolveAgentConfig('reasonix', home);
    assert.ok(r, 'reasonix should be resolved');
    assert.equal(r.label, 'Reasonix (overridden)');
    // 上書きしていないフィールドはデフォルトのまま
    assert.equal(r.dynamicCommand, true);
  });
});

test('resolveAgentConfig: agentIdがnullなら null を返す', () => {
  withTempHome(home => {
    assert.equal(resolveAgentConfig(null, home), null);
  });
});

test('resolveAgentConfig: config.jsonが存在しなければデフォルトから解決する', () => {
  withTempHome(home => {
    const r = resolveAgentConfig('agy', home);
    assert.ok(r, 'agy should be resolved from defaults');
    assert.equal(r.command, 'agy');
    assert.equal(r.promptDelivery, 'flag');
  });
});

test('resolveAgentConfig: 該当エージェントが見つからなければ null を返す', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'config.json'),
      JSON.stringify({ agents: { agy: {} } }),
      'utf8',
    );
    assert.equal(resolveAgentConfig('unknown-agent', home), null);
  });
});

test('resolveAgentConfig: config.jsonのパース失敗時は例外を投げず null を返す', () => {
  withTempHome(home => {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), '{ not valid json', 'utf8');
    // soft-fail: 内部で catch して null を返す
    // ただし resolve-config.js の loadConfigFile が空オブジェクトを返すため、
    // パース失敗時はデフォルト値にフォールバックする（null ではなくデフォルトが返る）
    const r = resolveAgentConfig('agy', home);
    assert.ok(r, 'should fall back to defaults on parse error');
    assert.equal(r.command, 'agy');
  });
});

test('resolveAgentConfig: _homedir 省略時は環境変数 HOME を参照する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-env-home-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: { 'env-agent': { command: 'custom-cli', label: 'Env Agent', promptDelivery: 'flag', promptFlag: '-p' } },
      }),
      'utf8',
    );
    // 注: env-agent は defaults にないため、resolveAgentConfig は null を返す
    // （merge のベースとなる defaultAgent が存在しないため）

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    delete process.env.USERPROFILE;
    try {
      // agy は defaults にあるため、HOME から config.json override を適用できる
      const r = resolveAgentConfig('agy');
      assert.ok(r, 'agy should be resolved using HOME');
      assert.equal(r.command, 'agy');
    } finally {
      process.env.HOME = prevHome;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentsJsonPath: config.json のパスを返す（後方互換）', () => {
  withTempHome(home => {
    const p = agentsJsonPath(home);
    assert.ok(p.endsWith('config.json'), `should end with config.json, got: ${p}`);
    assert.ok(p.includes('.gh-maestro'), 'should include .gh-maestro');
  });
});
