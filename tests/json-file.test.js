'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripUtf8Bom, parseJsonText, readJsonFile } = require('../scripts/shared/json-file');

test('stripUtf8Bom: 先頭のBOMを1つだけ除去する', () => {
  assert.equal(stripUtf8Bom('\uFEFF{"ok":true}'), '{"ok":true}');
  assert.equal(stripUtf8Bom('{"ok":true}'), '{"ok":true}');
  assert.equal(stripUtf8Bom('\uFEFF\uFEFF{}'), '\uFEFF{}');
});

test('parseJsonText: BOM付きJSONを解析できる', () => {
  assert.deepEqual(parseJsonText('\uFEFF{"ok":true}'), { ok: true });
});

test('parseJsonText: 不正JSONはSyntaxErrorとして拒否する', () => {
  assert.throws(() => parseJsonText('\uFEFF{"ok":'), SyntaxError);
});

test('readJsonFile: BOM付きファイルを読み取れる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-file-'));
  try {
    const filePath = path.join(dir, 'external.json');
    fs.writeFileSync(filePath, '\uFEFF{"source":"external"}', 'utf8');
    assert.deepEqual(readJsonFile(filePath), { source: 'external' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonFile: 読み取り失敗を握りつぶさない', () => {
  const filePath = path.join(os.tmpdir(), `json-file-missing-${process.pid}-${Date.now()}.json`);
  assert.throws(() => readJsonFile(filePath), (error) => error && error.code === 'ENOENT');
});
