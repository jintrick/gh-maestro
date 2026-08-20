'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sl = require('../scripts/shared/storage-layout');

const IS_WIN = process.platform === 'win32';

// ── テスト用の一時ディレクトリ ─────────────────────────────────────────
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-storage-layout-'));

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// managedRoot
// ═══════════════════════════════════════════════════════════════════════════

test('managedRoot: os.homedir() 配下の .gh-maestro を返す', () => {
  assert.equal(sl.managedRoot(), path.join(os.homedir(), '.gh-maestro'));
});

test('managedRoot: ホームディレクトリの変更を反映する（副作用なしの純粋関数）', () => {
  const envKey = IS_WIN ? 'USERPROFILE' : 'HOME';
  const fakeHome = path.join(tmpBase, 'fake-home');
  withEnv({ [envKey]: fakeHome }, () => {
    assert.equal(sl.managedRoot(), path.join(fakeHome, '.gh-maestro'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runtimeRoot
// ═══════════════════════════════════════════════════════════════════════════

test('runtimeRoot: GH_MAESTRO_RUNTIME_DIR が最優先される（OS非依存）', () => {
  const override = path.join(tmpBase, 'explicit-runtime-dir');
  withEnv({ GH_MAESTRO_RUNTIME_DIR: override }, () => {
    assert.equal(sl.runtimeRoot(), path.resolve(override));
  });
});

if (IS_WIN) {
  test('runtimeRoot (Windows): LOCALAPPDATA 配下の gh-maestro/runtime-v1', () => {
    const fakeLocalAppData = path.join(tmpBase, 'fake-lad');
    withEnv({ GH_MAESTRO_RUNTIME_DIR: undefined, LOCALAPPDATA: fakeLocalAppData }, () => {
      assert.equal(sl.runtimeRoot(), path.join(fakeLocalAppData, 'gh-maestro', 'runtime-v1'));
    });
  });

  test('runtimeRoot (Windows): LOCALAPPDATA 未設定時は homedir/AppData/Local にフォールバック', () => {
    withEnv({ GH_MAESTRO_RUNTIME_DIR: undefined, LOCALAPPDATA: undefined }, () => {
      assert.equal(
        sl.runtimeRoot(),
        path.join(os.homedir(), 'AppData', 'Local', 'gh-maestro', 'runtime-v1')
      );
    });
  });
} else {
  test('runtimeRoot (Linux): XDG_STATE_HOME 配下の gh-maestro/runtime-v1', () => {
    const fakeStateHome = path.join(tmpBase, 'fake-xdg-state');
    withEnv({ GH_MAESTRO_RUNTIME_DIR: undefined, XDG_STATE_HOME: fakeStateHome }, () => {
      assert.equal(sl.runtimeRoot(), path.join(fakeStateHome, 'gh-maestro', 'runtime-v1'));
    });
  });

  test('runtimeRoot (Linux): XDG_STATE_HOME 未設定時は $HOME/.local/state にフォールバック', () => {
    withEnv({ GH_MAESTRO_RUNTIME_DIR: undefined, XDG_STATE_HOME: undefined }, () => {
      assert.equal(
        sl.runtimeRoot(),
        path.join(os.homedir(), '.local', 'state', 'gh-maestro', 'runtime-v1')
      );
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// canonicalWorkspace / workspaceKey
// ═══════════════════════════════════════════════════════════════════════════

test('canonicalWorkspace: 存在しないパスは resolve のみ行う（realpath失敗時のフォールバック）', () => {
  const nonexistent = path.join(tmpBase, 'does-not-exist-xyz');
  const expected = IS_WIN ? path.resolve(nonexistent).toLowerCase() : path.resolve(nonexistent);
  assert.equal(sl.canonicalWorkspace(nonexistent), expected);
});

test('canonicalWorkspace: 実在するディレクトリは realpath される', () => {
  const real = fs.mkdtempSync(path.join(tmpBase, 'real-'));
  const expected = IS_WIN ? fs.realpathSync(real).toLowerCase() : fs.realpathSync(real);
  assert.equal(sl.canonicalWorkspace(real), expected);
});

if (IS_WIN) {
  test('canonicalWorkspace (Windows): 大小文字の差異を吸収する', () => {
    const real = fs.mkdtempSync(path.join(tmpBase, 'CaseTest-'));
    const upper = real.toUpperCase();
    const lower = real.toLowerCase();
    assert.equal(sl.canonicalWorkspace(upper), sl.canonicalWorkspace(lower));
  });
}

test('workspaceKey: 同一workspaceは同一キーを返す', () => {
  const real = fs.mkdtempSync(path.join(tmpBase, 'key-'));
  assert.equal(sl.workspaceKey(real), sl.workspaceKey(real));
});

test('workspaceKey: 異なるworkspaceは異なるキーを返す', () => {
  const a = fs.mkdtempSync(path.join(tmpBase, 'key-a-'));
  const b = fs.mkdtempSync(path.join(tmpBase, 'key-b-'));
  assert.notEqual(sl.workspaceKey(a), sl.workspaceKey(b));
});

test('workspaceKey: 64桁のhex文字列（SHA-256）を返す', () => {
  const real = fs.mkdtempSync(path.join(tmpBase, 'key-hex-'));
  const key = sl.workspaceKey(real);
  assert.match(key, /^[0-9a-f]{64}$/);
});

if (IS_WIN) {
  test('workspaceKey (Windows): 大小文字違いでも同一キーになる', () => {
    const real = fs.mkdtempSync(path.join(tmpBase, 'KeyCase-'));
    assert.equal(sl.workspaceKey(real.toUpperCase()), sl.workspaceKey(real.toLowerCase()));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// workspaceRuntimeDir / ensureWorkspaceRuntimeDir
// ═══════════════════════════════════════════════════════════════════════════

test('workspaceRuntimeDir: runtimeRoot()/workspaces/<key> を返す（副作用なし）', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(tmpBase, 'wrd-runtime') }, () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, 'wrd-ws-'));
    const expected = path.join(sl.runtimeRoot(), 'workspaces', sl.workspaceKey(workspace));
    assert.equal(sl.workspaceRuntimeDir(workspace), expected);
    assert.ok(!fs.existsSync(expected), 'workspaceRuntimeDir は副作用を持たない純粋関数のはず');
  });
});

test('ensureWorkspaceRuntimeDir: ディレクトリと workspace.json を作成する', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(tmpBase, 'ewrd-runtime') }, () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, 'ewrd-ws-'));
    const dir = sl.ensureWorkspaceRuntimeDir(workspace);
    assert.ok(fs.existsSync(dir));

    const manifestPath = path.join(dir, 'workspace.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.canonicalPath, sl.canonicalWorkspace(workspace));
  });
});

test('ensureWorkspaceRuntimeDir: 既存の workspace.json を上書きしない（冪等）', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(tmpBase, 'ewrd2-runtime') }, () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, 'ewrd2-ws-'));
    const dir = sl.ensureWorkspaceRuntimeDir(workspace);
    const manifestPath = path.join(dir, 'workspace.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, canonicalPath: 'sentinel' }));

    sl.ensureWorkspaceRuntimeDir(workspace);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.canonicalPath, 'sentinel', '既存ファイルは上書きされないはず');
  });
});

