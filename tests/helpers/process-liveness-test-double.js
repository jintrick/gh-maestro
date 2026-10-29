'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const processLiveness = require('../../scripts/shared/process-liveness');
const productionCreateLiveness = processLiveness.createLiveness;

function createTestLiveness({
  probePid = () => 'unknown',
  probeEndpoint = null,
  readManifest = null,
} = {}) {
  const runtime = path.join(os.tmpdir(), `gh-maestro-liveness-test-${process.pid}`);
  const defaultWorkspace = path.join(os.tmpdir(), `gh-maestro-workspace-${process.pid}`);
  const resources = new Map();
  const endpointKeys = new Map();
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
  const testKey = (label) => digest(`test-resource:${label}`);
  const instanceFor = (pid, label) => `test-${digest(`${pid}\0${label}`).slice(0, 32)}`;

  const endpointProbe = probeEndpoint || ((endpoint) => {
    const key = endpointKeys.get(endpoint);
    if (!key) return 'dead';
    const owner = resources.get(key);
    if (!owner) return 'dead';
    let state;
    try { state = probePid(owner.pid); } catch { return 'unknown'; }
    return state === 'alive' || state === 'dead' ? state : 'unknown';
  });

  const api = productionCreateLiveness({
    runtimeRoot: () => runtime,
    useRealResources: false,
    probeEndpoint: endpointProbe,
    readManifest: readManifest || ((key) => {
      const owner = resources.get(key);
      if (!owner) return null;
      return { schemaVersion: 2, resourceKey: key, instanceId: owner.instanceId, pid: owner.pid };
    }),
    kill: (pid) => {
      let state;
      try { state = probePid(pid); } catch { state = 'unknown'; }
      if (state === 'dead') {
        const error = new Error('process not found');
        error.code = 'ESRCH';
        throw error;
      }
      if (state !== 'alive') {
        const error = new Error('process existence is unknown');
        error.code = 'EPERM';
        throw error;
      }
    },
  });

  function remember(pid, key, instanceId) {
    const normalizedPid = Number(pid);
    const resourceKey = processLiveness.resourceKeyFor
      ? (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? key : testKey(key))
      : testKey(key);
    const actualInstanceId = instanceId || instanceFor(normalizedPid, key);
    resources.set(resourceKey, { pid: normalizedPid, resourceKey, instanceId: actualInstanceId });
    endpointKeys.set(processLiveness.endpointPath(resourceKey, runtime), resourceKey);
    return { resourceKey, instanceId: actualInstanceId };
  }

  function readRef(record, format = 'default', opts = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const pid = format === 'session' ? record.sessionPid : record.pid;
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
    const resourceKey = format === 'session' ? record.sessionResourceKey : record.resourceKey;
    const instanceId = format === 'session' ? record.sessionInstanceId : record.instanceId;
    const legacyKey = format === 'session' ? record.sessionResourceKey : record.resourceKey;
    const hasGenerationlessTestFixture = !resourceKey && !instanceId
      && record.legacyEndpointless !== true
      && typeof record.startTime === 'string' && record.startTime !== '';
    if (resourceKey || legacyKey || hasGenerationlessTestFixture) {
      // Older test fixtures used arbitrary labels and omitted instanceId. Normalize those
      // fixtures into a test-only endpoint. This keeps unrelated lease/lifecycle tests focused
      // on their behavior while explicit PR1 compatibility cases opt into endpointless reads.
      // Production readRef never upgrades partial records.
      const label = resourceKey || legacyKey || `legacy-process:${pid}`;
      const normalized = remember(pid, label, instanceId || (hasGenerationlessTestFixture ? record.startTime : null));
      return api.readRef(format === 'session'
        ? { ...record, sessionResourceKey: normalized.resourceKey, sessionInstanceId: normalized.instanceId }
        : { ...record, resourceKey: normalized.resourceKey, instanceId: normalized.instanceId }, format, opts);
    }
    // PR1 records remain endpointless. The production PID probe returns dead only for ESRCH;
    // a present PID remains unknown because its identity cannot be established.
    return api.readRef(record, format, opts);
  }

  function captureProcess(pid, resourceKeyOrLabel, instanceId) {
    let normalized;
    if (resourceKeyOrLabel && typeof resourceKeyOrLabel === 'object') {
      const resourceKey = /^[a-f0-9]{64}$/.test(resourceKeyOrLabel.resourceKey || '')
        ? resourceKeyOrLabel.resourceKey
        : processLiveness.resourceKeyFor(resourceKeyOrLabel);
      normalized = remember(pid, resourceKey, resourceKeyOrLabel.instanceId || instanceId);
    } else {
      const label = resourceKeyOrLabel === undefined || resourceKeyOrLabel === null
        ? `process:${pid}`
        : resourceKeyOrLabel;
      normalized = remember(pid, label, instanceId);
    }
    return api.captureProcess(Number(pid), normalized);
  }

  function prepareSelf(spec) {
    const resourceKey = spec ? processLiveness.resourceKeyFor(spec) : testKey('self');
    const identity = {
      resourceKey,
      instanceId: spec?.instanceId || instanceFor(process.pid, resourceKey),
    };
    const ref = api.createProcessRef(process.pid, identity);
    preparedSelf = ref;
    return ref;
  }

  function captureSelf(spec) {
    const ref = prepareSelf(spec);
    claim(ref);
    return ref;
  }

  function claim(ref) {
    const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
    remember(value.pid, value.resourceKey, value.instanceId);
    return ref;
  }

  function release(ref) {
    const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
    const current = resources.get(value.resourceKey);
    if (current && current.instanceId === value.instanceId) resources.delete(value.resourceKey);
    return true;
  }

  function observeResource(spec) {
    const key = processLiveness.resourceKeyFor(spec);
    let endpointState;
    try { endpointState = endpointProbe(processLiveness.endpointPath(key, runtime)); }
    catch { return { state: 'unknown' }; }
    if (endpointState === 'dead') return { state: 'dead', ref: null, manifest: null };
    if (endpointState !== 'alive') return { state: 'unknown' };
    const owner = resources.get(key);
    if (!owner) return { state: 'unknown' };
    let state;
    try { state = probePid(owner.pid); } catch { state = 'unknown'; }
    if (state === 'dead') return { state: 'dead', ref: null, manifest: null };
    if (state !== 'alive') return { state: 'unknown' };
    return {
      state: 'alive',
      ref: api.captureProcess(owner.pid, { resourceKey: key, instanceId: owner.instanceId }),
      manifest: { schemaVersion: 2, resourceKey: key, instanceId: owner.instanceId, pid: owner.pid },
    };
  }

  let preparedSelf = null;
  function watchParent(ref) {
    if (!ref) return () => true;
    let consecutiveDead = 0;
    return () => {
      const state = api.observe(ref);
      if (state !== 'dead') {
        consecutiveDead = 0;
        return true;
      }
      consecutiveDead++;
      return consecutiveDead < 3;
    };
  }

  return {
    ...api,
    prepareSelf,
    captureSelf,
    captureProcess,
    readRef,
    claim,
    release,
    observeResource,
    watchParent,
    _preparedSelf: () => preparedSelf,
  };
}

function installLivenessTestAdapter() {
  const sharedApi = createTestLiveness({
    probePid: (pid) => {
      try {
        process.kill(Number(pid), 0);
        return 'alive';
      } catch (error) {
        if (error && error.code === 'ESRCH') return 'dead';
        return 'unknown';
      }
    },
  });
  processLiveness.createLiveness = createTestLiveness;
  for (const method of [
    'prepareSelf', 'captureSelf', 'captureProcess', 'createProcessRef', 'claim', 'release',
    'readRef', 'writeRef', 'observe', 'observeResource', 'sameRef', 'watchParent',
  ]) {
    processLiveness[method] = sharedApi[method].bind(sharedApi);
  }
}

function createResourceLiveness(options = {}) {
  return createTestLiveness(options);
}

function testEndpointPath(spec) {
  return processLiveness.endpointPath(
    processLiveness.resourceKeyFor(spec),
    path.join(os.tmpdir(), `gh-maestro-liveness-test-${process.pid}`),
  );
}

module.exports = {
  createTestLiveness,
  createResourceLiveness,
  testEndpointPath,
  installLivenessTestAdapter,
};
