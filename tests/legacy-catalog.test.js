'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CATALOG,
  DECLARATION,
  DETECTORS,
  inspectLegacyArtifacts,
  hasLegacyFindings,
} = require('../scripts/shared/legacy-catalog');
const { readFileAtRef } = require('../scripts/shared/git-ref');

// 台帳の自己申告ではなく、Issue #532で確定した対象集合から独立に置く。
const EXPECTED_LEGACY_ITEM_COUNT = 19;

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-legacy-catalog-'));
  fs.mkdirSync(path.join(root, '.gh-maestro'), { recursive: true });
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-legacy-managed-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-legacy-runtime-'));
  return { root, managedRoot, runtimeRoot };
}

function removeWorkspace({ root, managedRoot, runtimeRoot }) {
  for (const dir of [root, managedRoot, runtimeRoot]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function capabilities(overrides = {}) {
  return {
    readRef: () => ({ status: 'absent', reason: 'fixture has no fetched legacy refs' }),
    readGitConfig: () => ({ status: 'absent', value: '' }),
    readGitDir: () => ({ status: 'ok', value: '.git' }),
    isProcessAlive: () => false,
    isWorkerAlive: () => false,
    isLeaseLive: () => false,
    ...overrides,
  };
}

function inspect(fixture, options = {}) {
  return inspectLegacyArtifacts({
    ...options,
    workspace: fixture.root,
    managedRoot: fixture.managedRoot,
    runtimeRoot: fixture.runtimeRoot,
    capabilities: capabilities(options.capabilities),
  });
}

function item(result, id) {
  const found = result.items.find((entry) => entry.id === id);
  assert.ok(found, `catalog item not found: ${id}`);
  return found;
}

test('catalog declares the independent 19-item inventory and all detectors are wired', () => {
  assert.equal(CATALOG.length, EXPECTED_LEGACY_ITEM_COUNT);
  assert.equal(DECLARATION.expectedItemCount, EXPECTED_LEGACY_ITEM_COUNT);
  assert.equal(CATALOG.every((entry) => typeof DETECTORS[entry.id] === 'function'), true);
  assert.equal(CATALOG.every((entry) => typeof entry.detector === 'string'
    && entry.parameters && typeof entry.parameters === 'object'), true);
  assert.deepEqual(Object.keys(DETECTORS).sort(), CATALOG.map((entry) => entry.id).sort());

  const fixture = createWorkspace();
  try {
    const result = inspect(fixture);
    assert.equal(result.completeness, 'complete');
    assert.equal(result.items.length, EXPECTED_LEGACY_ITEM_COUNT);
    assert.equal(result.counts.absent, EXPECTED_LEGACY_ITEM_COUNT);
    assert.equal(hasLegacyFindings(result), false);
  } finally {
    removeWorkspace(fixture);
  }
});

test('catalog completeness depends on detector wiring, not pending integration status', () => {
  const fixture = createWorkspace();
  try {
    const result = inspect(fixture);
    assert.equal(result.completeness, 'complete');
    assert.equal(result.items.some((entry) => entry.integrationStatus === 'pending'), true);

    const missingDetector = { ...DETECTORS };
    delete missingDetector['setup-ai-review-ci'];
    const incomplete = inspect(fixture, { detectors: missingDetector });
    assert.equal(incomplete.completeness, 'incomplete');
    assert.equal(item(incomplete, 'setup-ai-review-ci').status, 'unknown');
    assert.match(item(incomplete, 'setup-ai-review-ci').reason, /detector/);
  } finally {
    removeWorkspace(fixture);
  }
});

test('detectors return present for local legacy files without executing cleanup', () => {
  const fixture = createWorkspace();
  let forbiddenCalls = 0;
  try {
    fs.writeFileSync(path.join(fixture.root, '.gitignore'), 'node_modules/\n.gh-maestro/\n', 'utf8');
    fs.mkdirSync(path.join(fixture.root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\n# gh-maestro:checks:v1\necho old\n', 'utf8');
    fs.writeFileSync(path.join(fixture.managedRoot, 'agents.json'), JSON.stringify([{
      id: 'private-agent',
      prompt: 'do-not-copy-this-secret-into-session-context',
    }]) + '\n', 'utf8');
    fs.mkdirSync(path.join(fixture.managedRoot, 'workflows'));
    fs.mkdirSync(path.join(fixture.root, '.gh-maestro', 'messages'));

    const result = inspect(fixture, {
      capabilities: {
        unlink: () => { forbiddenCalls++; throw new Error('cleanup must not be reachable'); },
        rename: () => { forbiddenCalls++; throw new Error('cleanup must not be reachable'); },
        kill: () => { forbiddenCalls++; throw new Error('cleanup must not be reachable'); },
      },
    });

    assert.equal(item(result, 'setup-legacy-gitignore').status, 'present');
    assert.equal(item(result, 'install-legacy-agents-config').status, 'present');
    assert.equal(Object.hasOwn(item(result, 'install-legacy-agents-config'), 'value'), false);
    assert.doesNotMatch(
      JSON.stringify(item(result, 'install-legacy-agents-config')),
      /do-not-copy-this-secret-into-session-context/,
    );
    assert.equal(item(result, 'install-legacy-managed-items').status, 'present');
    assert.equal(item(result, 'reset-legacy-messages').status, 'present');
    assert.equal(item(result, 'setup-pre-commit-checks-hook').status, 'present');
    assert.equal(forbiddenCalls, 0);
    assert.equal(fs.readFileSync(path.join(fixture.root, '.gitignore'), 'utf8'), 'node_modules/\n.gh-maestro/\n');
  } finally {
    removeWorkspace(fixture);
  }
});

test('resident lease detectors inspect the workspace lease store and preserve malformed JSON as unknown', () => {
  const fixture = createWorkspace();
  try {
    const leasePath = path.join(
      fixture.root,
      '.gh-maestro',
      'leases',
      'resident-role-inbox-supervisor.json',
    );
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 321, startTime: '2026-01-01T00:00:00.000Z' }), 'utf8');
    fs.writeFileSync(path.join(
      fixture.root,
      '.gh-maestro',
      'leases',
      'resident-role-inbose-supervisor.json',
    ), '{broken', 'utf8');

    const result = inspect(fixture, {
      capabilities: {
        isLeaseLive: () => false,
      },
    });
    assert.equal(item(result, 'worker-supervisor-legacy-name').status, 'present');
    assert.equal(item(result, 'restart-residents-legacy-lease').status, 'unknown');
  } finally {
    removeWorkspace(fixture);
  }
});

test('broken JSON and unreadable files become unknown instead of absent', () => {
  const fixture = createWorkspace();
  try {
    fs.writeFileSync(path.join(fixture.managedRoot, 'agents.json'), '{broken', 'utf8');
    const broken = inspect(fixture);
    assert.equal(item(broken, 'install-legacy-agents-config').status, 'unknown');

    const target = path.join(fixture.root, '.gitignore');
    const unreadable = inspect(fixture, {
      capabilities: {
        readFile: (filePath) => {
          if (filePath === target) {
            const error = new Error('permission denied');
            error.code = 'EACCES';
            throw error;
          }
          return fs.readFileSync(filePath, 'utf8');
        },
      },
    });
    assert.equal(item(unreadable, 'setup-legacy-gitignore').status, 'unknown');
  } finally {
    removeWorkspace(fixture);
  }
});

test('unfetched repository refs become unknown and fetched ref content can be inspected', () => {
  const fixture = createWorkspace();
  try {
    const unknownRef = inspect(fixture, {
      capabilities: {
        readRef: () => ({ status: 'unknown', reason: 'ref has not been fetched' }),
      },
    });
    assert.equal(item(unknownRef, 'setup-ai-review-ci').status, 'unknown');

    const calls = [];
    const refResult = readFileAtRef(fixture.root, 'refs/remotes/origin/main', '.github/workflows/reviewer.md', {
      spawnSyncFn: (command, args) => {
        calls.push({ command, args });
        if (calls.length === 1) return { status: 0, stdout: 'abc123\n', stderr: '' };
        return { status: 0, stdout: 'workflow content\n', stderr: '' };
      },
    });
    assert.deepEqual(refResult, { status: 'present', content: 'workflow content\n' });
    assert.deepEqual(calls.map((call) => call.args[0]), ['show', 'show']);
    assert.equal(calls.some((call) => call.command === 'gh'), false);
  } finally {
    removeWorkspace(fixture);
  }
});

test('readState statuses map legacy to present, missing/current to absent, and corrupt to unknown', () => {
  const fixture = createWorkspace();
  try {
    const stateDir = path.join(fixture.root, '.gh-maestro', 'msg-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'legacy.json'), JSON.stringify({ since: '2026-01-01T00:00:00.000Z' }), 'utf8');
    fs.writeFileSync(path.join(stateDir, 'current.json'), JSON.stringify({
      schemaVersion: 2, initialized: true, readByIssue: {}, sinceByIssue: {},
    }), 'utf8');
    const result = inspect(fixture);
    assert.equal(item(result, 'msg-poll-v1-state').status, 'present');

    fs.rmSync(path.join(stateDir, 'legacy.json'));
    fs.writeFileSync(path.join(stateDir, 'corrupt.json'), '{not-json', 'utf8');
    const corrupt = inspect(fixture);
    assert.equal(item(corrupt, 'msg-poll-v1-state').status, 'unknown');

    fs.rmSync(path.join(stateDir, 'corrupt.json'));
    const current = inspect(fixture);
    assert.equal(item(current, 'msg-poll-v1-state').status, 'absent');
  } finally {
    removeWorkspace(fixture);
  }
});

test('process and worker detectors use existing read-only liveness helpers', () => {
  const fixture = createWorkspace();
  let processChecks = 0;
  let workerChecks = 0;
  let leaseChecks = 0;
  try {
    fs.writeFileSync(path.join(fixture.root, '.gh-maestro', 'workers.json'), JSON.stringify({
      'issue-1-old-worker': { notifierPid: 123, paneId: '7' },
    }), 'utf8');
    const leaseDir = path.join(fixture.root, '.gh-maestro', 'leases');
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(path.join(leaseDir, 'issue-1-old-worker.json'), JSON.stringify({ pid: 123 }), 'utf8');

    const result = inspect(fixture, {
      capabilities: {
        isProcessAlive: () => { processChecks++; return false; },
        isWorkerAlive: () => { workerChecks++; return false; },
        isLeaseLive: () => { leaseChecks++; return false; },
      },
    });
    assert.equal(item(result, 'reset-detached-notifier').status, 'present');
    assert.equal(item(result, 'reset-legacy-wezterm-pane').status, 'present');
    assert.equal(item(result, 'stop-worker-legacy-pane').status, 'present');
    assert.equal(item(result, 'spawn-worker-roleless-worker').status, 'present');
    assert.ok(processChecks > 0);
    assert.ok(workerChecks > 0);
    assert.ok(leaseChecks > 0);
  } finally {
    removeWorkspace(fixture);
  }
});

test('workspace-scoped items are not_applicable when no workspace capability is supplied', () => {
  const fixture = createWorkspace();
  try {
    const result = inspectLegacyArtifacts({
      managedRoot: fixture.managedRoot,
      runtimeRoot: fixture.runtimeRoot,
      capabilities: capabilities(),
    });
    assert.equal(item(result, 'setup-legacy-gitignore').status, 'not_applicable');
    assert.equal(item(result, 'install-legacy-agents-config').status, 'absent');
    assert.equal(item(result, 'restart-residents-legacy-lease').status, 'not_applicable');
  } finally {
    removeWorkspace(fixture);
  }
});
