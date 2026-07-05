'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { enqueue, listPending, ack, pruneAcked } = require('../scripts/queue');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function countJsonFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
}

// ── enqueue ──────────────────────────────────────────────────────────────

test('enqueue が inbox にファイルを作成する', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, { to: 'worker-1', from: 'orchestrator', body: 'hello' });
    assert.ok(result.messageId);
    assert.ok(result.path.endsWith('.json'));

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    assert.ok(fs.existsSync(path.join(inboxDir, `${result.messageId}.json`)));
  });
});

test('enqueue に必須フィールドが欠けていると throw する', () => {
  withTempDir(workspace => {
    assert.throws(() => enqueue(workspace, { from: 'o', body: 'x' }), { message: '"to" is required' });
    assert.throws(() => enqueue(workspace, { to: 'w', body: 'x' }), { message: '"from" is required' });
    assert.throws(() => enqueue(workspace, { to: 'w', from: 'o' }), { message: '"body" is required' });
  });
});

test('enqueue が messageId を自動生成する（形式検証）', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, { to: 'worker-1', from: 'orchestrator', body: 'hello' });
    assert.match(result.messageId, /^\d{8}T\d{9}-[0-9a-f]{6}$/);
  });
});

test('enqueue が指定された messageId をそのまま使う', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, {
      to: 'worker-1',
      from: 'orchestrator',
      body: 'hello',
      messageId: 'my-fixed-id',
    });
    assert.equal(result.messageId, 'my-fixed-id');
  });
});

test('同一 messageId の二重 enqueue で inbox のファイル数が増えない', () => {
  withTempDir(workspace => {
    const msg = { to: 'worker-1', from: 'orchestrator', body: 'hello', messageId: 'dup-id' };
    enqueue(workspace, msg);
    enqueue(workspace, msg);

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    assert.equal(countJsonFiles(inboxDir), 1);
  });
});

test('enqueue 直後の inbox ファイルは常に完全な JSON', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, {
      to: 'worker-1',
      from: 'orchestrator',
      kind: 'instruction',
      body: 'hello world',
    });
    const inboxFile = path.join(
      workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', `${result.messageId}.json`
    );
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.messageId, result.messageId);
    assert.equal(parsed.from, 'orchestrator');
    assert.equal(parsed.to, 'worker-1');
    assert.equal(parsed.kind, 'instruction');
    assert.equal(parsed.body, 'hello world');
    assert.ok(parsed.createdAt);
  });
});

test('kind 省略時は "instruction" がデフォルトになる', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, { to: 'worker-1', from: 'orchestrator', body: 'hello' });
    const inboxFile = path.join(
      workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', `${result.messageId}.json`
    );
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.kind, 'instruction');
  });
});

test('enqueue の戻り値に含まれる path は inbox の絶対パス', () => {
  withTempDir(workspace => {
    const result = enqueue(workspace, { to: 'w', from: 'o', body: 'hello' });
    assert.ok(path.isAbsolute(result.path));
    assert.ok(result.path.includes('inbox'));
    assert.ok(result.path.endsWith(`${result.messageId}.json`));
    assert.ok(fs.existsSync(result.path));
  });
});

// ── listPending ─────────────────────────────────────────────────────────

test('listPending が recipient 指定でその宛先のメッセージだけを返す', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'msg1', messageId: 'id1' });
    enqueue(workspace, { to: 'worker-2', from: 'o', body: 'msg2', messageId: 'id2' });

    const pending = listPending(workspace, 'worker-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].messageId, 'id1');
    assert.equal(pending[0].to, 'worker-1');
  });
});

test('listPending が全 recipient のメッセージを返す', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'msg1', messageId: 'id1' });
    enqueue(workspace, { to: 'worker-2', from: 'o', body: 'msg2', messageId: 'id2' });
    enqueue(workspace, { to: 'orchestrator', from: 'w', body: 'report', messageId: 'id3' });

    const pending = listPending(workspace);
    assert.equal(pending.length, 3);
  });
});

test('listPending が壊れた JSON ファイルをスキップする', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'good', messageId: 'good-id' });

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    fs.writeFileSync(path.join(inboxDir, 'corrupted.json'), 'this is not json', 'utf8');

    const pending = listPending(workspace, 'worker-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].messageId, 'good-id');
  });
});

test('listPending が inbox ディレクトリ不在時に空配列を返す', () => {
  withTempDir(workspace => {
    assert.deepEqual(listPending(workspace, 'nonexistent'), []);
    assert.deepEqual(listPending(workspace), []);
  });
});

