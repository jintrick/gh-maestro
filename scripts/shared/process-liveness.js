'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { atomicWriteJson } = require('./atomic-write');
const { runtimeRoot, canonicalWorkspace, assertValidWorkspace } = require('./storage-layout');
const { resolveWorkspace } = require('./workspace');

const IS_WIN = process.platform === 'win32';
const RESOURCE_KEY_ENV = 'GH_MAESTRO_RESOURCE_KEY';
const INSTANCE_ID_ENV = 'GH_MAESTRO_INSTANCE_ID';
const PROBE_TIMEOUT_MS = 250;
const CLAIM_TIMEOUT_MS = 5000;
const PROBE_WORKER_PATH = path.join(__dirname, 'process-liveness-probe-worker.js');
const PROCESS_REGISTRY_DIR = 'process-liveness';
const RESOURCE_KEY_RE = /^[a-f0-9]{64}$/;

let probeWorker = null;
let probeWorkerFailure = null;

function newInstanceId() {
  return crypto.randomUUID();
}

function validateInstanceId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : null;
}

function validateResourceKey(value) {
  return typeof value === 'string' && RESOURCE_KEY_RE.test(value) ? value : null;
}

function resourceKeyFor({ workspace, kind, name }) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('process resource workspace is required');
  }
  if (typeof kind !== 'string' || kind.trim() === '') {
    throw new Error('process resource kind is required');
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('process resource name is required');
  }
  const resolvedWorkspace = resolveWorkspace(workspace);
  if (!resolvedWorkspace) throw new Error(`process resource workspace is invalid: ${workspace}`);
  const canonical = canonicalWorkspace(resolvedWorkspace);
  assertValidWorkspace(canonical);
  return crypto.createHash('sha256')
    .update(JSON.stringify([canonical, kind.trim(), name.trim()]))
    .digest('hex');
}

function endpointPath(resourceKey, root = runtimeRoot()) {
  if (!validateResourceKey(resourceKey)) throw new Error('process resource key is invalid');
  const digest = resourceKey.slice(0, 32);
  if (IS_WIN) return `\\\\.\\pipe\\gh-maestro-${digest}`;
  // Keep the absolute Unix socket path below sun_path's small platform limit.
  return path.join(root, `gh-maestro-${digest}.sock`);
}

function manifestPath(resourceKey, root = runtimeRoot()) {
  if (!validateResourceKey(resourceKey)) throw new Error('process resource key is invalid');
  return path.join(root, PROCESS_REGISTRY_DIR, `${resourceKey}.json`);
}

function createChildLivenessEnv({ env = process.env, workspace, kind, name, instanceId = newInstanceId() } = {}) {
  const resourceKey = resourceKeyFor({ workspace, kind, name });
  if (!validateInstanceId(instanceId)) throw new Error('process instance id is invalid');
  return {
    resourceKey,
    instanceId,
    env: {
      ...env,
      GH_MAESTRO_WORKSPACE: canonicalWorkspace(resolveWorkspace(workspace)),
      [RESOURCE_KEY_ENV]: resourceKey,
      [INSTANCE_ID_ENV]: instanceId,
    },
  };
}

function startProbeWorker() {
  if (probeWorker || probeWorkerFailure) return probeWorker;
  try {
    probeWorker = new Worker(PROBE_WORKER_PATH);
    probeWorker.unref();
    probeWorker.on('error', (error) => {
      probeWorkerFailure = error || new Error('process liveness probe worker failed');
    });
    probeWorker.on('exit', (code) => {
      if (code !== 0) probeWorkerFailure = new Error(`process liveness probe worker exited with code ${code}`);
    });
  } catch (error) {
    probeWorkerFailure = error;
  }
  return probeWorker;
}

