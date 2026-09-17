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
  CLEANERS,
} = require('../scripts/shared/legacy-cleanup');
const { statusPanePath } = require('../scripts/shared/status-pane-registry');
const readStateLib = require('../scripts/shared/read-state');

function createFixture(root) {
  const workspace = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  return {
    workspace,
    runtimeRoot,
    statusPane: statusPanePath(workspace, runtimeRoot),
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
    const result = cleanupLegacyArtifact({
      cleanupId: 'not-a-cleanup-id',
      workspace: fixture.workspace,
      runtimeRoot: fixture.runtimeRoot,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unsupported');

    const integratedResult = cleanupLegacyArtifact({
      cleanupId: 'reset-session.paneId',
      workspace: fixture.workspace,
      runtimeRoot: fixture.runtimeRoot,
    });
    assert.equal(integratedResult.ok, true);
    assert.equal(integratedResult.status, 'absent');
    assert.equal(fs.existsSync(fixture.statusPane), false);
  });
});

test('Issue #553の16 cleanupIdは独立した期待集合から全てdispatch可能である', () => {
  const expected = [
    'gh-maestro-setup.retireAiReviewCi',
    'gh-maestro-setup.ensureSyncHook',
    'gh-maestro-setup.retireChecksHooks',
    'gh-maestro-setup.removeStaleDefaultHooks',
    'gh-maestro-setup.ensureGitIgnore',
    'install.quarantineLegacyAgentsConfig',
    'install.quarantineLegacyHomePids',
    'install.pruneManagedRoot',
    'reset-session.notifierPid',
    'reset-session.paneId',
    'reset-session.messages',
    'reset-session.queue',
    'stop-worker-process.paneId',
    'worker-supervisor-control.legacyName',
    'restart-residents.legacyLease',
    'spawn-worker.rolelessGuard',
  ];
  assert.equal(new Set(expected).size, 16);
  assert.deepEqual(expected.filter((cleanupId) => typeof CLEANERS[cleanupId] === 'function'), expected);
});

