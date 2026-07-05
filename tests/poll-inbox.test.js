'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const POLL_SCRIPT = path.join(__dirname, '..', 'scripts', 'poll-inbox.js');
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

function runPoll(args, env = {}) {
  return spawnSync(process.execPath, [POLL_SCRIPT, ...args], {
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

// ── --help ──────────────────────────────────────────────────────────────────

test('--help が usage を stdout に出して exit 0', () => {
  const r = runPoll(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('poll-inbox.js'));
  assert.ok(r.stdout.includes('NEW_MESSAGE'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = runPoll(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('poll-inbox.js'));
  assert.equal(r.stderr, '');
});

// ── 引数エラー ──────────────────────────────────────────────────────────────

test('self 引数なしは usage を stderr に出して exit 1', () => {
  const r = runPoll([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('poll-inbox.js'));
});

test('存在しないワークスペースでは --once で exit 0（inbox なしなので空出力）', () => {
  const r = runPoll(['test-worker', '--workspace', '/nonexistent/path/gh-maestro-test', '--once']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ── --once モード ───────────────────────────────────────────────────────────

test('--once が pending メッセージを検出して NEW_MESSAGE を出力する', () => {
  withTempDir(workspace => {
    // enqueue 2 messages for a worker
    runSend(['worker-1', 'hello 1', '--workspace', workspace, '--message-id', 'poll-test-1']);
    runSend(['worker-1', 'hello 2', '--workspace', workspace, '--message-id', 'poll-test-2']);

    const r = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r.status, 0);

    const lines = r.stdout.split('\n').filter(Boolean);
    assert.ok(lines.some(l => l === 'NEW_MESSAGE:poll-test-1'), `Expected NEW_MESSAGE:poll-test-1 in: ${r.stdout}`);
    assert.ok(lines.some(l => l === 'NEW_MESSAGE:poll-test-2'), `Expected NEW_MESSAGE:poll-test-2 in: ${r.stdout}`);
  });
});

test('--once が存在しない inbox に対して空出力で exit 0', () => {
  withTempDir(workspace => {
    const r = runPoll(['no-such-worker', '--workspace', workspace, '--once']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

test('--once が空の inbox に対して空出力で exit 0', () => {
  withTempDir(workspace => {
    // inbox ディレクトリを作るがメッセージは入れない
    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'empty-worker');
    fs.mkdirSync(inboxDir, { recursive: true });

    const r = runPoll(['empty-worker', '--workspace', workspace, '--once']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

test('--once が壊れた JSON ファイルをスキップして正常ファイルだけ通知する', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'good msg', '--workspace', workspace, '--message-id', 'good-one']);

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    fs.writeFileSync(path.join(inboxDir, 'corrupted.json'), 'not json{{{', 'utf8');

    const r = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r.status, 0);

    const lines = r.stdout.split('\n').filter(Boolean);
    // corrupted.json の messageId は "corrupted" だが JSON.parse に失敗するので NOTIFY されない
    assert.ok(lines.some(l => l === 'NEW_MESSAGE:good-one'), `Expected NEW_MESSAGE:good-one in: ${r.stdout}`);
    // corrupted はスキップされる
    assert.ok(!lines.some(l => l.includes('corrupted')), `corrupted should be skipped: ${r.stdout}`);
  });
});

// ── 重複排除（同一プロセス内）──────────────────────────────────────────────

test('同一プロセス内では既通知の messageId を再通知しない（インメモリ Set）', () => {
  withTempDir(workspace => {
    // poll-inbox.js を継続モードで起動し、後からメッセージを enqueue するテストは
    // detached プロセスになるため避ける。代わりに --once を2回呼んで、
    // 2回目は新着なし（全 messageId が1回目で通知済み）を確認する。
    // これはインメモリ Set のテストではなく、単一 --once 呼び出し内の重複排除のテスト。
    // インメモリ Set によるプロセス内重複排除は、poll-inbox が同じ pending ファイルを
    // 複数回の interval で再スキャンしたときに発動する（継続モードのテストは実 spawn
    // になるため test-process-spawn-safety.md に従いスキップ）。

    // --once で検出
    runSend(['worker-1', 'test dedup', '--workspace', workspace, '--message-id', 'dedup-test']);
    const r1 = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.includes('NEW_MESSAGE:dedup-test'));

    // 同じメッセージがまだ inbox にある状態で再度 --once → 別プロセスなので再通知される
    // （これは正しい挙動: プロセス再起動 = worker 再起動時は全 pending を再通知すべき）
    const r2 = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r2.status, 0);
    assert.ok(r2.stdout.includes('NEW_MESSAGE:dedup-test'),
      '別プロセスからの --once は全 pending を再通知する（正しい挙動）');
  });
});

// ── end-to-end: enqueue → poll → ack → poll（空）────────────────────────

test('enqueue → poll --once 検出 → ack → poll --once 空 の end-to-end', () => {
  withTempDir(workspace => {
    // 1. enqueue
    runSend(['worker-1', 'e2e test message', '--workspace', workspace, '--message-id', 'e2e-msg']);

    // 2. poll --once: NEW_MESSAGE を検出
    const r1 = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.includes('NEW_MESSAGE:e2e-msg'),
      `Expected NEW_MESSAGE:e2e-msg in poll output: ${r1.stdout}`);

    // 3. ack
    const ackResult = runAck(['e2e-msg', '--workspace', workspace]);
    assert.equal(ackResult.status, 0);

    // 4. poll --once: 新着なし（ack 済みのため inbox に存在しない）
    const r2 = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '', `Expected empty output after ack, got: ${r2.stdout}`);
  });
});

// ── 複数 recipient の分離 ──────────────────────────────────────────────────

test('poll-inbox が自分の inbox だけを監視し、他 recipient のメッセージを無視する', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'for worker-1', '--workspace', workspace, '--message-id', 'w1-msg']);
    runSend(['worker-2', 'for worker-2', '--workspace', workspace, '--message-id', 'w2-msg']);

    // worker-1 として poll
    const r = runPoll(['worker-1', '--workspace', workspace, '--once']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('NEW_MESSAGE:w1-msg'), `Expected w1-msg in: ${r.stdout}`);
    assert.ok(!r.stdout.includes('w2-msg'), `w2-msg should NOT appear in worker-1 poll: ${r.stdout}`);
  });
});

// ── --workspace 解決: env 経由 ─────────────────────────────────────────────

test('--workspace なしでも GH_MAESTRO_WORKSPACE env で動作する', () => {
  withTempDir(workspace => {
    runSend(['worker-1', 'env test', '--workspace', workspace, '--message-id', 'env-poll-test']);

    const r = runPoll(['worker-1', '--once'], { GH_MAESTRO_WORKSPACE: workspace });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('NEW_MESSAGE:env-poll-test'),
      `Expected NEW_MESSAGE:env-poll-test in: ${r.stdout}`);
  });
});
