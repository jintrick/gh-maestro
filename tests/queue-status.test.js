'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SEND_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-send.js');
const ACK_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-ack.js');
const STATUS_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-status.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runStatus(args, env = {}) {
  return spawnSync(process.execPath, [STATUS_SCRIPT, ...args], {
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
  const r = runStatus(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-status.js'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = runStatus(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-status.js'));
  assert.equal(r.stderr, '');
});

// ── 空キュー ────────────────────────────────────────────────────────────

test('メッセージがないとき pending=0 delivered=0 stuck=0 と表示', () => {
  withTempDir(workspace => {
    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);

    assert.ok(r.stdout.includes('Pending:    0'));
    assert.ok(r.stdout.includes('Delivered:  0'));
    assert.ok(r.stdout.includes('Stuck:      0'));
  });
});

// ── pending 表示 ────────────────────────────────────────────────────────

test('pending メッセージがあるとき件数と一覧を表示', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'task A', '--workspace', workspace, '--message-id', 'pending-a']);
    runSend(['orchestrator', 'report', '--workspace', workspace, '--message-id', 'pending-b']);

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);

    assert.ok(r.stdout.includes('Pending:    2'));
    assert.ok(r.stdout.includes('pending-a'));
    assert.ok(r.stdout.includes('pending-b'));
    assert.ok(r.stdout.includes('worker-1'));
    assert.ok(r.stdout.includes('orchestrator'));
  });
});

// ── delivered 件数 ──────────────────────────────────────────────────────

test('ack 後に delivered が増える', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'msg', '--workspace', workspace, '--message-id', 'deliver-me']);
    runAck(['deliver-me', '--workspace', workspace]);

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);

    assert.ok(r.stdout.includes('Pending:    0'));
    assert.ok(r.stdout.includes('Delivered:  1'));
  });
});

// ── stuck 表示 ──────────────────────────────────────────────────────────

test('閾値超過の pending が stuck と表示される', () => {
  withTempDir(workspace => {
    // queue.js は enqueue 時に createdAt を現在時刻で設定するため、
    // 直接ファイルを編集して古いタイムスタンプにする
    runSend(['worker-1', 'stuck msg', '--workspace', workspace, '--message-id', 'stuck-id']);

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'stuck-id.json');
    const msg = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));

    // createdAt を閾値より過去に書き換え
    const past = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    msg.createdAt = past;
    fs.writeFileSync(inboxFile, JSON.stringify(msg), 'utf8');

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);

    assert.ok(r.stdout.includes('Stuck:      1'));
    assert.ok(r.stdout.includes('stuck-id'));
    assert.ok(r.stdout.includes('(STUCK)'));
  });
});

// ── 統合シナリオ: enqueue → status → ack → status ──────────────────────

test('enqueue → status → ack → status の一連が動作する', () => {
  withTempDir(workspace => {
    // enqueue
    runSend(['worker-1', 'test', '--workspace', workspace, '--message-id', 'e2e-id']);

    // status: pending 1
    const s1 = runStatus(['--workspace', workspace]);
    assert.ok(s1.stdout.includes('Pending:    1'));

    // ack
    assert.equal(runAck(['e2e-id', '--workspace', workspace]).status, 0);

    // status: pending 0, delivered 1
    const s2 = runStatus(['--workspace', workspace]);
    assert.ok(s2.stdout.includes('Pending:    0'));
    assert.ok(s2.stdout.includes('Delivered:  1'));
  });
});

// ── 壊れたメッセージへの耐性 ───────────────────────────────────────────

test('createdAt がないメッセージがあってもクラッシュしない', () => {
  withTempDir(workspace => {
    // createdAt が欠けたメッセージファイルを直接書き込む
    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'bad-msg.json'), JSON.stringify({
      messageId: 'bad-msg',
      to: 'worker-1',
      from: 'test',
      body: 'no date',
      // createdAt なし
    }), 'utf8');

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('bad-msg'));  // 表示はされる
  });
});

test('messageId がないメッセージがあってもクラッシュしない', () => {
  withTempDir(workspace => {
    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'no-id.json'), JSON.stringify({
      to: 'worker-1',
      from: 'test',
      body: 'no id',
      createdAt: new Date().toISOString(),
      // messageId なし
    }), 'utf8');

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('?'));  // 欠損を示す '?' が表示される
  });
});

// ── stuck 詳細: last-notified 表示 ──────────────────────────────────────

test('poller-state.json があるとき stuck エントリに最終通知時刻が表示される', () => {
  withTempDir(workspace => {
    // stuck な pending を作成
    runSend(['worker-1', 'stuck msg', '--workspace', workspace, '--message-id', 'stuck-notified']);
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'stuck-notified.json');
    const msg = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    const past = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    msg.createdAt = past;
    fs.writeFileSync(inboxFile, JSON.stringify(msg), 'utf8');

    // poller-state.json を作成（最終通知時刻 = 5分前）
    const pollerStatePath = path.join(workspace, '.gh-maestro', 'queue', 'poller-state.json');
    const lastNotifiedTime = Date.now() - 5 * 60 * 1000;
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(pollerStatePath, JSON.stringify({
      lastNotifiedAt: { 'stuck-notified': lastNotifiedTime },
    }), 'utf8');

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);

    assert.ok(r.stdout.includes('(STUCK)'));
    assert.ok(r.stdout.includes('last-notified:'));
    // 最終通知時刻の ISO 文字列が含まれる
    const expectedIso = new Date(lastNotifiedTime).toISOString();
    assert.ok(r.stdout.includes(expectedIso));
  });
});

test('poller-state.json がなくても stuck 表示はクラッシュしない', () => {
  withTempDir(workspace => {
    // stuck な pending を作成（poller-state.json なし）
    runSend(['worker-1', 'stuck msg', '--workspace', workspace, '--message-id', 'stuck-no-state']);
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'stuck-no-state.json');
    const msg = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    const past = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    msg.createdAt = past;
    fs.writeFileSync(inboxFile, JSON.stringify(msg), 'utf8');

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);

    assert.ok(r.stdout.includes('(STUCK)'));
    assert.ok(r.stdout.includes('未通知'));  // poller-state.json がないので未通知
  });
});

test('poller-state.json が壊れていてもクラッシュしない', () => {
  withTempDir(workspace => {
    // stuck な pending を作成
    runSend(['worker-1', 'stuck msg', '--workspace', workspace, '--message-id', 'stuck-corrupt']);
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'stuck-corrupt.json');
    const msg = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    const past = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    msg.createdAt = past;
    fs.writeFileSync(inboxFile, JSON.stringify(msg), 'utf8');

    // 壊れた poller-state.json
    const pollerStatePath = path.join(workspace, '.gh-maestro', 'queue', 'poller-state.json');
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(pollerStatePath, 'this is not json', 'utf8');

    const r = runStatus(['--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('(STUCK)'));
    // 壊れたファイルは無視される
  });
});
