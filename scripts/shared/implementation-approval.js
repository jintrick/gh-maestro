'use strict';

// implementation-approval.js — 計画承認後のモデル切替記録を扱う。
//
// set-response-contract.js が implementation-approved.json へ書き込み、
// worker-supervisor.js は再開時に読み取る。contract.json と別ファイルにすることで、
// supervisor が応答契約を消費した後も承認状態を保つ。

const { atomicWriteJson } = require('./atomic-write');
const { JsonFileError, readJsonFile } = require('./json-file');
const { _validateAgainstSchema } = require('./json-schema');
const { ARTIFACTS, legacyWorkerOwner, recordPath } = require('./record-paths');

const IMPLEMENTATION_APPROVAL_SCHEMA = Object.freeze({
  type: 'object',
  required: ['schemaVersion', 'issue', 'workerName', 'approvedAt'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', minimum: 1 },
    issue: { type: 'integer', minimum: 1 },
    workerName: { type: 'string', minLength: 1 },
    approvedAt: { type: 'string', minLength: 1 },
  },
});

function implementationApprovalPath(workspace, workerName, owner = null) {
  const resolvedOwner = owner || legacyWorkerOwner(workerName);
  return recordPath(workspace, {
    ...resolvedOwner,
    workerName,
    artifact: ARTIFACTS.IMPLEMENTATION_APPROVAL,
  });
}

function validateImplementationApproval(value, filePath, workerName, owner) {
  const errors = _validateAgainstSchema(value, IMPLEMENTATION_APPROVAL_SCHEMA, 'implementationApproval');
  if (errors.length > 0) {
    throw new Error(`implementation approval record が不正です: ${filePath}: ${errors.join('; ')}`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`implementation approval record の schemaVersion が未対応です: ${filePath}`);
  }
  if (value.issue !== Number(owner.ownerId) || value.workerName !== workerName) {
    throw new Error(`implementation approval record の所有者が一致しません: ${filePath}`);
  }
  const approvedAt = new Date(value.approvedAt);
  if (!Number.isFinite(approvedAt.getTime()) || approvedAt.toISOString() !== value.approvedAt) {
    throw new Error(`implementation approval record の approvedAt が不正です: ${filePath}`);
  }
  return value;
}

function writeImplementationApproval(workspace, workerName, opts = {}) {
  const owner = legacyWorkerOwner(workerName);
  const filePath = implementationApprovalPath(workspace, workerName, owner);
  const approvedAt = opts.approvedAt || new Date().toISOString();
  const value = {
    schemaVersion: 1,
    issue: Number(owner.ownerId),
    workerName,
    approvedAt,
  };
  validateImplementationApproval(value, filePath, workerName, owner);
  atomicWriteJson(filePath, value);
  return value;
}

function readImplementationApproval(workspace, workerName) {
  const owner = legacyWorkerOwner(workerName);
  const filePath = implementationApprovalPath(workspace, workerName, owner);
  let value;
  try {
    value = readJsonFile(filePath);
  } catch (error) {
    if (error instanceof JsonFileError && error.kind === 'read' && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`implementation approval record を読み取れません: ${filePath}: ${error.message}`, { cause: error });
  }
  return validateImplementationApproval(value, filePath, workerName, owner);
}

module.exports = {
  IMPLEMENTATION_APPROVAL_SCHEMA,
  implementationApprovalPath,
  writeImplementationApproval,
  readImplementationApproval,
};
