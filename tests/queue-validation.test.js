'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { enqueue, listPending, ack } = require('../scripts/queue');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── to（recipient）の検証 ──────────────────────────────────────────────

test('enqueue: パス区切り（/）を含む to を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: 'worker/1', from: 'o', body: 'test' }),
      { message: /不正な文字/ }
    );
  });
});

test('enqueue: パス区切り（\\）を含む to を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: 'worker\\1', from: 'o', body: 'test' }),
      { message: /不正な文字/ }
    );
  });
});

test('enqueue: 親ディレクトリ参照（..）を含む to を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: '..\\outside', from: 'o', body: 'test' }),
      { message: /親ディレクトリ/ }
    );
  });
});

test('enqueue: 親ディレクトリ参照（../）を含む to を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: '../outside', from: 'o', body: 'test' }),
      { message: /親ディレクトリ/ }
    );
  });
});

test('enqueue: 不正なファイル名文字（:）を含む to を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: 'worker:1', from: 'o', body: 'test' }),
      { message: /不正な文字/ }
    );
  });
});

// ── messageId の検証 ────────────────────────────────────────────────────

test('enqueue: パス区切りを含む messageId を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: 'w', from: 'o', body: 'test', messageId: 'bad/id' }),
      { message: /不正な文字/ }
    );
  });
});

test('enqueue: .. が途中にある messageId は許可する', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, { to: 'w', from: 'o', body: 'test', messageId: 'bad..id' });
    assert.equal(result.messageId, 'bad..id');
  });
});

test('enqueue: parent reference .. を含む messageId を拒否する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => enqueue(workspace, { to: 'w', from: 'o', body: 'test', messageId: '../id' }),
      { message: /親ディレクトリ/ }
    );
  });
});

test('enqueue: 正常な to と messageId は通す', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, { to: 'worker-1', from: 'o', body: 'test', messageId: 'valid-id' });
    assert.equal(result.messageId, 'valid-id');
  });
});

// ── 重複 messageId 検出 ────────────────────────────────────────────────

test('enqueue: 同一 messageId を別の受信者に送るとエラー', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'first', messageId: 'dup-id' });

    assert.throws(
      () => enqueue(workspace, { to: 'worker-2', from: 'o', body: 'second', messageId: 'dup-id' }),
      { message: /既に受信者/ }
    );
  });
});

test('enqueue: 同一 messageId を同じ受信者に送ると上書き（エラーにならない）', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'first', messageId: 'same-id' });
    // 同じ受信者への同一 messageId は上書きされる（同じ相手なら冪等）
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'second', messageId: 'same-id' });

    const pending = listPending(workspace, 'worker-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].body, 'second'); // 後勝ち
  });
});

test('enqueue: 重複 messageId が ack の誤対象を生まない（別受信者で防がれる）', () => {
  withTempDir(workspace => {
    // worker-1 にメッセージを送る
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'msg1', messageId: 'id1' });

    // worker-2 に同じ messageId で送ろうとすると拒否される
    assert.throws(
      () => enqueue(workspace, { to: 'worker-2', from: 'o', body: 'msg2', messageId: 'id1' }),
      { message: /既に受信者/ }
    );

    // ack で正しいメッセージだけが対象になる
    assert.equal(ack(workspace, 'id1'), true);
    assert.equal(listPending(workspace).length, 0);
  });
});
