'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// resident-parent-death.js — dead-man's switch 検出時の共通終了前処理（Issue #301）
// 実 worker-lease を使って lease 解放の前後を検証する。実プロセスは spawn しない
// （liveness 判定は注入でモックする）。

const { handleParentSessionDeath } = require('../scripts/shared/resident-parent-death');
const lease = require('../scripts/shared/worker-lease');
const { MSGPOLL_ORCHESTRATOR_ROLE } = lease;

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resident-parent-death-'));
}

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines.join('');
}

// acquireResidentLease / isResidentLeaseLive が WMI（execSync）を呼ばないよう、
// process-lifecycle 系の生存判定を注入でモックする（worker-lease.test.js の
// mockLiveness と同型）。
function mockLiveness() {
  lease._setIsProcessAlive(() => true);
  lease._setVerifyProcessIdentity(() => ({ match: true }));
  lease._setGetProcessStartTime((pid) => '2026-07-29T00:00:00.000Z');
}

test('handleParentSessionDeath: 自PIDのrole leaseを解放し、stderrに理由を出力する', () => {
  const workspace = tmpWorkspace();
  try {
    mockLiveness();
    const res = lease.acquireResidentLease({ workspace, role: MSGPOLL_ORCHESTRATOR_ROLE });
    assert.equal(res.acquired, true);
    assert.equal(lease.isResidentLeaseLive({ workspace, role: MSGPOLL_ORCHESTRATOR_ROLE }), true);

    const stderr = captureStderr(() => {
      handleParentSessionDeath({ workspace, scriptName: 'msg-poll.js', role: MSGPOLL_ORCHESTRATOR_ROLE, sessionPid: 1234 });
    });

    // 自PIDの role lease が解放されている（受け入れ条件: dead-man's switch 経路で lease 解放）
    assert.equal(lease.isResidentLeaseLive({ workspace, role: MSGPOLL_ORCHESTRATOR_ROLE }), false);
    // 終了理由が stderr に出ている（沈黙しない）
    assert.match(stderr, /msg-poll\.js: parent session \(pid 1234\) is dead — exiting/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('handleParentSessionDeath: 他プロセス所有のrole leaseは削除しない（拒否側）', () => {
  const workspace = tmpWorkspace();
  const leaseFile = path.join(workspace, '.gh-maestro', 'leases', 'resident-role-msgpoll-orchestrator.json');
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
  // 他プロセス（pid 99999）所有の lease を直接作成
  fs.writeFileSync(leaseFile, JSON.stringify({ pid: 99999, startTime: '2025-06-01T12:00:00.000Z' }), 'utf8');

  captureStderr(() => {
    handleParentSessionDeath({ workspace, scriptName: 'msg-poll.js', role: MSGPOLL_ORCHESTRATOR_ROLE, sessionPid: 1234 });
  });

  // releaseResidentLease の pid 照合（releaseLease: existing.pid === pid のみ削除）で守られる
  assert.ok(fs.existsSync(leaseFile), '他プロセス所有の lease は削除されない');
  const stored = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  assert.equal(stored.pid, 99999);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('handleParentSessionDeath: leaseが無い状態でも throw しない（best-effort）', () => {
  const workspace = tmpWorkspace();
  assert.doesNotThrow(() => {
    captureStderr(() => {
      handleParentSessionDeath({ workspace, scriptName: 'worker-supervisor.js', role: 'worker-supervisor', sessionPid: 5678 });
    });
  });
  fs.rmSync(workspace, { recursive: true, force: true });
});
