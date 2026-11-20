'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../scripts/set-response-contract');
const { readImplementationApproval, implementationApprovalPath } = require('../scripts/shared/implementation-approval');
const { contractPath } = require('../scripts/shared/response-contract');
const { withTempDir } = require('../scripts/shared/temp-directory');

function withWorkspace(fn) {
  return withTempDir('ghm-set-contract-', workspace => {
    const meta = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, 'workers.json'), JSON.stringify({
      orchestrator: { agentId: 'codex' },
      'issue-725-senior-coder-plan-model': {
        pid: 100, agentId: 'codex', issue: 725, skill: 'gh-maestro-senior-coder', modelPhase: 'planning',
      },
      'issue-725-base-docs': { pid: 101, agentId: 'claude', issue: 725, skill: 'gh-maestro-base' },
    }, null, 2));
    return fn(workspace, path.join(meta, 'workers.json'));
  });
}

function args(workspace, skill) {
  return [
    '--issue', '725', '--skill', skill,
    '--type', 'artifact-or-message', '--artifact', 'pr', '--workspace', workspace,
  ];
}

const deps = {
  prepareScriptGuidanceFn: () => '',
  recordCycleEventFn: () => ({ ok: true }),
};

test('set-response-contract: coder approval writes durable marker without changing workers.json', () => {
  withWorkspace((workspace, workersFile) => {
    const before = fs.readFileSync(workersFile, 'utf8');
    const result = main(args(workspace, 'gh-maestro-senior-coder'), deps);
    assert.equal(result.code, 0);
    assert.deepEqual(readImplementationApproval(workspace, 'issue-725-senior-coder-plan-model').workerName,
      'issue-725-senior-coder-plan-model');
    assert.equal(fs.existsSync(contractPath(workspace, 'issue-725-senior-coder-plan-model')), true);
    assert.equal(fs.readFileSync(workersFile, 'utf8'), before);
  });
});

test('set-response-contract: approval marker write failure prevents contract and approval success', () => {
  withWorkspace((workspace, workersFile) => {
    const before = fs.readFileSync(workersFile, 'utf8');
    const result = main(args(workspace, 'gh-maestro-senior-coder'), {
      ...deps,
      writeImplementationApprovalFn: () => { throw new Error('marker disk failure'); },
    });
    assert.equal(result.code, 1);
    assert.match(result.errLines.join('\n'), /marker disk failure/);
    assert.equal(fs.existsSync(contractPath(workspace, 'issue-725-senior-coder-plan-model')), false);
    assert.equal(fs.existsSync(implementationApprovalPath(workspace, 'issue-725-senior-coder-plan-model')), false);
    assert.equal(fs.readFileSync(workersFile, 'utf8'), before);
  });
});

test('set-response-contract: non-coder artifact contract does not create implementation approval', () => {
  withWorkspace((workspace, workersFile) => {
    const before = fs.readFileSync(workersFile, 'utf8');
    const result = main(args(workspace, 'gh-maestro-base'), {
      ...deps,
      writeImplementationApprovalFn: () => { throw new Error('must not be called'); },
    });
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(implementationApprovalPath(workspace, 'issue-725-base-docs')), false);
    assert.equal(fs.existsSync(contractPath(workspace, 'issue-725-base-docs')), true);
    assert.equal(fs.readFileSync(workersFile, 'utf8'), before);
  });
});
