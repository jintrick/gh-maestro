'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLiveness } = require('../../scripts/shared/process-liveness');
const { killProcessTree } = require('../../scripts/shared/kill-tree');

function readFirstLine(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => finish(new Error('child did not publish its liveness reference')), timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(null, buffer.slice(0, newline));
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`child exited before publishing its liveness reference (code=${code})`));
    const finish = (error, line) => {
      clearTimeout(timeout);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(line);
    };
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('OS liveness resource is alive while its owner runs and dead after forced process-tree exit', { timeout: 15000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-liveness-workspace-'));
  const runtimeRoot = path.join(workspace, '.gh-maestro', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const livenessModule = path.resolve(__dirname, '../../scripts/shared/process-liveness.js');
  const source = [
    `const liveness = require(${JSON.stringify(livenessModule)});`,
    'const ref = liveness.captureSelf({ workspace: process.env.GH_MAESTRO_WORKSPACE, kind: "slow-test", name: "owner" });',
    'process.stdout.write(JSON.stringify({ pid: process.pid, ref }) + "\\n");',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      GH_MAESTRO_RUNTIME_DIR: runtimeRoot,
      GH_MAESTRO_WORKSPACE: workspace,
    },
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const checker = createLiveness({ runtimeRoot: () => runtimeRoot });

  try {
    const childIdentity = JSON.parse(await readFirstLine(child));
    assert.equal(typeof childIdentity.pid, 'number');
    assert.equal(checker.observe(childIdentity.ref), 'alive');

    const startedAt = Date.now();
    const stopped = killProcessTree(child.pid);
    assert.equal(stopped.ok, true, `killProcessTree did not confirm exit: ${JSON.stringify(stopped)}`);

    let state = 'alive';
    while (state === 'alive' && Date.now() - startedAt < 5000) {
      state = checker.observe(childIdentity.ref);
      if (state === 'alive') await sleep(25);
    }
    assert.equal(state, 'dead', `forced exit did not release its endpoint: ${stderr}`);
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { killProcessTree(child.pid); } catch {}
    }
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
