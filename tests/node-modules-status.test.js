'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATUS, inspectNodeModulesStatus } = require('../scripts/shared/node-modules-status');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-node-modules-status-'));
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

test('package-lock.jsonが無いworkspaceは検査対象外', () => {
  const workspace = fixture();
  try {
    assert.deepEqual(inspectNodeModulesStatus(workspace), { status: STATUS.NOT_APPLICABLE });
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('lockfileがありnode_modulesが無い場合はmissing', () => {
  const workspace = fixture();
  try {
    writeLock(workspace);
    assert.equal(inspectNodeModulesStatus(workspace).status, STATUS.MISSING);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('lockfileとインストール済みpackage.jsonが一致する場合はok', () => {
  const workspace = fixture();
  try {
    writeLock(workspace);
    writeInstalled(workspace);
    assert.deepEqual(inspectNodeModulesStatus(workspace), { status: STATUS.OK });
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('lockfileとインストール済みpackage.jsonのversionが不一致ならmismatch', () => {
  const workspace = fixture();
  try {
    writeLock(workspace, '1.0.0');
    writeInstalled(workspace, '2.0.0');
    assert.equal(inspectNodeModulesStatus(workspace).status, STATUS.MISMATCH);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('lockfileの読み取り不能はunknownでありokへ縮退しない', () => {
  const workspace = fixture();
  try {
    const result = inspectNodeModulesStatus(workspace, {
      readFile: () => { throw new Error('read denied'); },
    });
    assert.equal(result.status, STATUS.UNKNOWN);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('検査はworkspaceへ書き込まない', () => {
  const workspace = fixture();
  try {
    writeLock(workspace);
    const before = fs.readdirSync(workspace).sort();
    inspectNodeModulesStatus(workspace);
    assert.deepEqual(fs.readdirSync(workspace).sort(), before);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
