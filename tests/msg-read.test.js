'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgRead = require('../scripts/msg-read');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── --help / -h ────────────────────────────────────────────────────────────

test('--help が usage を返して code 0', () => {
  const r = msgRead.main(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-read.js'));
  assert.equal(r.errLines.length, 0);
});

test('-h が usage を返して code 0', () => {
  const r = msgRead.main(['-h']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-read.js'));
  assert.equal(r.errLines.length, 0);
});

// ── 引数エラー ──────────────────────────────────────────────────────────────

test('commentId なしは code 1', () => {
  const r = msgRead.main([]);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.join('\n').includes('msg-read.js'));
});

test('余剰な位置引数は code 1（黙って無視しない）', () => {
  const r = msgRead.main(['123', 'extra']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('予期しない位置引数')));
});

test('未知のフラグは code 1（黙って無視しない）', () => {
  const r = msgRead.main(['123', '--bogus']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('未知のフラグ')));
});

test('単独の未知フラグは commentId として受理されず code 1', () => {
  const r = msgRead.main(['--bogus']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('未知のフラグ')));
});

// ── stripMarker ─────────────────────────────────────────────────────────────

test('stripMarker がマーカー行を除去する', () => {
  const body = '<!-- gh-maestro {"v":1,"to":"worker","from":"orchestrator"} -->\nHello world';
  assert.equal(msgRead.stripMarker(body), 'Hello world');
});

test('stripMarker がマーカーなしの本文をそのまま返す', () => {
  const body = 'Just a normal message';
  assert.equal(msgRead.stripMarker(body), 'Just a normal message');
});

test('stripMarker が空文字列をそのまま返す', () => {
  assert.equal(msgRead.stripMarker(''), '');
});

test('stripMarker が空白を含むマーカーも除去する', () => {
  const body = '<!--  gh-maestro  {"v":1,"to":"x","from":"y"}  -->\nThe real body';
  assert.equal(msgRead.stripMarker(body), 'The real body');
});

test('stripMarker が通常の HTML コメントは除去しない', () => {
  const body = '<!-- regular comment -->\nbody text';
  assert.equal(msgRead.stripMarker(body), '<!-- regular comment -->\nbody text');
});

// ── メイン ──────────────────────────────────────────────────────────────────

test('成功時に本文を出力して code 0', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment(() => ({
      status: 0,
      stdout: '<!-- gh-maestro {"v":1,"to":"worker","from":"orchestrator"} -->\nHello from orchestrator',
    }));

    const r = msgRead.main(['123456789', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'Hello from orchestrator');
  });
});

test('マーカーなし本文はそのまま出力される', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment(() => ({
      status: 0,
      stdout: 'Plain comment without marker',
    }));

    const r = msgRead.main(['123456789', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'Plain comment without marker');
  });
});

test('gh api 失敗時に code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment(() => ({
      status: 1,
      stderr: 'gh: Not Found',
    }));

    const r = msgRead.main(['999999999', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメントの読み出しに失敗')));
  });
});

test('repo 解決失敗時に code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 1, stderr: 'gh: command not found' }));

    const r = msgRead.main(['123456789', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('リポジトリを解決できません')));
  });
});
