'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  STATUS,
  formatStatusLine,
  inspectNodeModulesStatus,
} = require('../scripts/shared/node-modules-status');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

function fixture() {
  const scope = createTempDirScope();
  return {
    workspace: scope.mkdtemp('ghm-node-modules-status-'),
    cleanup: () => scope.cleanup(),
  };
}

function writeLock(workspace, version = '1.0.0') {
  fs.writeFileSync(path.join(workspace, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/example': { version },
    },
  }), 'utf8');
}

function writeInstalled(workspace, version = '1.0.0') {
  fs.mkdirSync(path.join(workspace, 'node_modules', 'example'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'node_modules', 'example', 'package.json'), JSON.stringify({
    name: 'example', version,
  }), 'utf8');
}

function snapshotFiles(root, current = root, result = new Map()) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const filePath = path.join(current, entry.name);
    const relative = path.relative(root, filePath);
    if (entry.isDirectory()) snapshotFiles(root, filePath, result);
    else result.set(relative, fs.readFileSync(filePath));
  }
  return result;
}

test('package-lock.jsonが無いworkspaceは検査対象外', () => {
  const { workspace, cleanup } = fixture();
  try {
    assert.deepEqual(inspectNodeModulesStatus(workspace), { status: STATUS.NOT_APPLICABLE });
  } finally { cleanup(); }
});

test('lockfileがありnode_modulesが無い場合はmissing', () => {
  const { workspace, cleanup } = fixture();
  try {
    writeLock(workspace);
    assert.equal(inspectNodeModulesStatus(workspace).status, STATUS.MISSING);
  } finally { cleanup(); }
});

test('lockfileとインストール済みpackage.jsonが一致する場合はok', () => {
  const { workspace, cleanup } = fixture();
  try {
    writeLock(workspace);
    writeInstalled(workspace);
    assert.deepEqual(inspectNodeModulesStatus(workspace), { status: STATUS.OK });
  } finally { cleanup(); }
});

test('lockfileとインストール済みpackage.jsonのversionが不一致ならmismatch', () => {
  const { workspace, cleanup } = fixture();
  try {
    writeLock(workspace, '1.0.0');
    writeInstalled(workspace, '2.0.0');
    assert.equal(inspectNodeModulesStatus(workspace).status, STATUS.MISMATCH);
  } finally { cleanup(); }
});

test('lockfileの読み取り不能はunknownでありokへ縮退しない', () => {
  const { workspace, cleanup } = fixture();
  try {
    const result = inspectNodeModulesStatus(workspace, {
      readFile: () => { throw new Error('read denied'); },
    });
    assert.equal(result.status, STATUS.UNKNOWN);
  } finally { cleanup(); }
});

test('optionalまたは現在の環境に非対応のlockfileエントリは欠落扱いしない', () => {
  const { workspace, cleanup } = fixture();
  try {
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/optional-package': { version: '1.0.0', optional: true },
        'node_modules/incompatible-package': { version: '1.0.0', os: [`!${process.platform}`] },
      },
    }), 'utf8');
    assert.deepEqual(inspectNodeModulesStatus(workspace), { status: STATUS.OK });
  } finally { cleanup(); }
});

test('状態行には状態と判定理由が含まれる', () => {
  assert.equal(
    formatStatusLine({ status: STATUS.MISMATCH, reason: 'node_modules/example がありません' }),
    'NODE_MODULES_STATUS=mismatch REASON=node_modules/example がありません',
  );
  assert.match(formatStatusLine({ status: STATUS.UNKNOWN, reason: 'lockfile\nread failed' }), /REASON=lockfile read failed/);
});

test('検査はworkspaceへ書き込まない', () => {
  const { workspace, cleanup } = fixture();
  try {
    writeLock(workspace);
    writeInstalled(workspace);
    fs.mkdirSync(path.join(workspace, 'node_modules', 'example', 'node_modules', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'example', 'node_modules', 'nested', 'existing.txt'), 'before', 'utf8');
    const before = snapshotFiles(workspace);
    inspectNodeModulesStatus(workspace);
    const after = snapshotFiles(workspace);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [filePath, content] of before) {
      assert.deepEqual(after.get(filePath), content, `${filePath} の内容が変更されていないこと`);
    }
  } finally { cleanup(); }
});