function probeWorkerRequest(message, timeoutMs) {
  const worker = startProbeWorker();
  if (!worker || probeWorkerFailure) return 3;

  const shared = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    worker.postMessage({ ...message, shared: shared.buffer, timeoutMs });
  } catch {
    return 3;
  }
  const waitResult = Atomics.wait(shared, 0, 0, timeoutMs + 50);
  if (waitResult !== 'timed-out') return Atomics.load(shared, 0);

  if (message.type === 'claim') {
    // A late bind must not leave an untracked listener behind after the synchronous
    // caller gives up. The worker checks this cancellation before retaining the server.
    const cancelled = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      worker.postMessage({ type: 'cancel-claim', requestId: message.requestId, shared: cancelled.buffer });
      Atomics.wait(cancelled, 0, 0, 1000);
    } catch {}
  }
  return 3;
}

/**
 * Synchronize a local net connection probe through one unrefed Node worker thread.
 * The worker keeps the existing synchronous tri-state API without starting a subprocess.
 */
function probeEndpointSync(endpoint, timeoutMs = PROBE_TIMEOUT_MS) {
  switch (probeWorkerRequest({ type: 'probe', endpoint }, timeoutMs)) {
    case 1: return 'alive';
    case 2: return 'dead';
    default: return 'unknown';
  }
}

function claimEndpointSync(endpoint, resourceKey) {
  return probeWorkerRequest({
    type: 'claim',
    endpoint,
    resourceKey,
    requestId: crypto.randomUUID(),
  }, CLAIM_TIMEOUT_MS);
}

function releaseEndpointSync(resourceKey) {
  return probeWorkerRequest({ type: 'release', resourceKey }, CLAIM_TIMEOUT_MS);
}

function validatePid(pid) {
  if ((typeof pid !== 'number' && typeof pid !== 'string')
      || (typeof pid === 'string' && !pid.trim())) {
    throw new Error('invalid process identifier');
  }
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) throw new Error('invalid process identifier');
  return value;
}

function readManifest(resourceKey, root = runtimeRoot()) {
  const filePath = manifestPath(resourceKey, root);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    const wrapped = new Error(`process liveness manifest を読み取れません: ${filePath}: ${error.message}`, { cause: error });
    wrapped.code = 'LIVENESS_CORRUPT';
    throw wrapped;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`process liveness manifest が壊れています: ${filePath}: ${error.message}`, { cause: error });
    wrapped.code = 'LIVENESS_CORRUPT';
    throw wrapped;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 2 || value.resourceKey !== resourceKey
      || !Number.isInteger(value.pid) || value.pid <= 0
      || !validateInstanceId(value.instanceId)) {
    const error = new Error(`process liveness manifest の形式が不正です: ${filePath}`);
    error.code = 'LIVENESS_CORRUPT';
    throw error;
  }
  return value;
}

function writeManifest(value, root = runtimeRoot()) {
  if (!value || !validateResourceKey(value.resourceKey) || !validateInstanceId(value.instanceId)
      || !Number.isInteger(value.pid) || value.pid <= 0) throw new Error('invalid process reference');
  const filePath = manifestPath(value.resourceKey, root);
  atomicWriteJson(filePath, {
    schemaVersion: 2,
    resourceKey: value.resourceKey,
    instanceId: value.instanceId,
    pid: value.pid,
  });
}

function socketSnapshot(endpoint) {
  if (IS_WIN) return null;
  let stat;
  try {
    stat = fs.lstatSync(endpoint);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new Error(`process liveness endpoint is not a Unix socket: ${endpoint}`);
  }
  return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

function removeDeadSocket(endpoint, expected) {
  if (IS_WIN || !expected) return;
  let current;
  try {
    current = fs.lstatSync(endpoint);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!current.isSocket()) {
    throw new Error(`process liveness endpoint is not a Unix socket: ${endpoint}`);
  }
  // Another process may have replaced the stale socket with its live listener after our
  // probe. Never unlink a path whose inode changed since the pre-probe snapshot.
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.ctimeMs !== expected.ctimeMs) return;
  fs.unlinkSync(endpoint);
}

