'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi } = require('../scripts/shared/strip-ansi');

test('stripAnsi: ANSI SGRエスケープシーケンスを取り除き本文と改行を残す', () => {
  const input = '\x1b[36m[gh-maestro]\x1b[0m \x1b[1;31mx setup failed\x1b[0m\n  \x1b[33m! retry\x1b[0m\n';
  assert.equal(stripAnsi(input), '[gh-maestro] x setup failed\n  ! retry\n');
});

test('stripAnsi: nullとundefinedは空文字を返し、通常文字列は変更しない', () => {
  assert.equal(stripAnsi(null), '');
  assert.equal(stripAnsi(undefined), '');
  assert.equal(stripAnsi(''), '');
  assert.equal(stripAnsi('[gh-maestro] main (0m)'), '[gh-maestro] main (0m)');
});
