'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withTempDir } = require('../scripts/shared/temp-directory');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cleanup-legacy.js');
const CLEANUP_ID = 'cleanup-legacy.statusPaneRecord';
const {
  cleanupLegacyArtifact,
} = require('../scripts/shared/legacy-cleanup');
const { statusPaneRecordPath } = require('../scripts/shared/status-pane-legacy');

function createFixture(root) {
  const workspace = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  return {
    workspace,
    runtimeRoot,
    statusPane: statusPaneRecordPath(workspace, runtimeRoot),
  };
}

function writeRecord(fixture, value) {
  fs.mkdirSync(path.dirname(fixture.statusPane), { recursive: true });
  fs.writeFileSync(fixture.statusPane, value, 'utf8');
}

function cleanup(fixture, overrides = {}) {
  return cleanupLegacyArtifact({
    cleanupId: CLEANUP_ID,
    workspace: fixture.workspace,
    runtimeRoot: fixture.runtimeRoot,
    acquireLockFn: () => true,
    releaseLockFn: () => {},
    ...overrides,
  });
}

function withFixture(callback) {
  return withTempDir('ghm-cleanup-legacy-', (root) => callback(createFixture(root)));
}

function runCli(fixture, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_MAESTRO_RUNTIME_DIR: fixture.runtimeRoot,
    },
  });
}

test('cleanupLegacyArtifactは旧形式の記録だけを削除し、pane操作を行わない', () => {
  withFixture((fixture) => {
    writeRecord(fixture, JSON.stringify({ paneId: 5, issue: '551' }));
    let unlinkCalls = 0;
    const result = cleanup(fixture, {
      unlinkFn: (filePath) => {
        unlinkCalls++;
        assert.equal(filePath, fixture.statusPane);
        fs.unlinkSync(filePath);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'removed');
    assert.equal(unlinkCalls, 1);
    assert.equal(fs.existsSync(fixture.statusPane), false);
  });
});

test('cleanupLegacyArtifactは現行形式・破損・不在を削除しない', () => {
  withFixture((fixture) => {
    const current = JSON.stringify({
      paneId: '5',
      unixSocket: 'C:\\\\wezterm\\\\test-socket',
      targetPaneId: '1',
    });
    writeRecord(fixture, current);
    let unlinkCalls = 0;
    const currentResult = cleanup(fixture, {
      unlinkFn: () => { unlinkCalls++; },
    });
    assert.equal(currentResult.status, 'skipped');
    assert.equal(unlinkCalls, 0);
    assert.equal(fs.readFileSync(fixture.statusPane, 'utf8'), current);

    fs.writeFileSync(fixture.statusPane, '{not-json', 'utf8');
    const corruptResult = cleanup(fixture, {
      unlinkFn: () => { unlinkCalls++; },
    });
    assert.equal(corruptResult.ok, false);
    assert.equal(corruptResult.status, 'unknown');
    assert.equal(unlinkCalls, 0);
    assert.equal(fs.readFileSync(fixture.statusPane, 'utf8'), '{not-json');

    const invalid = JSON.stringify({
      paneId: 'invalid',
      unixSocket: 123,
      targetPaneId: '1',
    });
    fs.writeFileSync(fixture.statusPane, invalid, 'utf8');
    const invalidResult = cleanup(fixture, {
      unlinkFn: () => { unlinkCalls++; },
    });
    assert.equal(invalidResult.ok, false);
    assert.equal(invalidResult.status, 'unknown');
    assert.equal(invalidResult.classification, 'invalid');
    assert.equal(unlinkCalls, 0);
    assert.equal(fs.readFileSync(fixture.statusPane, 'utf8'), invalid);

    fs.rmSync(fixture.statusPane);
    const missingResult = cleanup(fixture, {
      unlinkFn: () => { unlinkCalls++; },
    });
    assert.equal(missingResult.ok, true);
    assert.equal(missingResult.status, 'absent');
    assert.equal(unlinkCalls, 0);
  });
});

test('cleanupLegacyArtifactはロック取得失敗時に旧形式を削除しない', () => {
  withFixture((fixture) => {
    writeRecord(fixture, JSON.stringify({ paneId: 5 }));
    let unlinkCalls = 0;
    const result = cleanup(fixture, {
      acquireLockFn: () => false,
      unlinkFn: () => { unlinkCalls++; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown');
    assert.equal(unlinkCalls, 0);
    assert.equal(fs.existsSync(fixture.statusPane), true);
  });
});

test('cleanupLegacyArtifactは未実装または未知のcleanupIdを拒否する', () => {
  withFixture((fixture) => {
    writeRecord(fixture, JSON.stringify({ paneId: 5 }));
    for (const cleanupId of ['not-a-cleanup-id', 'reset-session.paneId']) {
      const result = cleanupLegacyArtifact({
        cleanupId,
        workspace: fixture.workspace,
        runtimeRoot: fixture.runtimeRoot,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'unsupported');
    }
    assert.equal(fs.existsSync(fixture.statusPane), true);
  });
});

test('cleanup-legacy CLIは境界で引数を検証し、明示した旧形式だけを削除する', () => {
  withFixture((fixture) => {
    for (const flag of ['--help', '-h']) {
      const help = runCli(fixture, flag);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Usage:.*cleanup-legacy\.js/s);
    }

    const missingValue = runCli(fixture, '--cleanup-id');
    assert.notEqual(missingValue.status, 0);
    assert.match(missingValue.stderr, /には値が必要です/);

    const unknownFlag = runCli(fixture, '--unknown');
    assert.notEqual(unknownFlag.status, 0);
    assert.match(unknownFlag.stderr, /未知のフラグ/);

    writeRecord(fixture, JSON.stringify({ paneId: 5, issue: '551' }));
    const removed = runCli(
      fixture,
      '--cleanup-id', CLEANUP_ID,
      '--workspace', fixture.workspace,
    );
    assert.equal(removed.status, 0, removed.stderr);
    const result = JSON.parse(removed.stdout);
    assert.equal(result.status, 'removed');
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(fixture.statusPane), false);
  });
});
