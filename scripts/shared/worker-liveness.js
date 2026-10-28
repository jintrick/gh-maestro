'use strict';
// Worker process observations stay tri-state so callers can fail closed when they
// are about to start, resume, or stop a worker.
const processLiveness = require('./process-liveness');
let injectedLiveness = null;
let injectedProbe = null;

function observeWorker(entry, opts = {}) {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return 'unknown';
  const hasPid = entry.pid !== undefined && entry.pid !== null;
  if (!hasPid) return entry.startTime === undefined || entry.startTime === null ? 'dead' : 'unknown';
  const liveness = injectedLiveness || (opts.readStartTime || injectedProbe
    ? processLiveness.createLiveness({ readStartTime: opts.readStartTime, probePid: injectedProbe })
    : processLiveness);
  return liveness.observe(liveness.readRef(entry));
}

function isWorkerAlive(entry, opts = {}) {
  const state = observeWorker(entry, opts);
  if (state === 'unknown') {
    throw new Error('worker process liveness is unknown');
  }
  return state === 'alive';
}

module.exports = {
  observeWorker,
  isWorkerAlive,
  _setLiveness: (value) => { injectedLiveness = value; },
  _setProbePid: (value) => { injectedProbe = value; },
};
