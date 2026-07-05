'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SEND_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-send.js');
const ACK_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-ack.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSend(args, env = {}) {
  return spawnSync(process.execPath, [SEND_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runAck(args, env = {}) {
  return spawnSync(process.execPath, [ACK_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ── --help ──────────────────────────────────────────────────────────────

test('--help が usage を stdout に出して exit 0', () => {
  const r = runAck(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-ack.js'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = runAck(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-ack.js'));
  assert.equal(r.stderr, '');
});

// ── 引数エラー ──────────────────────────────────────────────────────────

test('messageId なしは stderr に usage を出して exit 1', () => {
  const r = runAck([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('queue-ack.js'));
});

test('存在しない messageId は "not found" を stderr に出して exit 1', () => {
  withTempDir(workspace => {
    const r = runAck(['nonexistent-id', '--workspace', workspace]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('見つかりません'));
  });
});

// ── 正常 ack ────────────────────────────────────────────────────────────

test('既存メッセージの ack が成功して exit 0', () => {
  withTempDir(workspace => {
    const send = runSend(['worker-1', 'ack me', '--workspace', workspace, '--message-id', 'test-ack-1']);
    assert.equal(send.status, 0);

    const r = runAck(['test-ack-1', '--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');

    // inbox から消えている
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'test-ack-1.json');
    assert.ok(!fs.existsSync(inboxFile));

    // acked に移動している
    const ackedFile = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'test-ack-1.json');
    assert.ok(fs.existsSync(ackedFile));
  });
});

test('二重 ack が冪等で exit 0', () => {
  withTempDir(workspace => {
    const send = runSend(['worker-1', 'double ack', '--workspace', workspace, '--message-id', 'dup-ack']);
    assert.equal(send.status, 0);

    assert.equal(runAck(['dup-ack', '--workspace', workspace]).status, 0);
    assert.equal(runAck(['dup-ack', '--workspace', workspace]).status, 0);
  });
});

test('複数 inbox から正しいメッセージを ack できる', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'msg1', '--workspace', workspace, '--message-id', 'id1']);
    runSend(['worker-2', 'msg2', '--workspace', workspace, '--message-id', 'id2']);

    // worker-2 のメッセージを ack
    assert.equal(runAck(['id2', '--workspace', workspace]).status, 0);

    // worker-1 の pending は残っている
    const inbox1 = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'id1.json');
    assert.ok(fs.existsSync(inbox1));

    // worker-2 の pending は ack 済み
    const inbox2 = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-2', 'id2.json');
    assert.ok(!fs.existsSync(inbox2));
  });
});

// ── --workspace なし（env 経由） ─────────────────────────────────────────

test('--workspace なしでも GH_MAESTRO_WORKSPACE env で ack できる', () => {
  withTempDir(workspace => {
    const send = runSend(['worker-1', 'env ack', '--workspace', workspace, '--message-id', 'env-ack-id']);
    assert.equal(send.status, 0);

    // --workspace の代わりに env で渡す
    const r = runAck(['env-ack-id'], { GH_MAESTRO_WORKSPACE: workspace });
    assert.equal(r.status, 0);

    const ackedFile = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'env-ack-id.json');
    assert.ok(fs.existsSync(ackedFile));
  });
});
