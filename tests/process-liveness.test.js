'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDirScope } = require('../scripts/shared/temp-directory');
const processLiveness = require('../scripts/shared/process-liveness');

const resource = { workspace: 'C:/isolated/workspace', kind: 'worker', name: 'worker-a' };
const resourceKey = processLiveness.resourceKeyFor(resource);
const instanceId = 'instance-generation-1';

function makeLiveness({ endpointState = 'alive', manifest = null, killState = 'present' } = {}) {
  const endpoints = [];
  const state = { endpointState, manifest: manifest || {
    schemaVersion: 2, resourceKey, instanceId, pid: 123,
  }, killState };
  const api = processLiveness.createLiveness({
    useRealResources: false,
    probeEndpoint: (endpoint) => { endpoints.push(endpoint); return state.endpointState; },
    readManifest: () => state.manifest,
    kill: (_pid, _signal) => {
      if (state.killState === 'dead') {
        const error = new Error('not found');
        error.code = 'ESRCH';
        throw error;
      }
      if (state.killState === 'unknown') {
        const error = new Error('not permitted');
        error.code = 'EPERM';
        throw error;
      }
    },
  });
  return { api, endpoints, state };
}

test('resource keys deterministically include workspace, kind, and name', () => {
  const original = processLiveness.resourceKeyFor(resource);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(processLiveness.resourceKeyFor(resource), original);
  assert.notEqual(processLiveness.resourceKeyFor({ ...resource, workspace: 'C:/isolated/other' }), original);
  assert.notEqual(processLiveness.resourceKeyFor({ ...resource, kind: 'resident' }), original);
  assert.notEqual(processLiveness.resourceKeyFor({ ...resource, name: 'worker-b' }), original);
  assert.match(processLiveness.endpointPath(original, 'C:/isolated/runtime'), /gh-maestro-/);
});

test('observe uses deterministic endpoint and instance metadata for alive, dead, and unknown', () => {
  const { api, endpoints, state } = makeLiveness();
  const ref = api.captureProcess(123, { resourceKey, instanceId });
  assert.equal(api.observe(ref), 'alive');
  assert.equal(endpoints.length, 1);
  assert.match(endpoints[0], /gh-maestro-/);

  state.endpointState = 'dead';
  assert.equal(api.observe(ref), 'dead');
  state.endpointState = 'unknown';
  assert.equal(api.observe(ref), 'unknown');
});

test('a different endpoint generation makes an old reference dead', () => {
  const { api, state } = makeLiveness({ manifest: {
    schemaVersion: 2, resourceKey, instanceId: 'instance-generation-2', pid: 456,
  } });
  assert.equal(api.observe(api.captureProcess(123, { resourceKey, instanceId })), 'dead');
});

function captureStderr(fn) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try { fn(); } finally { process.stderr.write = original; }
  return lines;
}

test('endpointless PR1 records are holderless: dead without querying the PID, whatever the PID state', () => {
  const { api, endpoints, state } = makeLiveness({ endpointState: 'alive', killState: 'present' });
  let kills = 0;
  const counting = processLiveness.createLiveness({
    useRealResources: false,
    probeEndpoint: (endpoint) => { endpoints.push(endpoint); return state.endpointState; },
    readManifest: () => state.manifest,
    kill: () => { kills += 1; },
  });
  for (const checker of [api, counting]) {
    const legacy = checker.readRef({ pid: process.pid, startTime: '2025-01-01T00:00:00Z' }, 'default',
      { source: `test-holderless-${Math.random()}` });
    captureStderr(() => assert.equal(checker.observe(legacy), 'dead'));
    assert.equal(checker.sameRef(legacy, legacy), false);
  }
  assert.equal(endpoints.length, 0, 'legacy records do not invent a deterministic endpoint');
  assert.equal(kills, 0, 'legacy records never query the PID');
});

