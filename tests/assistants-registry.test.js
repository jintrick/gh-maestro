'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assistantsPath,
  loadAssistants,
  getAssistant,
  setAssistant,
  removeAssistant,
} = require('../scripts/shared/assistants-registry');

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-assistants-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadAssistants: assistants.jsonが無ければ空オブジェクト', () => {
  withTempWorkspace((dir) => {
    assert.deepEqual(loadAssistants(dir), {});
  });
});

test('loadAssistants: 壊れたJSONは空オブジェクトとして扱う', () => {
  withTempWorkspace((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(assistantsPath(dir), '{not json', 'utf8');
    assert.deepEqual(loadAssistants(dir), {});
  });
});

test('loadAssistants: 配列（オブジェクトでない）は空オブジェクトとして扱う', () => {
  withTempWorkspace((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(assistantsPath(dir), '[1,2,3]', 'utf8');
    assert.deepEqual(loadAssistants(dir), {});
  });
});

test('setAssistant/getAssistant: 登録した内容を取得できる（.gh-maestro/ディレクトリが無くても作成される）', () => {
  withTempWorkspace((dir) => {
    setAssistant(dir, 5, { paneId: '42', launchedAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(getAssistant(dir, 5), { paneId: '42', launchedAt: '2026-01-01T00:00:00.000Z' });
    // 数値/文字列どちらのissueでも同じエントリを引ける
    assert.deepEqual(getAssistant(dir, '5'), { paneId: '42', launchedAt: '2026-01-01T00:00:00.000Z' });
  });
});

test('getAssistant: 登録が無ければnull', () => {
  withTempWorkspace((dir) => {
    assert.equal(getAssistant(dir, 999), null);
  });
});

test('removeAssistant: 存在するエントリを削除しtrueを返す', () => {
  withTempWorkspace((dir) => {
    setAssistant(dir, 7, { paneId: '1', launchedAt: 'x' });
    const existed = removeAssistant(dir, 7);
    assert.equal(existed, true);
    assert.equal(getAssistant(dir, 7), null);
  });
});

test('removeAssistant: 存在しないエントリはfalseを返し他のエントリを壊さない', () => {
  withTempWorkspace((dir) => {
    setAssistant(dir, 1, { paneId: 'a', launchedAt: 'x' });
    const existed = removeAssistant(dir, 999);
    assert.equal(existed, false);
    assert.deepEqual(getAssistant(dir, 1), { paneId: 'a', launchedAt: 'x' });
  });
});