test('Issue #553の16 cleanupIdは共通入口からテーブル駆動で到達し、catalog parametersを受け取る', () => {
  const expected = [
    'gh-maestro-setup.retireAiReviewCi',
    'gh-maestro-setup.ensureSyncHook',
    'gh-maestro-setup.retireChecksHooks',
    'gh-maestro-setup.removeStaleDefaultHooks',
    'gh-maestro-setup.ensureGitIgnore',
    'install.quarantineLegacyAgentsConfig',
    'install.quarantineLegacyHomePids',
    'install.pruneManagedRoot',
    'reset-session.notifierPid',
    'reset-session.paneId',
    'reset-session.messages',
    'reset-session.queue',
    'stop-worker-process.paneId',
    'worker-supervisor-control.legacyName',
    'restart-residents.legacyLease',
    'spawn-worker.rolelessGuard',
  ];
  const allowedStatuses = new Set(['removed', 'absent', 'skipped', 'unknown']);

  withFixture((fixture) => {
    const managedRoot = path.join(path.dirname(fixture.workspace), 'managed');
    const hooksDir = path.join(path.dirname(fixture.workspace), 'hooks');
    const defaultHooksDir = path.join(path.dirname(fixture.workspace), 'default-hooks');
    fs.mkdirSync(path.join(managedRoot, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(managedRoot, 'not-cataloged'), { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(defaultHooksDir, { recursive: true });

    for (const cleanupId of expected) {
      const result = cleanupLegacyArtifact({
        cleanupId,
        workspace: fixture.workspace,
        runtimeRoot: fixture.runtimeRoot,
        managedRoot,
        hooksDir,
        defaultHooksDir,
        verifyOnly: false,
        sourcePath: path.join(managedRoot, 'agents.json'),
        configPath: path.join(managedRoot, 'config.json'),
        defaultsPath: path.join(managedRoot, 'agent-defaults.json'),
        quarantineDir: path.join(fixture.runtimeRoot, 'legacy-home', 'pids'),
      });
      assert.equal(result.cleanupId, cleanupId);
      assert.ok(allowedStatuses.has(result.status), `${cleanupId}: ${result.status}`);
      assert.equal(result.ok, result.status !== 'unknown');
    }

    // install.pruneManagedRoot receives the exact entries from its catalog entry;
    // the decoy top-level path must survive while workflows is removed.
    assert.equal(fs.existsSync(path.join(managedRoot, 'workflows')), false);
    assert.equal(fs.existsSync(path.join(managedRoot, 'not-cataloged')), true);
  });
});

test('cleanupLegacyRecordsはassistant-watchをregistryなしで移行する', () => {
  withFixture((fixture) => {
    const watchDir = path.join(fixture.workspace, '.gh-maestro', 'assistant-watch');
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(path.join(watchDir, '5.json'), '{"prs":{}}', 'utf8');
    fs.writeFileSync(path.join(watchDir, '7.json'), '{"prs":{}}', 'utf8');
    const result = cleanupLegacyArtifact({
      cleanupId: 'migrate-records.planMigration',
      workspace: fixture.workspace,
      runtimeRoot: fixture.runtimeRoot,
      scope: 'assistant-watch',
    });
    assert.equal(result.status, 'removed', JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.held.length, 0);
    assert.equal(result.moved.length, 2);
    assert.equal(fs.existsSync(path.join(watchDir, '5.json')), false);
    assert.equal(fs.existsSync(path.join(watchDir, '7.json')), false);
  });
});

test('setup cleanerはhook/gitignoreの旧ブロックだけを除去し、再実行をabsentにする', () => {
  withFixture((fixture) => {
    const hooksDir = path.join(fixture.workspace, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommit = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(preCommit, '#!/bin/sh\n# gh-maestro:checks:v1\necho old-check\n\nnode build\n', 'utf8');
    const hookResult = cleanupLegacyArtifact({
      cleanupId: 'gh-maestro-setup.ensureSyncHook',
      workspace: fixture.workspace,
      hooksDir,
      verifyOnly: false,
    });
    assert.equal(hookResult.status, 'removed');
    assert.match(fs.readFileSync(preCommit, 'utf8'), /node build/);
    assert.doesNotMatch(fs.readFileSync(preCommit, 'utf8'), /gh-maestro:checks/);
    assert.equal(cleanupLegacyArtifact({
      cleanupId: 'gh-maestro-setup.ensureSyncHook',
      workspace: fixture.workspace,
      hooksDir,
      verifyOnly: false,
    }).status, 'absent');

    fs.writeFileSync(path.join(fixture.workspace, '.gitignore'), 'node_modules/\n.gh-maestro/\n', 'utf8');
    const ignoreResult = cleanupLegacyArtifact({
      cleanupId: 'gh-maestro-setup.ensureGitIgnore',
      workspace: fixture.workspace,
    });
    assert.equal(ignoreResult.status, 'removed');
    const ignore = fs.readFileSync(path.join(fixture.workspace, '.gitignore'), 'utf8');
    assert.doesNotMatch(ignore, /^\.gh-maestro\/$/m);
    assert.match(ignore, /\.gh-maestro\/\*/);
    assert.match(ignore, /!\.gh-maestro\/config\.json/);
  });
});

test('setup stale-default-hook cleanerはdefault置き場の旧ブロックだけを削除する', () => {
  withFixture((fixture) => {
    const hooksDir = path.join(fixture.workspace, 'effective-hooks');
    const defaultHooksDir = path.join(fixture.workspace, '.git', 'hooks');
    fs.mkdirSync(defaultHooksDir, { recursive: true });
    const prePush = path.join(defaultHooksDir, 'pre-push');
    fs.writeFileSync(prePush, '#!/bin/sh\n# gh-maestro:checks:v1\necho old\n', 'utf8');
    const result = cleanupLegacyArtifact({
      cleanupId: 'gh-maestro-setup.removeStaleDefaultHooks',
      workspace: fixture.workspace,
      hooksDir,
      defaultHooksDir,
      verifyOnly: false,
    });
    assert.equal(result.status, 'removed');
    assert.equal(fs.existsSync(prePush), false);
    assert.equal(cleanupLegacyArtifact({
      cleanupId: 'gh-maestro-setup.removeStaleDefaultHooks',
      workspace: fixture.workspace,
      hooksDir,
      defaultHooksDir,
      verifyOnly: false,
    }).status, 'absent');
  });
});

test('msg-poll cleanerはworkerの旧seenIdsをIssue付きv2 stateへ移行し、特定不能なorchestratorは保持する', () => {
  withFixture((fixture) => {
    const stateDir = path.join(fixture.workspace, '.gh-maestro', 'msg-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.gh-maestro', 'workers.json'), JSON.stringify({
      'issue-553-old': { issue: 553 },
    }), 'utf8');
    fs.writeFileSync(path.join(stateDir, 'issue-553-old.json'), JSON.stringify({
      since: '2026-01-01T00:00:00.000Z', seenIds: [1, 2],
    }), 'utf8');
    fs.writeFileSync(path.join(stateDir, 'orchestrator.json'), JSON.stringify({
      since: { 553: '2026-01-01T00:00:00.000Z' }, seenIds: [3],
    }), 'utf8');

    const result = cleanupLegacyArtifact({
      cleanupId: 'msg-poll.readState',
      workspace: fixture.workspace,
    });
    assert.equal(result.status, 'removed');
    assert.deepEqual(readStateLib.readState(fixture.workspace, 'issue-553-old').state.readByIssue['553'], [1, 2]);
    assert.equal(readStateLib.readState(fixture.workspace, 'issue-553-old').state.sinceByIssue['553'], '2026-01-01T00:00:00.000Z');
    assert.equal(readStateLib.readState(fixture.workspace, 'orchestrator').status, 'legacy');
    assert.deepEqual(result.skipped, ['orchestrator']);
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
