'use strict';

const net = require('net');
const { parentPort } = require('worker_threads');

const listeners = new Map();
const activeRequests = new Map();
const pendingClaims = new Map();

function stateView(buffer) {
  return new Int32Array(buffer);
}

function finish(shared, state, socket, timer) {
  Atomics.store(shared, 0, state);
  Atomics.notify(shared, 0);
  clearTimeout(timer);
  if (socket) socket.destroy();
}

function probe(endpoint, shared, timeoutMs) {
  let done = false;
  let socket;
  const complete = (state) => {
    if (done) return;
    done = true;
    finish(shared, state, socket, timer);
  };
  const timer = setTimeout(() => complete(3), timeoutMs);
  timer.unref();

  try {
    socket = net.createConnection(endpoint);
    socket.once('connect', () => complete(1));
    socket.once('error', (error) => {
      complete(error && ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 2 : 3);
    });
  } catch {
    complete(3);
  }
}

function closeListener(resourceKey, shared) {
  const server = listeners.get(resourceKey);
  if (!server) {
    Atomics.store(shared, 0, 2);
    Atomics.notify(shared, 0);
    return;
  }
  server.close((error) => {
    if (!error) {
      listeners.delete(resourceKey);
      for (const [requestId, key] of activeRequests) {
        if (key === resourceKey) activeRequests.delete(requestId);
      }
    }
    Atomics.store(shared, 0, error ? 3 : 1);
    Atomics.notify(shared, 0);
  });
}

function cancelClaim(requestId) {
  const pending = pendingClaims.get(requestId);
  if (pending) {
    pending.cancelled = true;
    if (pending.server.listening) {
      pending.server.close(() => {});
      pendingClaims.delete(requestId);
    }
    return;
  }
  const resourceKey = activeRequests.get(requestId);
  if (!resourceKey) return;
  const server = listeners.get(resourceKey);
  activeRequests.delete(requestId);
  if (server) server.close(() => listeners.delete(resourceKey));
}

parentPort.on('message', (message) => {
  const { shared: buffer } = message;
  const shared = stateView(buffer);
  if (message.type === 'probe') {
    probe(message.endpoint, shared, message.timeoutMs);
    return;
  }

  if (message.type === 'release') {
    closeListener(message.resourceKey, shared);
    return;
  }

  if (message.type === 'cancel-claim') {
    cancelClaim(message.requestId);
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
    return;
  }

  if (message.type !== 'claim') return;
  const { endpoint, resourceKey, requestId } = message;
  if (listeners.has(resourceKey)) {
    Atomics.store(shared, 0, 2);
    Atomics.notify(shared, 0);
    return;
  }
  const server = net.createServer((socket) => socket.destroy());
  const pending = { server, cancelled: false };
  pendingClaims.set(requestId, pending);
  server.once('listening', () => {
    if (pending.cancelled) {
      server.close(() => pendingClaims.delete(requestId));
      return;
    }
    pendingClaims.delete(requestId);
    listeners.set(resourceKey, server);
    activeRequests.set(requestId, resourceKey);
    server.unref();
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
  });
  server.once('error', () => {
    pendingClaims.delete(requestId);
    try { server.close(); } catch {}
    Atomics.store(shared, 0, 2);
    Atomics.notify(shared, 0);
  });
  try {
    server.listen(endpoint);
  } catch {
    pendingClaims.delete(requestId);
    Atomics.store(shared, 0, 2);
    Atomics.notify(shared, 0);
  }
});
