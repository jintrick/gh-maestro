'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { killProcessTree } = require('../../scripts/shared/kill-tree');
const { cleanSpawnEnv } = require('../_spawn-env');

const PROCESS_LIVENESS_PATH = require.resolve('../../scripts/shared/process-liveness');

function startLivenessOwner({ workspace, runtimeRoot, kind, name, withChild = false }) {
  const recordPath = path.join(os.tmpdir(), `ghm-liveness-owner-${process.pid}-${randomUUID()}.json`);
  const source = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const liveness = require(${JSON.stringify(PROCESS_LIVENESS_PATH)});`,
    `const withChild = ${withChild ? 'true' : 'false'};`,
    'const ref = liveness.captureSelf({',
    '  workspace: process.env.GH_MAESTRO_WORKSPACE,',
    '  kind: process.env.GHM_TEST_LIVENESS_KIND,',
    '  name: process.env.GHM_TEST_LIVENESS_NAME,',
    '});',
    'let childPid = null;',
    "if (withChild) { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); childPid = child.pid; child.unref(); }",
    `fs.writeFileSync(process.env.GHM_TEST_LIVENESS_RECORD, JSON.stringify({ ...liveness.writeRef({}, ref), childPid }), 'utf8');`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const env = {
    ...cleanSpawnEnv(),
    GH_MAESTRO_WORKSPACE: workspace,
    GH_MAESTRO_RUNTIME_DIR: runtimeRoot,
    GHM_TEST_LIVENESS_KIND: kind,
    GHM_TEST_LIVENESS_NAME: name,
    GHM_TEST_LIVENESS_RECORD: recordPath,
  };
  const child = spawn(process.execPath, ['-e', source], {
    cwd: workspace,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });

  const deadline = Date.now() + 10000;
  while (!fs.existsSync(recordPath) && Date.now() < deadline && child.exitCode === null) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!fs.existsSync(recordPath)) {
    try { child.kill(); } catch {}
    throw new Error(`liveness owner failed to publish its record (pid=${child.pid}, exit=${child.exitCode})`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  fs.unlinkSync(recordPath);
  return { child, record, childPid: record.childPid };
}

function stopLivenessOwner(owner) {
  if (!owner || !Number.isInteger(owner.child?.pid) || owner.child.exitCode !== null) return;
  const result = killProcessTree(owner.child.pid);
  if (!result.ok) throw new Error(`liveness owner did not stop: ${JSON.stringify(result)}`);
}

function waitForLivenessOwnerExit(owner, timeoutMs = 5000) {
  const child = owner?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`liveness owner process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

module.exports = { startLivenessOwner, stopLivenessOwner, waitForLivenessOwnerExit };
