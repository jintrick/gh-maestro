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
    let stderr = '';
    const timeout = setTimeout(() => finish(new Error('child did not publish its liveness reference')), timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(null, buffer.slice(0, newline));
    };
    const onError = (error) => finish(error);
    const onStderr = (chunk) => { stderr += String(chunk); };
    const onExit = (code) => finish(new Error(`child exited before publishing its liveness reference (code=${code}): ${stderr}`));
    const finish = (error, line) => {
      clearTimeout(timeout);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
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

// ── probe worker thread の起動遅延を probe の期限に含めない（PR #658 slow 層の失敗） ──
// 負荷が高いと worker thread の起動だけで数百 ms かかり、最初の probe が unknown になって
// spawn-worker や常駐プロセスの起動が LIVENESS_UNKNOWN で止まっていた。
// 起動を遅らせた worker で、期限 250ms の probe が不在 endpoint を dead と答えることを確かめる。

const { createProbeWorkerClient } = require('../../scripts/shared/process-liveness');
const { createTempDirScope } = require('../../scripts/shared/temp-directory');

const REAL_PROBE_WORKER = path.join(__dirname, '..', '..', 'scripts', 'shared', 'process-liveness-probe-worker.js');
const MISSING_ENDPOINT = process.platform === 'win32'
  ? `\\.\pipe\gh-maestro-test-missing-${process.pid}-${Date.now()}`
  : path.join(os.tmpdir(), `gh-maestro-test-missing-${process.pid}-${Date.now()}.sock`);

function slowStartingWorker(scope, delayMs, { signalReady = true } = {}) {
  const dir = scope.mkdtemp('ghm-slow-probe-worker-');
  const file = path.join(dir, 'worker.js');
  const body = signalReady
    ? `require(${JSON.stringify(REAL_PROBE_WORKER)});`
    : "require('worker_threads').parentPort.on('message', () => {});";
  fs.writeFileSync(file, [
    "'use strict';",
    `const until = Date.now() + ${delayMs};`,
    'while (Date.now() < until) {}',
    body,
  ].join('\n'), 'utf8');
  return file;
}

test('probe: worker thread の起動が probe 期限より遅くても、不在 endpoint を dead と判定する', { timeout: 15000 }, () => {
  const scope = createTempDirScope();
  try {
    const request = createProbeWorkerClient({ workerPath: slowStartingWorker(scope, 800) });
    assert.equal(request({ type: 'probe', endpoint: MISSING_ENDPOINT }, 250), 2);
  } finally {
    scope.cleanup();
  }
});

test('probe: worker thread の起動が上限内に終わらなければ unknown を返し、準備完了後の probe は判定できる', { timeout: 15000 }, () => {
  const scope = createTempDirScope();
  try {
    const request = createProbeWorkerClient({ workerPath: slowStartingWorker(scope, 800), startTimeoutMs: 100 });
    assert.equal(request({ type: 'probe', endpoint: MISSING_ENDPOINT }, 250), 3, '起動未確認のまま判定しない');
    const later = createProbeWorkerClient({ workerPath: slowStartingWorker(scope, 0), startTimeoutMs: 5000 });
    assert.equal(later({ type: 'probe', endpoint: MISSING_ENDPOINT }, 250), 2);
    // 同じ client でも、準備が整えば次のリクエストで判定できる。
    const until = Date.now() + 1500;
    let state = 3;
    while (state === 3 && Date.now() < until) state = request({ type: 'probe', endpoint: MISSING_ENDPOINT }, 250);
    assert.equal(state, 2);
  } finally {
    scope.cleanup();
  }
});

test('probe: 準備完了を通知しない worker では unknown を返す（判定不能を dead にしない）', { timeout: 15000 }, () => {
  const scope = createTempDirScope();
  try {
    const request = createProbeWorkerClient({
      workerPath: slowStartingWorker(scope, 0, { signalReady: false }),
      startTimeoutMs: 300,
    });
    assert.equal(request({ type: 'probe', endpoint: MISSING_ENDPOINT }, 250), 3);
  } finally {
    scope.cleanup();
  }
});
