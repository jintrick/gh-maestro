'use strict';
// A worker is considered running only when its recorded process is observable.
const processLiveness = require('./process-liveness');
let injectedLiveness = null;
let injectedProbe = null;

function isWorkerAlive(entry, opts = {}) {
  const liveness = injectedLiveness || (opts.readStartTime || injectedProbe
    ? processLiveness.createLiveness({ readStartTime: opts.readStartTime, probePid: injectedProbe })
    : processLiveness);
  const state = liveness.observe(liveness.readRef(entry));
  // Worker delivery preserves the existing stopped-worker behavior when legacy
  // records cannot establish process identity. A PID alone is not proof that
  // the recorded worker is still running.
  return state === 'alive';
}

module.exports = {
  isWorkerAlive,
  _setLiveness: (value) => { injectedLiveness = value; },
  _setProbePid: (value) => { injectedProbe = value; },
};
