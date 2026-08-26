'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  statusPanePath,
  loadStatusPane,
  saveStatusPane,
  removeStatusPane,
} = require('../scripts/shared/status-pane-registry');

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-status-pane-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadStatusPane: status-pane.jsonが無ければnull', () => {
  withTempWorkspace((dir) => {
    assert.equal(loadStatusPane(dir), null);
  });
});

test('loadStatusPane: 壊れたJSONはnullとして扱う', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json', 'utf8');
    assert.equal(loadStatusPane(dir), null);
  });
});

test('loadStatusPane: 配列やpaneId欠落オブジェクトはnullとして扱う', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '[1,2,3]', 'utf8');
    assert.equal(loadStatusPane(dir), null);

    fs.writeFileSync(p, '{"foo":"bar"}', 'utf8');
    assert.equal(loadStatusPane(dir), null);

    fs.writeFileSync(p, '{"paneId":""}', 'utf8');
    assert.equal(loadStatusPane(dir), null);
  });
});

test('saveStatusPane / loadStatusPane: 登録した内容を取得できる（ディレクトリ自動作成）', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, { paneId: '42', launchedAt: '2026-08-26T09:00:00.000Z' });
    assert.deepEqual(loadStatusPane(dir), {
      paneId: '42',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
  });
});

test('saveStatusPane: launchedAt省略時は現在時刻で補完される', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, { paneId: 100 });
    const loaded = loadStatusPane(dir);
    assert.equal(loaded.paneId, '100');
    assert.ok(loaded.launchedAt.length > 0);
  });
});

test('removeStatusPane: 存在するファイルを削除しtrueを返す', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, { paneId: '99' });
    const existed = removeStatusPane(dir);
    assert.equal(existed, true);
    assert.equal(loadStatusPane(dir), null);
  });
});

test('removeStatusPane: 存在しない場合はfalseを返す', () => {
  withTempWorkspace((dir) => {
    const existed = removeStatusPane(dir);
    assert.equal(existed, false);
  });
});

test('statusPanePath: storage-layout の workspaceRuntimeDir 配下に置かれ、不正なワークスペースは拒否する', () => {
  const storageLayout = require('../scripts/shared/storage-layout');
  withTempWorkspace((dir) => {
    const expected = path.join(storageLayout.workspaceRuntimeDir(dir), 'status-pane.json');
    assert.equal(statusPanePath(dir), expected);

    // ホームディレクトリ等の不正なワークスペースは throw
    assert.throws(() => statusPanePath(os.homedir()), /assertValidWorkspace/);
  });
});