test('holderless records are reported once per source with the source path', () => {
  const { api } = makeLiveness();
  const source = `C:/tmp/leases/test-${process.pid}-${Date.now()}.json`;
  const other = `${source}.other`;
  const lines = captureStderr(() => {
    for (let i = 0; i < 3; i++) api.observe(api.readRef({ pid: 4242 }, 'default', { source }));
    api.observe(api.readRef({ pid: 4243 }, 'default', { source: other }));
  });
  assert.equal(lines.filter((line) => line.includes(source) && !line.includes('.other')).length, 1);
  assert.equal(lines.filter((line) => line.includes(other)).length, 1);
  assert.ok(lines.every((line) => /旧形式の記録を持ち主なしとして扱いました/.test(line)));
});

test('holderless report collection deduplicates sources and restores normal reporting when stopped', () => {
  const { api } = makeLiveness();
  const source = `C:/tmp/sweep-holderless-${process.pid}-${Date.now()}.json`;
  const reports = processLiveness.collectHolderlessReports();
  const during = captureStderr(() => {
    api.observe(api.readRef({ pid: 4242 }, 'default', { source }));
    api.observe(api.readRef({ pid: 4243 }, 'default', { source }));
  });
  assert.deepEqual(during, [], 'collection suppresses per-record stderr output');
  assert.deepEqual(reports.sources(), [source]);
  reports.stop();

  const after = captureStderr(() => api.observe(api.readRef({ pid: 4244 }, 'default', { source })));
  assert.equal(after.length, 1, 'normal once-per-source reporting resumes after stop');
});

test('corrupt process records stay unknown and are not treated as holderless', () => {
  const { api } = makeLiveness();
  const lines = captureStderr(() => {
    for (const record of [
      { pid: 'x' },
      { pid: 0 },
      { pid: 4242, resourceKey },
      { pid: 4242, instanceId },
      { pid: 4242, resourceKey: 'not-hex', instanceId },
    ]) {
      const ref = api.readRef(record, 'default', { source: 'corrupt-record' });
      assert.equal(ref, null, JSON.stringify(record));
      assert.equal(api.observe(ref), 'unknown', JSON.stringify(record));
    }
    assert.equal(api.readRef(null), null);
    assert.equal(api.readRef([1]), null);
  });
  assert.deepEqual(lines, []);
});

test('reference serialization carries resource key and instance ID while preserving domain timestamps', () => {
  const { api } = makeLiveness();
  const ref = api.captureProcess(123, { resourceKey, instanceId });
  const record = api.writeRef({ purpose: 'worker', startTime: 'domain timestamp' }, ref);
  assert.deepEqual(record, {
    purpose: 'worker', startTime: 'domain timestamp', pid: 123, resourceKey, instanceId,
  });
  assert.equal(api.sameRef(ref, api.readRef(record)), true);
  assert.equal(api.sameRef(ref, api.readRef({ pid: 123, resourceKey, instanceId: 'other' })), false);
  assert.equal(api.sameRef(ref, api.readRef({ pid: 124, resourceKey, instanceId })), false);

  const sessionRecord = api.writeRef({ issue: 7 }, ref, 'session');
  assert.deepEqual(sessionRecord, { issue: 7, sessionPid: 123, sessionResourceKey: resourceKey, sessionInstanceId: instanceId });
  assert.equal(api.sameRef(ref, api.readRef(sessionRecord, 'session')), true);
  assert.equal(api.readRef({ pid: 123, resourceKey }), null, 'partial endpoint metadata is invalid');
  assert.throws(() => api.writeRef({}, 'invalid'));
  assert.throws(() => api.writeRef({}, ref, 'unsupported'));
});

test('watchParent retains the three-dead observation barrier and unknown grace', () => {
  const { api, state } = makeLiveness();
  const check = api.watchParent(api.captureProcess(123, { resourceKey, instanceId }));
  state.endpointState = 'dead';
  assert.equal(check(), true);
  assert.equal(check(), true);
  assert.equal(check(), false);
  state.endpointState = 'unknown';
  assert.equal(check(), true);
});

test('watchParent without a reference observes stdin EOF or close', () => {
  const stream = new EventEmitter();
  stream.readableEnded = false;
  stream.destroyed = false;
  let resumed = false;
  stream.resume = () => { resumed = true; };
  const api = processLiveness.createLiveness({ useRealResources: false });
  const watch = api.watchParent(undefined, { stream });
  assert.equal(resumed, true);
  assert.equal(watch(), true);
  stream.emit('end');
  assert.equal(watch(), false);

  const closedStream = new EventEmitter();
  closedStream.resume = () => {};
  const watchClosed = api.watchParent(null, { stream: closedStream });
  closedStream.emit('close');
  assert.equal(watchClosed(), false);
});