// ── ack ─────────────────────────────────────────────────────────────────

test('ack が inbox → acked へ rename する', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'hello', messageId: 'ack-me' });
    const result = ack(workspace, 'ack-me');
    assert.equal(result, true);

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    assert.ok(!fs.existsSync(path.join(inboxDir, 'ack-me.json')));

    const ackedDir = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1');
    assert.ok(fs.existsSync(path.join(ackedDir, 'ack-me.json')));
  });
});

test('二重 ack がエラーにならず true を返す', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'hello', messageId: 'dup-ack' });
    assert.equal(ack(workspace, 'dup-ack'), true);
    assert.equal(ack(workspace, 'dup-ack'), true);
  });
});

test('存在しない messageId の ack は false を返す', () => {
  withTempDir(workspace => {
    assert.equal(ack(workspace, 'nonexistent-id'), false);
  });
});

test('ack が正しい recipient のディレクトリにファイルを移動する', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'm1', messageId: 'id1' });
    enqueue(workspace, { to: 'worker-2', from: 'o', body: 'm2', messageId: 'id2' });

    ack(workspace, 'id1');

    assert.ok(fs.existsSync(path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'id1.json')));
    assert.ok(!fs.existsSync(path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-2', 'id1.json')));

    // worker-2 の pending はそのまま
    assert.ok(fs.existsSync(path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-2', 'id2.json')));
  });
});

// ── pruneAcked ──────────────────────────────────────────────────────────

test('pruneAcked が古い acked ファイルを削除し、削除数を返す', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'old', messageId: 'old-msg' });
    ack(workspace, 'old-msg');

    const ackedFile = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'old-msg.json');
    // Set mtime far enough in the past
    const oldTime = new Date(Date.now() - 100000);
    fs.utimesSync(ackedFile, oldTime, oldTime);

    const deleted = pruneAcked(workspace, 5000);
    assert.equal(deleted, 1);

    assert.ok(!fs.existsSync(ackedFile), 'maxAgeMs を超えた acked ファイルは削除されるべき');
  });
});

test('pruneAcked が新しい acked ファイルを削除せず 0 を返す', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'fresh', messageId: 'fresh-msg' });
    ack(workspace, 'fresh-msg');

    const ackedFile = path.join(workspace, '.gh-maestro', 'queue', 'acked', 'worker-1', 'fresh-msg.json');

    // prune with a very small maxAge — the file was just created so it should survive
    const deleted = pruneAcked(workspace, 5000);
    assert.equal(deleted, 0);

    assert.ok(fs.existsSync(ackedFile), '新しい acked ファイルは削除されないべき');
  });
});

test('pruneAcked が pending（inbox）を削除せず 0 を返す', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'keep', messageId: 'keep-id' });

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'keep-id.json');
    const oldTime = new Date(Date.now() - 100000);
    fs.utimesSync(inboxFile, oldTime, oldTime);

    // acked が存在しない場合でも pruneAcked は graceful に動作する
    const deleted = pruneAcked(workspace, 5000);
    assert.equal(deleted, 0);

    assert.ok(fs.existsSync(inboxFile), 'pending ファイルは削除されないべき');
  });
});

test('pruneAcked が acked ディレクトリ不在時に 0 を返す', () => {
  withTempDir(workspace => {
    // workspace に queue 構造が一切ない状態でもエラーにならず 0 を返す
    const deleted = pruneAcked(workspace, 5000);
    assert.equal(deleted, 0);
  });
});

// ── 統合シナリオ ────────────────────────────────────────────────────────

test('enqueue → listPending → ack → listPending の一連が正しく動作する', () => {
  withTempDir(workspace => {
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'task A', messageId: 'task-a' });
    enqueue(workspace, { to: 'worker-1', from: 'o', body: 'task B', messageId: 'task-b' });
    enqueue(workspace, { to: 'orchestrator', from: 'w', body: 'report', messageId: 'rpt' });

    // worker-1 に 2 件 pending
    assert.equal(listPending(workspace, 'worker-1').length, 2);

    // 全件 pending
    assert.equal(listPending(workspace).length, 3);

    // task-a を ack
    assert.equal(ack(workspace, 'task-a'), true);

    // worker-1 の pending が 1 件に減る
    assert.equal(listPending(workspace, 'worker-1').length, 1);
    assert.equal(listPending(workspace, 'worker-1')[0].messageId, 'task-b');

    // 全件 pending は 2 件
    assert.equal(listPending(workspace).length, 2);
  });
});
