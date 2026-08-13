'use strict';

// Number-owned workspace records. Every path below this module is derived from
// an explicit owner kind/id; worker-name parsing exists only at legacy API edges.

const path = require('path');

const OWNER_KINDS = Object.freeze(new Set(['issue', 'pr', 'job']));
const OWNER_ID_RE = /^[1-9]\d*$/;
const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const ARTIFACTS = Object.freeze({
  WORKER_LOG: 'workerLog',
  CURSOR: 'cursor',
  CONTRACT: 'contract',
  ASSISTANT_WATCH: 'assistantWatch',
  REVIEW_MANAGER_JSON: 'reviewManagerJson',
  REVIEW_MANAGER_LOG: 'reviewManagerLog',
  REVIEW_MANAGER_RUNNING: 'reviewManagerRunning',
  REVIEW_MANAGER_INCOMPLETE: 'reviewManagerIncomplete',
  REVIEW_MANAGER_RETRY_COUNT: 'reviewManagerRetryCount',
  REVIEW_MANIFEST: 'reviewManifest',
});

function assertWithinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot
    && !resolvedCandidate.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`record path escapes root: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

function assertOwnerKind(ownerKind) {
  if (typeof ownerKind !== 'string' || !OWNER_KINDS.has(ownerKind)) {
    throw new Error(`invalid record owner kind: ${JSON.stringify(ownerKind)}`);
  }
  return ownerKind;
}

function assertOwnerId(ownerId, ownerKind = null) {
  const value = String(ownerId);
  const valid = ownerKind === 'job' ? WORKER_NAME_RE.test(value) : OWNER_ID_RE.test(value);
  if (!valid) {
    throw new Error(`invalid record owner id: ${JSON.stringify(ownerId)}`);
  }
  return value;
}

function assertWorkerName(workerName) {
  if (typeof workerName !== 'string' || !WORKER_NAME_RE.test(workerName)) {
    throw new Error(`invalid record worker name: ${JSON.stringify(workerName)}`);
  }
  return workerName;
}

function recordRoot(workspace) {
  return path.resolve(workspace, '.gh-maestro', 'records');
}

function ownerRoot(workspace, ownerKind, ownerId) {
  const root = recordRoot(workspace);
  const kind = assertOwnerKind(ownerKind);
  const owner = path.join(root, kind, assertOwnerId(ownerId, kind));
  return assertWithinRoot(root, owner);
}

function requireWorker(params) {
  return assertWorkerName(params.workerName);
}

/**
 * Resolve one number-owned record path.
 * @param {string} workspace
 * @param {{ownerKind:string, ownerId:string|number, artifact:string, workerName?:string}} params
 * @returns {string}
 */
function recordPath(workspace, params) {
  if (!params || typeof params !== 'object') throw new Error('record path parameters are required');
  const root = recordRoot(workspace);
  const base = ownerRoot(workspace, params.ownerKind, params.ownerId);
  const worker = () => path.join(base, 'workers', requireWorker(params));
  let candidate;

  switch (params.artifact) {
    case ARTIFACTS.WORKER_LOG:
      candidate = path.join(worker(), 'worker.log');
      break;
    case ARTIFACTS.CURSOR:
      candidate = path.join(worker(), 'cursor.json');
      break;
    case ARTIFACTS.CONTRACT:
      candidate = path.join(worker(), 'contract.json');
      break;
    case ARTIFACTS.ASSISTANT_WATCH:
      if (params.ownerKind !== 'issue' || params.workerName !== undefined) {
        throw new Error('assistantWatch records require an issue owner and no worker name');
      }
      candidate = path.join(base, 'assistant-watch.json');
      break;
    case ARTIFACTS.REVIEW_MANAGER_JSON:
      candidate = path.join(base, 'review', 'manager.json');
      break;
    case ARTIFACTS.REVIEW_MANAGER_LOG:
      candidate = path.join(base, 'review', 'manager.log');
      break;
    case ARTIFACTS.REVIEW_MANAGER_RUNNING:
      candidate = path.join(base, 'review', 'manager.running');
      break;
    case ARTIFACTS.REVIEW_MANAGER_INCOMPLETE:
      candidate = path.join(base, 'review', 'manager.incomplete');
      break;
    case ARTIFACTS.REVIEW_MANAGER_RETRY_COUNT:
      candidate = path.join(base, 'review', 'manager.retries.json');
      break;
    case ARTIFACTS.REVIEW_MANIFEST:
      candidate = path.join(base, 'review', 'manifest.json');
      break;
    default:
      throw new Error(`invalid record artifact: ${JSON.stringify(params.artifact)}`);
  }

  if (params.artifact.startsWith('reviewManager') || params.artifact === ARTIFACTS.REVIEW_MANIFEST) {
    if (params.ownerKind !== 'pr' || params.workerName !== undefined) {
      throw new Error(`${params.artifact} records require a PR owner and no worker name`);
    }
  }
  return assertWithinRoot(root, candidate);
}

function workerRecordPath(workspace, ownerKind, ownerId, artifact, workerName) {
  return recordPath(workspace, { ownerKind, ownerId, artifact, workerName });
}

/** Strict adapter for old worker-name-only APIs. */
function legacyWorkerOwner(workerName) {
  const name = assertWorkerName(workerName);
  let match = /^issue-(\d+)-/.exec(name);
  if (match) {
    const review = /-review-manager-pr-(\d+)$/.exec(name);
    return review
      ? { ownerKind: 'pr', ownerId: review[1], workerName: name }
      : { ownerKind: 'issue', ownerId: match[1], workerName: name };
  }
  match = /^review-job-([A-Za-z0-9][A-Za-z0-9_-]{0,199})$/.exec(name);
  if (match) return { ownerKind: 'job', ownerId: match[1], workerName: name };
  throw new Error(`cannot infer record owner from legacy worker name: ${name}`);
}

function legacyWorkerLogPath(workspace, workerName) {
  const owner = legacyWorkerOwner(workerName);
  return recordPath(workspace, { ...owner, artifact: ARTIFACTS.WORKER_LOG });
}

module.exports = {
  OWNER_KINDS,
  ARTIFACTS,
  assertWithinRoot,
  assertOwnerKind,
  assertOwnerId,
  assertWorkerName,
  recordRoot,
  ownerRoot,
  recordPath,
  workerRecordPath,
  legacyWorkerOwner,
  legacyWorkerLogPath,
};