test('listRegisteredWorkspaces: runtime rootに登録された全workspaceを返す', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(tmpBase, 'list-runtime') }, () => {
    const workspaces = [
      fs.mkdtempSync(path.join(tmpBase, 'registered-a-')),
      fs.mkdtempSync(path.join(tmpBase, 'registered-b-')),
    ];
    for (const workspace of workspaces) sl.ensureWorkspaceRuntimeDir(workspace);

    assert.deepEqual(
      sl.listRegisteredWorkspaces().sort(),
      workspaces.map((workspace) => sl.canonicalWorkspace(workspace)).sort(),
    );
  });
});

test('listRegisteredWorkspaces: manifestの読取失敗を握りつぶさず停止する', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(tmpBase, 'invalid-manifest-runtime') }, () => {
    const runtimeWorkspaces = path.join(sl.runtimeRoot(), 'workspaces', 'broken');
    fs.mkdirSync(runtimeWorkspaces, { recursive: true });
    fs.writeFileSync(path.join(runtimeWorkspaces, 'workspace.json'), '{not-json', 'utf8');

    assert.throws(() => sl.listRegisteredWorkspaces(), /workspace registry を読み取れません/);
  });
});

test('listRegisteredWorkspaces: manifestのworkspaceKey不一致を拒否する', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(tmpBase, 'mismatched-key-runtime') }, () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, 'mismatched-key-'));
    const runtimeWorkspaces = path.join(sl.runtimeRoot(), 'workspaces', 'wrong-key');
    fs.mkdirSync(runtimeWorkspaces, { recursive: true });
    fs.writeFileSync(path.join(runtimeWorkspaces, 'workspace.json'), JSON.stringify({
      schemaVersion: 1,
      canonicalPath: sl.canonicalWorkspace(workspace),
    }), 'utf8');

    assert.throws(() => sl.listRegisteredWorkspaces(), /workspace registry のキーが一致しません/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// assertValidWorkspace（Issue #214 の根本原因ガード）
// ═══════════════════════════════════════════════════════════════════════════

test('assertValidWorkspace: 通常のworkspaceは throw しない', () => {
  const workspace = fs.mkdtempSync(path.join(tmpBase, 'valid-ws-'));
  assert.doesNotThrow(() => sl.assertValidWorkspace(workspace));
});

test('assertValidWorkspace: ホームディレクトリそのものは throw する', () => {
  assert.throws(() => sl.assertValidWorkspace(os.homedir()));
});

test('assertValidWorkspace: ホームディレクトリの別名（大小文字違い等）も throw する', () => {
  const home = os.homedir();
  const variant = IS_WIN ? home.toUpperCase() : home;
  assert.throws(() => sl.assertValidWorkspace(variant));
});

test('assertValidWorkspace: managed root 自体は throw する（managed root の子孫として検出）', () => {
  assert.throws(() => sl.assertValidWorkspace(sl.managedRoot()));
});

test('assertValidWorkspace: managed root の子ディレクトリも throw する', () => {
  assert.throws(() => sl.assertValidWorkspace(path.join(sl.managedRoot(), 'scripts')));
});

// ═══════════════════════════════════════════════════════════════════════════
// assertDisjointRoots
// ═══════════════════════════════════════════════════════════════════════════

test('assertDisjointRoots: デフォルト設定では throw しない', () => {
  assert.doesNotThrow(() => sl.assertDisjointRoots());
});

test('assertDisjointRoots: runtime root が managed root と一致する場合 throw する', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: sl.managedRoot() }, () => {
    assert.throws(() => sl.assertDisjointRoots());
  });
});

test('assertDisjointRoots: runtime root が managed root の子孫の場合 throw する', () => {
  withEnv({ GH_MAESTRO_RUNTIME_DIR: path.join(sl.managedRoot(), 'runtime') }, () => {
    assert.throws(() => sl.assertDisjointRoots());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGED_TOP_LEVEL
// ═══════════════════════════════════════════════════════════════════════════

test('MANAGED_TOP_LEVEL: install.js が管理する既知のトップレベル名のみを含む', () => {
  assert.deepEqual(
    [...sl.MANAGED_TOP_LEVEL].sort(),
    ['agents.json', 'config.json', 'scripts', 'skills']
  );
});
