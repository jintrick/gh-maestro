'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readImplementationApproval, writeImplementationApproval } = require('../scripts/shared/implementation-approval');
const { clearContract, writeContract } = require('../scripts/shared/response-contract');
const { withTempDir } = require('../scripts/shared/temp-directory');

const WORKER = 'issue-725-senior-coder-plan-model';
const APPROVED_AT = '2026-10-21T03:04:05.000Z';

function withWorkspace(fn) {
  return withTempDir('ghm-implementation-approval-', workspace => {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    return fn(workspace);
  });
}

test('implementation approval is stored beside the worker contract and survives clearContract', () => {
  withWorkspace(workspace => {
    const expectedPath = path.join(
      workspace, '.gh-maestro', 'records', 'issue', '725', 'workers', WORKER, 'implementation-approved.json',
    );
    const expected = {
      schemaVersion: 1,
      issue: 725,
      workerName: WORKER,
      approvedAt: APPROVED_AT,
    };

    assert.deepEqual(writeImplementationApproval(workspace, WORKER, { approvedAt: APPROVED_AT }), expected);
    assert.equal(fs.existsSync(expectedPath), true);
    assert.deepEqual(readImplementationApproval(workspace, WORKER), expected);

    writeContract(workspace, WORKER, { type: 'artifact-or-message', artifact: 'pr', issue: 725 });
    clearContract(workspace, WORKER);
    assert.deepEqual(readImplementationApproval(workspace, WORKER), expected);
  });
});

test('implementation approval treats only a missing file as not approved', () => {
  withWorkspace(workspace => {
    assert.equal(readImplementationApproval(workspace, WORKER), null);

    const recordPath = path.join(
      workspace, '.gh-maestro', 'records', 'issue', '725', 'workers', WORKER, 'implementation-approved.json',
    );
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, '{ invalid json', 'utf8');
    assert.throws(() => readImplementationApproval(workspace, WORKER), /implementation approval record を読み取れません/);

    fs.writeFileSync(recordPath, JSON.stringify({
      schemaVersion: 1, issue: '725', workerName: WORKER, approvedAt: APPROVED_AT,
    }), 'utf8');
    assert.throws(() => readImplementationApproval(workspace, WORKER), /implementation approval record が不正です/);

    fs.writeFileSync(recordPath, JSON.stringify({
      schemaVersion: 1, issue: 725, workerName: WORKER, approvedAt: 'not-a-date',
    }), 'utf8');
    assert.throws(() => readImplementationApproval(workspace, WORKER), /approvedAt が不正/);
  });
});

test('implementation approval does not convert a non-ENOENT read error into absence', () => {
  withWorkspace(workspace => {
    const recordPath = path.join(
      workspace, '.gh-maestro', 'records', 'issue', '725', 'workers', WORKER, 'implementation-approved.json',
    );
    fs.mkdirSync(recordPath, { recursive: true });
    assert.throws(
      () => readImplementationApproval(workspace, WORKER),
      error => error.message.includes(recordPath) && error.message.includes('読み取れません'),
    );
  });
});