function legacyPidStatus(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return 'present';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function legacyPidState(pid, kill = process.kill.bind(process)) {
  // An existing PID could have been reused; legacy records lack endpoint identity.
  return legacyPidStatus(pid, kill) === 'dead' ? 'dead' : 'unknown';
}

function createLiveness(deps = {}) {
  const getRuntimeRoot = deps.runtimeRoot || runtimeRoot;
  const probeEndpoint = deps.probeEndpoint || probeEndpointSync;
  const readManifestFn = deps.readManifest || readManifest;
  const createServer = deps.createServer || null;
  const useRealResources = deps.useRealResources === undefined
    ? deps.probeEndpoint === undefined
    : deps.useRealResources;
  const killFn = deps.kill || process.kill.bind(process);
  const refsByKey = new Map();
  const serversByKey = new Map();
  let activeSelfRef = null;
  let exitCleanupRegistered = false;

  const encode = (pid, resourceKey, instanceId) => Buffer.from(JSON.stringify(
    validateResourceKey(resourceKey) && validateInstanceId(instanceId)
      ? { v: 3, pid, resourceKey, instanceId }
      : { v: 1, pid },
  )).toString('base64url');

  function decodeRef(ref) {
    if (typeof ref !== 'string' || ref.length === 0) return null;
    try {
      const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
      if (!value || !Number.isInteger(value.pid) || value.pid <= 0) return null;
      if (value.v === 1 || value.v === 2) {
        // PR1 records have no deterministic resource key. ESRCH proves they are dead;
        // an existing PID is unknown because it may have been reused.
        return { v: 1, pid: value.pid, resourceKey: null, instanceId: null };
      }
      if (value.v !== 3 || !validateResourceKey(value.resourceKey)
          || !validateInstanceId(value.instanceId)) return null;
      return {
        v: 3,
        pid: value.pid,
        resourceKey: value.resourceKey,
        instanceId: value.instanceId,
      };
    } catch {
      return null;
    }
  }

  function resourceFor(spec = {}) {
    if (spec.resourceKey !== undefined) {
      if (!validateResourceKey(spec.resourceKey)) throw new Error('process resource key is invalid');
      return { resourceKey: spec.resourceKey, instanceId: spec.instanceId };
    }
    return {
      resourceKey: resourceKeyFor(spec),
      instanceId: spec.instanceId,
    };
  }

  function defaultResource() {
    const workspace = resolveWorkspace(process.env.GH_MAESTRO_WORKSPACE);
    if (!workspace) throw new Error('process liveness workspace を解決できません');
    const script = path.basename(process.argv[1] || process.execPath);
    const role = typeof process.env.GH_MAESTRO_WORKER === 'string' && process.env.GH_MAESTRO_WORKER.trim()
      ? process.env.GH_MAESTRO_WORKER.trim()
      : 'orchestrator';
    return { workspace, kind: 'process', name: `${script}:${role}` };
  }

  function prepareSelf(spec) {
    if (activeSelfRef && !spec) return activeSelfRef;
    let identity;
    if (spec) {
      identity = resourceFor(spec);
    } else {
      const envKey = process.env[RESOURCE_KEY_ENV];
      const envInstance = process.env[INSTANCE_ID_ENV];
      if (envKey !== undefined || envInstance !== undefined) {
        if (!validateResourceKey(envKey) || !validateInstanceId(envInstance)) {
          throw new Error('process liveness environment resource identity is invalid');
        }
        identity = { resourceKey: envKey, instanceId: envInstance };
      } else {
        identity = resourceFor(defaultResource());
      }
    }

    const cached = refsByKey.get(identity.resourceKey);
    if (cached) {
      const value = decodeRef(cached);
      if (identity.instanceId && identity.instanceId !== value.instanceId) {
        throw new Error('process liveness resource instance id changed within the process');
      }
      activeSelfRef = cached;
      return cached;
    }

    const instanceId = identity.instanceId || newInstanceId();
    if (!validateInstanceId(instanceId)) throw new Error('process instance id is invalid');
    const ref = encode(process.pid, identity.resourceKey, instanceId);
    refsByKey.set(identity.resourceKey, ref);
    activeSelfRef = ref;
    process.env[RESOURCE_KEY_ENV] = identity.resourceKey;
    process.env[INSTANCE_ID_ENV] = instanceId;
    return ref;
  }

  function observeResource(spec) {
    let identity;
    try { identity = resourceFor(spec); } catch (error) { return { state: 'unknown', error }; }
    let state;
    try { state = probeEndpoint(endpointPath(identity.resourceKey, getRuntimeRoot())); } catch (error) {
      return { state: 'unknown', error };
    }
    if (state !== 'alive' && state !== 'dead') return { state: 'unknown' };
    if (state === 'dead') return { state: 'dead', ref: null, manifest: null };
    let manifest;
    try { manifest = readManifestFn(identity.resourceKey, getRuntimeRoot()); } catch (error) {
      if (error && error.code === 'LIVENESS_CORRUPT') throw error;
      return { state: 'unknown', error };
    }
    if (!manifest) return { state: 'unknown', error: new Error('live endpoint has no process liveness manifest') };
    const ref = encode(manifest.pid, manifest.resourceKey, manifest.instanceId);
    return { state: 'alive', ref, manifest };
  }

  function observe(ref) {
    const value = decodeRef(ref);
    if (!value) return 'unknown';
    if (!value.resourceKey) return legacyPidState(value.pid, killFn);
    const observed = observeResource({ resourceKey: value.resourceKey });
    if (observed.state !== 'alive') return observed.state;
    return observed.manifest.pid === value.pid && observed.manifest.instanceId === value.instanceId
      ? 'alive'
      : 'dead';
  }

  function observeLegacyPid(pid) {
    let normalizedPid;
    try { normalizedPid = validatePid(pid); } catch { return 'unknown'; }
    return legacyPidStatus(normalizedPid, killFn);
  }

  function createProcessRef(pid, identity) {
    const normalizedPid = validatePid(pid);
    if (!identity) return encode(normalizedPid, null, null);
    const resource = resourceFor(identity);
    const instanceId = resource.instanceId || newInstanceId();
    if (!validateInstanceId(instanceId)) throw new Error('process instance id is invalid');
    return encode(normalizedPid, resource.resourceKey, instanceId);
  }

  function captureProcess(pid, resourceKeyOrIdentity, instanceId) {
    const normalizedPid = validatePid(pid);
    if (resourceKeyOrIdentity === undefined || resourceKeyOrIdentity === null) {
      if (normalizedPid === process.pid && activeSelfRef) return activeSelfRef;
      return encode(normalizedPid, null, null);
    }
    const identity = typeof resourceKeyOrIdentity === 'string'
      ? { resourceKey: resourceKeyOrIdentity, instanceId }
      : { ...resourceKeyOrIdentity };
    return createProcessRef(normalizedPid, identity);
  }

  function captureSelf(spec) {
    const ref = prepareSelf(spec);
    claim(ref);
    return ref;
  }

  function claim(ref) {
    const value = decodeRef(ref);
    if (!value || value.pid !== process.pid || !value.resourceKey || !value.instanceId) {
      throw new Error('process liveness claim requires a valid self resource reference');
    }
    const existingServer = serversByKey.get(value.resourceKey);
    if (existingServer) {
      const existingRef = existingServer.ref;
      if (sameRef(existingRef, ref)) return ref;
      throw new Error('process already owns this resource with another instance id');
    }
    if (!useRealResources) {
      serversByKey.set(value.resourceKey, { ref, server: null, endpoint: null });
      return ref;
    }

    const endpoint = endpointPath(value.resourceKey, getRuntimeRoot());
    let staleSocket;
    try { staleSocket = socketSnapshot(endpoint); } catch (error) {
      const wrapped = new Error(`process liveness endpoint を確認できません: ${endpoint}: ${error.message}`, { cause: error });
      wrapped.code = 'LIVENESS_UNKNOWN';
      throw wrapped;
    }
    let current;
    try { current = probeEndpoint(endpoint); } catch (error) {
      const wrapped = new Error(`process liveness endpoint を確認できません: ${endpoint}: ${error.message}`, { cause: error });
      wrapped.code = 'LIVENESS_UNKNOWN';
      throw wrapped;
    }
    if (current === 'unknown') {
      const error = new Error(`process liveness endpoint を確認できません (${current}): ${endpoint}`);
      error.code = 'LIVENESS_UNKNOWN';
      throw error;
    }
    if (current !== 'dead') {
      const error = new Error(`process liveness endpoint は取得できません (${current}): ${endpoint}`);
      error.code = 'LIVENESS_ENDPOINT_BUSY';
      throw error;
    }

    // The endpoint is authoritative: once no process listens, every manifest left behind is stale.
    // A live endpoint's manifest is still validated by observeResource before its metadata is used.
    if (!IS_WIN) {
      try { removeDeadSocket(endpoint, staleSocket); } catch (error) {
        throw new Error(`process liveness socket を再利用できません: ${endpoint}: ${error.message}`, { cause: error });
      }
      fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    }

    let server = null;
    let workerListener = false;
    try {
      if (createServer) {
        server = createServer((socket) => socket.destroy());
        server.on('error', (error) => {
          server.failure = error || new Error('process liveness listener failed');
        });
        server.listen(endpoint);
        if (!server.listening) {
          const cause = server.failure;
          let observed = 'unknown';
          try { observed = probeEndpoint(endpoint); } catch {}
          const error = new Error(`process liveness endpoint の排他取得に失敗しました${cause ? `: ${cause.message}` : ''}`);
          error.code = observed === 'alive' || cause?.code === 'EADDRINUSE' || cause?.code === 'EEXIST'
            ? 'LIVENESS_ENDPOINT_BUSY'
            : observed === 'unknown'
              ? 'LIVENESS_UNKNOWN'
              : 'LIVENESS_CLAIM_FAILED';
          throw error;
        }
      } else {
        const claimed = claimEndpointSync(endpoint, value.resourceKey);
        if (claimed !== 1) {
          let observed = 'unknown';
          try { observed = probeEndpoint(endpoint); } catch {}
          const error = new Error('process liveness endpoint の排他取得に失敗しました');
          error.code = observed === 'alive'
            ? 'LIVENESS_ENDPOINT_BUSY'
            : observed === 'unknown'
              ? 'LIVENESS_UNKNOWN'
              : 'LIVENESS_CLAIM_FAILED';
          throw error;
        }
        workerListener = true;
      }
      if (server) server.unref();
      serversByKey.set(value.resourceKey, { ref, server, endpoint, workerListener });
      writeManifest(value, getRuntimeRoot());
    } catch (error) {
      if (server?.listening) {
        try { server.close(); } catch {}
      }
      if (workerListener) {
        try { releaseEndpointSync(value.resourceKey); } catch {}
      }
      serversByKey.delete(value.resourceKey);
      throw error;
    }

    if (!exitCleanupRegistered) {
      exitCleanupRegistered = true;
      process.once('exit', () => {
        for (const { ref: ownedRef, server: ownedServer } of serversByKey.values()) {
          const owned = decodeRef(ownedRef);
          if (ownedServer) {
            try { ownedServer.close(); } catch {}
          }
          try {
            const manifest = readManifestFn(owned.resourceKey, getRuntimeRoot());
            if (manifest && manifest.pid === owned.pid && manifest.instanceId === owned.instanceId) {
              fs.unlinkSync(manifestPath(owned.resourceKey, getRuntimeRoot()));
            }
          } catch { /* crash leftovers are reclaimed from the endpoint state next time */ }
        }
      });
    }
    return ref;
  }

  function release(ref) {
    const value = decodeRef(ref);
    if (!value || value.pid !== process.pid || !value.resourceKey) return false;
    const owned = serversByKey.get(value.resourceKey);
    if (!owned || !sameRef(owned.ref, ref)) return false;
    if (owned.workerListener) {
      const state = releaseEndpointSync(value.resourceKey);
      if (state === 3) {
        const error = new Error(`process liveness endpoint を解放できません: ${value.resourceKey}`);
        error.code = 'LIVENESS_UNKNOWN';
        throw error;
      }
    }
    serversByKey.delete(value.resourceKey);
    if (owned.server) {
      try { owned.server.close(); } catch {}
    }
    try {
      const manifest = readManifestFn(value.resourceKey, getRuntimeRoot());
      if (manifest && manifest.pid === value.pid && manifest.instanceId === value.instanceId) {
        fs.unlinkSync(manifestPath(value.resourceKey, getRuntimeRoot()));
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    return true;
  }

  function readRef(record, format = 'default') {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (format !== 'default' && format !== 'session') throw new Error('invalid process reference format');
    const pid = format === 'session' ? record.sessionPid : record.pid;
    const resourceKey = format === 'session' ? record.sessionResourceKey : record.resourceKey;
    const instanceId = format === 'session' ? record.sessionInstanceId : record.instanceId;
    let normalizedPid;
    try { normalizedPid = validatePid(pid); } catch { return null; }
    const hasResourceKey = resourceKey !== undefined && resourceKey !== null;
    const hasInstanceId = instanceId !== undefined && instanceId !== null;
    if (!hasResourceKey && !hasInstanceId) return encode(normalizedPid, null, null);
    if (!validateResourceKey(resourceKey) || !validateInstanceId(instanceId)) return null;
    return encode(normalizedPid, resourceKey, instanceId);
  }

  function writeRef(record, ref, format = 'default') {
    const value = decodeRef(ref);
    if (!value) throw new Error('invalid process reference');
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid process reference record');
    const result = { ...record };
    if (format === 'session') {
      result.sessionPid = value.pid;
      if (value.resourceKey) {
        result.sessionResourceKey = value.resourceKey;
        result.sessionInstanceId = value.instanceId;
      } else {
        delete result.sessionResourceKey;
        delete result.sessionInstanceId;
      }
      delete result.sessionStartTime;
      return result;
    }
    if (format !== 'default') throw new Error('invalid process reference format');
    result.pid = value.pid;
    if (value.resourceKey) {
      result.resourceKey = value.resourceKey;
      result.instanceId = value.instanceId;
    } else {
      delete result.resourceKey;
      delete result.instanceId;
    }
    return result;
  }

  function sameRef(a, b) {
    const left = decodeRef(a);
    const right = decodeRef(b);
    return Boolean(left && right && left.resourceKey && right.resourceKey
      && left.pid === right.pid
      && left.resourceKey === right.resourceKey
      && left.instanceId === right.instanceId);
  }

  function watchParent(ref, options = {}) {
    if (ref) {
      let consecutiveDead = 0;
      return () => {
        const state = observe(ref);
        if (state === 'alive') {
          consecutiveDead = 0;
          return true;
        }
        if (state === 'unknown') {
          consecutiveDead = 0;
          return true;
        }
        consecutiveDead += 1;
        return consecutiveDead < 3;
      };
    }
    const stream = options.stream || process.stdin;
    let ended = Boolean(stream?.readableEnded || stream?.destroyed || stream?.closed);
    if (stream && !ended && typeof stream.on === 'function') {
      stream.on('end', () => { ended = true; });
      stream.on('close', () => { ended = true; });
      if (typeof stream.resume === 'function') stream.resume();
    }
    return () => !ended;
  }

  return {
    prepareSelf,
    captureSelf,
    captureProcess,
    createProcessRef,
    claim,
    release,
    readRef,
    writeRef,
    observe,
    legacyPidStatus: observeLegacyPid,
    observeResource,
    sameRef,
    watchParent,
  };
}

const liveness = createLiveness();

module.exports = {
  RESOURCE_KEY_ENV,
  INSTANCE_ID_ENV,
  newInstanceId,
  resourceKeyFor,
  createChildLivenessEnv,
  endpointPath,
  manifestPath,
  readManifest,
  legacyPidState,
  legacyPidStatus,
  createLiveness,
  ...liveness,
};
