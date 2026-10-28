'use strict';
// A worker is considered running only when its recorded process is observable.
const processLiveness = require('./process-liveness');
let injectedLiveness = null;
let injectedProbe = null;

function isWorkerAlive(entry, opts = {}) {
  const liveness = injectedLiveness || (opts.readStartTime || injectedProbe
    ? processLiveness.createLiveness({ readStartTime: opts.readStartTime, probePid: injectedProbe })
    : processLiveness);
  return liveness.observe(liveness.readRef(entry)) === 'alive';
}

module.exports = {
  isWorkerAlive,
  _setLiveness: (value) => { injectedLiveness = value; },
  _setProbePid: (value) => { injectedProbe = value; },
};
