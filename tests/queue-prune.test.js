'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SEND_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-send.js');
const ACK_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-ack.js');
const PRUNE_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-prune.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runPrune(args, env = {}) {
  return spawnSync(process.execPath, [PRUNE_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runSend(args, env = {}) {
  return spawnSync(process.execPath, [SEND_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', ...env },
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
  const r = runPrune(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-prune.js'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = runPrune(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-prune.js'));
  assert.equal(r.stderr, '');
});

// ── 引数エラー ──────────────────────────────────────────────────────────

test('--max-age に無効な値で exit 1', () => {
  withTempDir(workspace => {
    const r = runPrune(['--workspace', workspace, '--max-age', 'abc']);
    assert.equal(r.status, 1);
  });
});

test('--max-age に負の値で exit 1', () => {
  withTempDir(workspace => {
    const r = runPrune(['--workspace', workspace, '--max-age', '-1']);
    assert.equal(r.status, 1);
  });
});

// ── 空キュー ────────────────────────────────────────────────────────────

test('acked がないとき pruned: 0 と表示', () => {
  withTempDir(workspace => {
    const r = runPrune(['--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('pruned: 0'));
  });
});

// ── 通常 prune ──────────────────────────────────────────────────────────

test('古い acked メッセージが prune される', () => {
  withTempDir(workspace => {
    // enqueue → ack
    runSend(['worker-1', 'old msg', '--workspace', workspace, '--message-id', 'old-prune']);
    runAck(['old-prune', '--workspace', workspace]);

    const ackedFile = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'old-prune.json');
    assert.ok(fs.existsSync(ackedFile), 'acked ファイルが存在するべき');

    // mtime を過去に設定
    const oldTime = new Date(Date.now() - 100000);
    fs.utimesSync(ackedFile, oldTime, oldTime);

    // max-age=0.001h (3.6秒) で prune → 古いファイルが消える
    const r = runPrune(['--workspace', workspace, '--max-age', '0.001']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('pruned: 1'));

    assert.ok(!fs.existsSync(ackedFile), '古い acked ファイルは削除されるべき');
  });
});

test('新しい acked メッセージは prune されない', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'fresh msg', '--workspace', workspace, '--message-id', 'fresh-prune']);
    runAck(['fresh-prune', '--workspace', workspace]);

    const ackedFile = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'fresh-prune.json');

    // 既定の 24h max-age で prune → 新しいファイルは残る
    const r = runPrune(['--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('pruned: 0'));

    assert.ok(fs.existsSync(ackedFile), '新しい acked ファイルは残るべき');
  });
});

// ── pending 非干渉 ──────────────────────────────────────────────────────

test('prune が pending（inbox）を削除しない', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'keep me', '--workspace', workspace, '--message-id', 'keep-pending']);

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'keep-pending.json');
    assert.ok(fs.existsSync(inboxFile));

    const r = runPrune(['--workspace', workspace, '--max-age', '0']);
    assert.equal(r.status, 0);

    assert.ok(fs.existsSync(inboxFile), 'pending ファイルは残るべき');
  });
});

// ── 存在しない workspace ────────────────────────────────────────────────

test('queue 構造がない workspace でもエラーにならない', () => {
  withTempDir(workspace => {
    const r = runPrune(['--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('pruned: 0'));
  });
});