test('PID validation and legacy parsing reject malformed identifiers without probing endpoints', () => {
  const { api, endpoints } = makeLiveness();
  for (const pid of [true, false, '', ' ', null, {}, 1.5, 0, -1]) {
    assert.throws(() => api.captureProcess(pid, { resourceKey, instanceId }), /invalid process identifier/);
    assert.equal(api.readRef({ pid, resourceKey, instanceId }), null);
  }
  assert.equal(api.observe('invalid'), 'unknown');
  assert.equal(endpoints.length, 0);
});

test('a live endpoint with missing instance metadata is unknown', () => {
  const { api, state } = makeLiveness();
  state.manifest = null;
  assert.equal(api.observe(api.captureProcess(123, { resourceKey, instanceId })), 'unknown');
});

test('a corrupt manifest is reported while its endpoint is live', () => {
  const corrupt = new Error('corrupt process liveness manifest');
  corrupt.code = 'LIVENESS_CORRUPT';
  const api = processLiveness.createLiveness({
    useRealResources: false,
    probeEndpoint: () => 'alive',
    readManifest: () => { throw corrupt; },
  });

  assert.throws(() => api.observe(api.captureProcess(123, { resourceKey, instanceId })), (error) => error === corrupt);
});

test('a manifest of any format is overwritten when its deterministic endpoint is dead', () => {
  const tempDirScope = createTempDirScope();
  const runtimeRoot = tempDirScope.mkdtemp('gh-maestro-liveness-manifest-');
  const manifest = processLiveness.manifestPath(resourceKey, runtimeRoot);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, '{corrupt legacy residue');
  let server;
  const api = processLiveness.createLiveness({
    useRealResources: true,
    runtimeRoot: () => runtimeRoot,
    probeEndpoint: () => 'dead',
    createServer: () => {
      server = new EventEmitter();
      server.listen = () => { server.listening = true; };
      server.unref = () => {};
      server.close = () => { server.listening = false; };
      return server;
    },
  });
  const ref = api.captureProcess(process.pid, { resourceKey, instanceId });

  try {
    assert.equal(api.claim(ref), ref);
    assert.equal(server.listening, true);
    assert.deepEqual(processLiveness.readManifest(resourceKey, runtimeRoot), {
      schemaVersion: 2,
      resourceKey,
      instanceId,
      pid: process.pid,
    });
    assert.equal(api.release(ref), true);
  } finally {
    if (server?.listening) server.close();
    tempDirScope.cleanup();
  }
});

test('the synchronous resource claim owns and releases a real OS endpoint', () => {
  const tempDirScope = createTempDirScope();
  const workspace = tempDirScope.mkdtemp('gh-maestro-liveness-owner-');
  const runtimeRoot = tempDirScope.mkdtemp('gh-maestro-liveness-runtime-');
  const identity = { workspace, kind: 'test-resident', name: 'listener-worker' };
  const owner = processLiveness.createLiveness({ runtimeRoot: () => runtimeRoot });
  const observer = processLiveness.createLiveness({ runtimeRoot: () => runtimeRoot });
  const ownerRef = owner.prepareSelf(identity);
  const competingRef = observer.createProcessRef(process.pid, {
    ...identity,
    instanceId: 'competing-instance',
  });
  let claimed = false;

  try {
    assert.equal(owner.claim(ownerRef), ownerRef);
    claimed = true;
    assert.equal(owner.observeResource(identity).state, 'alive');
    assert.throws(() => observer.claim(competingRef), (error) => error.code === 'LIVENESS_ENDPOINT_BUSY');
    assert.equal(owner.release(ownerRef), true);
    claimed = false;
    assert.equal(observer.observeResource(identity).state, 'dead');
    assert.equal(observer.claim(competingRef), competingRef);
    claimed = true;
    assert.equal(observer.release(competingRef), true);
    claimed = false;
  } finally {
    if (claimed) owner.release(ownerRef);
    tempDirScope.cleanup();
  }
});
