'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  statusPanePath,
  statusPaneRecoveryPath,
  loadStatusPane,
  saveStatusPane,
  saveStatusPaneRecovery,
  removeStatusPaneRecovery,
  removeStatusPane,
} = require('../scripts/shared/status-pane-registry');
const storageLayout = require('../scripts/shared/storage-layout');

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

test('loadStatusPane: 壊れたJSONは警告して不在として扱う（相方なし）', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json', 'utf8');
    const warnings = [];
    assert.equal(loadStatusPane(dir, (message) => warnings.push(message)), null);
    assert.match(warnings.join('\n'), /JSON構文エラー/);
    assert.match(warnings.join('\n'), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('loadStatusPane: 配列やpaneId欠落オブジェクトは警告して不在として扱う（相方なし）', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '[1,2,3]', 'utf8');
    const warnings = [];
    assert.equal(loadStatusPane(dir, (message) => warnings.push(message)), null);
    assert.match(warnings.join('\n'), /JSONとしては妥当だがオブジェクトでない/);

    fs.writeFileSync(p, '{"foo":"bar"}', 'utf8');
    assert.equal(loadStatusPane(dir, (message) => warnings.push(message)), null);
    assert.match(warnings.join('\n'), /型不正（paneId がありません）/);

    fs.writeFileSync(p, '{"paneId":""}', 'utf8');
    assert.equal(loadStatusPane(dir, (message) => warnings.push(message)), null);
    assert.match(warnings.join('\n'), /型不正（paneId がありません）/);
  });
});

test('loadStatusPane: primaryだけが壊れていればrecoveryを警告付きで使う', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json', 'utf8');
    saveStatusPaneRecovery(dir, { paneId: 'recovery-42', launchedAt: '2026-08-26T09:00:00.000Z' });

    const warnings = [];
    assert.deepEqual(loadStatusPane(dir, (message) => warnings.push(message)), {
      paneId: 'recovery-42',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    assert.match(warnings.join('\n'), /JSON構文エラー/);
    assert.match(warnings.join('\n'), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('loadStatusPane: recoveryだけが壊れていればprimaryを警告付きで使う', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, { paneId: 'primary-42', launchedAt: '2026-08-26T09:00:00.000Z' });
    const p = statusPaneRecoveryPath(dir);
    fs.writeFileSync(p, '{not json', 'utf8');

    const warnings = [];
    assert.deepEqual(loadStatusPane(dir, (message) => warnings.push(message)), {
      paneId: 'primary-42',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    assert.match(warnings.join('\n'), /JSON構文エラー/);
    assert.match(warnings.join('\n'), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('loadStatusPane: primaryとrecoveryの両方が壊れていれば両方のパス付きでthrow', () => {
  withTempWorkspace((dir) => {
    const primary = statusPanePath(dir);
    const recovery = statusPaneRecoveryPath(dir);
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, '{not json', 'utf8');
    fs.writeFileSync(recovery, '{also not json', 'utf8');

    const warnings = [];
    assert.throws(
      () => loadStatusPane(dir, (message) => warnings.push(message)),
      (error) => {
        assert.match(error.message, /両方のファイルが判定不能/);
        assert.match(error.message, new RegExp(primary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, new RegExp(recovery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, /JSON構文エラー/);
        return true;
      },
    );
    assert.equal(warnings.length, 2);
  });
});

test('loadStatusPane: 読み取り失敗は片側なら警告してnullを返す', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(p, { recursive: true });
    const warnings = [];
    assert.equal(loadStatusPane(dir, (message) => warnings.push(message)), null);
    assert.match(warnings.join('\n'), /読み取り失敗/);
    assert.match(warnings.join('\n'), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('saveStatusPane / loadStatusPane: 登録した内容を取得できる（ディレクトリ自動作成）', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, {
      paneId: '42',
      issue: 471,
      pid: 12345,
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    assert.deepEqual(loadStatusPane(dir), {
      paneId: '42',
      issue: '471',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    const record = JSON.parse(fs.readFileSync(statusPanePath(dir), 'utf8'));
    assert.equal(Object.hasOwn(record, 'pid'), false);
  });
});

test('loadStatusPane: 旧形式のpidを読み込まずpane情報だけ返す', () => {
  withTempWorkspace((dir) => {
    const p = statusPanePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      paneId: 'legacy-pane',
      issue: '471',
      pid: 12345,
      launchedAt: '2026-08-26T09:00:00.000Z',
    }), 'utf8');

    assert.deepEqual(loadStatusPane(dir), {
      paneId: 'legacy-pane',
      issue: '471',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
  });
});

test('status-pane保存: テスト実行中はruntimeディレクトリを作成してもworkspace registryへ登録しない', () => {
  assert.equal(storageLayout.isNodeTestContext(), true, '前提: Node test runnerのコンテキストで実行されている');
  for (const [label, save] of [
    ['通常記録', saveStatusPane],
    ['回復記録', saveStatusPaneRecovery],
  ]) {
    withTempWorkspace((dir) => {
      save(dir, { paneId: label });
      const runtimeDir = storageLayout.workspaceRuntimeDir(dir);
      assert.ok(fs.existsSync(runtimeDir), `${label}: runtimeディレクトリは作成される`);
      assert.ok(!fs.existsSync(path.join(runtimeDir, 'workspace.json')), `${label}: registry manifestは作成されない`);
      assert.equal(
        storageLayout.listRegisteredWorkspaces().includes(storageLayout.canonicalWorkspace(dir)),
        false,
        `${label}: workspace registryへ追加されない`,
      );
    });
  }
});

test('saveStatusPaneRecovery / loadStatusPane: 通常記録がなくても回復記録を読み込める', () => {
  withTempWorkspace((dir) => {
    saveStatusPaneRecovery(dir, {
      paneId: 'recovery-42',
      pid: 12345,
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    assert.deepEqual(loadStatusPane(dir), {
      paneId: 'recovery-42',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    const record = JSON.parse(fs.readFileSync(statusPaneRecoveryPath(dir), 'utf8'));
    assert.equal(Object.hasOwn(record, 'pid'), false);
  });
});

test('loadStatusPane: 通常記録と回復記録があれば新しい方を返す', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, { paneId: 'primary-old', launchedAt: '2026-08-26T09:00:00.000Z' });
    saveStatusPaneRecovery(dir, { paneId: 'recovery-new', launchedAt: '2026-08-26T09:01:00.000Z' });
    assert.deepEqual(loadStatusPane(dir), {
      paneId: 'recovery-new',
      launchedAt: '2026-08-26T09:01:00.000Z',
    });

    saveStatusPane(dir, { paneId: 'primary-new', launchedAt: '2026-08-26T09:02:00.000Z' });
    assert.deepEqual(loadStatusPane(dir), {
      paneId: 'primary-new',
      launchedAt: '2026-08-26T09:02:00.000Z',
    });
    assert.equal(removeStatusPaneRecovery(dir), false);
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

test('removeStatusPane: 通常記録と回復記録をまとめて削除する', () => {
  withTempWorkspace((dir) => {
    saveStatusPane(dir, { paneId: 'primary' });
    saveStatusPaneRecovery(dir, { paneId: 'recovery' });
    assert.equal(removeStatusPane(dir), true);
    assert.equal(fs.existsSync(statusPanePath(dir)), false);
    assert.equal(fs.existsSync(statusPaneRecoveryPath(dir)), false);
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

