'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const mod = require('../scripts/shared/ensure-inbox-supervisor');
const { ensureInboxSupervisorRunning } = mod;

function fakeChild() {
  const emitter = new EventEmitter();
  emitter.unref = () => {};
  return emitter;
}

let workspace;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-supervisor-'));
  mod._setSpawn(() => fakeChild());
});

test('ensureInboxSupervisorRunning: detached・windowsHide付きでinbox-supervisor.jsをspawnする', () => {
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, [
    path.join('/abs/scripts', 'inbox-supervisor.js'),
    '--workspace', workspace,
  ]);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.windowsHide, true);
});

test('ensureInboxSupervisorRunning: unrefを呼ぶ（呼び出し元プロセスをブロックしない）', () => {
  let unrefCalled = false;
  mod._setSpawn(() => {
    const c = fakeChild();
    c.unref = () => { unrefCalled = true; };
    return c;
  });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(unrefCalled, true);
});

test('ensureInboxSupervisorRunning: workspace未指定なら何もしない（spawnを呼ばない）', () => {
  let called = false;
  mod._setSpawn(() => { called = true; return fakeChild(); });

  ensureInboxSupervisorRunning({ workspace: null, scriptsPath: '/abs/scripts' });
  assert.equal(called, false);
});

test('ensureInboxSupervisorRunning: scriptsPath未指定なら何もしない（spawnを呼ばない）', () => {
  let called = false;
  mod._setSpawn(() => { called = true; return fakeChild(); });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: null });
  assert.equal(called, false);
});

test('ensureInboxSupervisorRunning: spawnが例外を投げても呼び出し元に伝播しない（best-effort）', () => {
  mod._setSpawn(() => { throw new Error('boom'); });

  assert.doesNotThrow(() => ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }));
});

test('ensureInboxSupervisorRunning: .gh-maestro/inbox-supervisor-autostart.log を作成する', () => {
  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  const logPath = path.join(workspace, '.gh-maestro', 'inbox-supervisor-autostart.log');
  assert.ok(fs.existsSync(logPath));
});
