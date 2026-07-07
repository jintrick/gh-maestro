'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateField } = require('../scripts/shared/validate');

// ── 正常系 ─────────────────────────────────────────────────────────────────

test('通常の名前はエラーにならない', () => {
  assert.doesNotThrow(() => validateField('worker', 'issue-45-msg-bus-phase1'));
  assert.doesNotThrow(() => validateField('worker', 'orchestrator'));
  assert.doesNotThrow(() => validateField('worker', 'worker-1'));
  assert.doesNotThrow(() => validateField('worker', 'a'));
  assert.doesNotThrow(() => validateField('worker', 'issue_45_msg'));
});

test('ハイフン・アンダースコア・ドットを含む名前は許可される', () => {
  assert.doesNotThrow(() => validateField('worker', 'issue-45.msg_bus'));
});

// ── 拒否系 ─────────────────────────────────────────────────────────────────

test('親ディレクトリ参照 .. を拒否する', () => {
  assert.throws(() => validateField('self', '../orchestrator'), {
    message: /親ディレクトリ参照/,
  });
});

test('パス区切り / を拒否する', () => {
  assert.throws(() => validateField('self', 'a/b'), {
    message: /不正な文字/,
  });
});

test('パス区切り \\ を拒否する', () => {
  assert.throws(() => validateField('self', 'a\\b'), {
    message: /不正な文字/,
  });
});

test('制御文字を拒否する', () => {
  assert.throws(() => validateField('self', 'a\x00b'), {
    message: /不正な文字/,
  });
});

test('コロンを拒否する', () => {
  assert.throws(() => validateField('self', 'a:b'), {
    message: /不正な文字/,
  });
});

// ── falsy 値 ───────────────────────────────────────────────────────────────

test('空文字はエラーにならない（呼び出し側の責務）', () => {
  assert.doesNotThrow(() => validateField('self', ''));
});

test('undefined はエラーにならない', () => {
  assert.doesNotThrow(() => validateField('self', undefined));
});

test('null はエラーにならない', () => {
  assert.doesNotThrow(() => validateField('self', null));
});
