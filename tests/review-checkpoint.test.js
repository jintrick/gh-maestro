'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const checkpoint = require('../scripts/shared/review-checkpoint');
const validate = value => ({ valid: !!value && Array.isArray(value.jobs) });
const manifest = { pr: 11, repo: 'o/r', headRefOid: 'abc', jobs: [{ id: 'a', leaf_ids: ['x'] }] };

test('review checkpoints preserve prior runs and restore completed jobs and attempts', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-checkpoint-'));
  try {
    assert.equal(checkpoint.load(ws, 11, validate), null);
    const first = checkpoint.create(ws, 11, manifest, validate);
    first.state.attempts = 1;
    first.state.results.a = { jobId: 'a', status: 'success', leaf_ids: ['x'], attempt: 1, findings: [] };
    checkpoint.save(first.file, first.state, validate);
    assert.deepEqual(checkpoint.load(ws, 11, validate).state, first.state);
    const second = checkpoint.create(ws, 11, manifest, validate);
    assert.notEqual(first.file, second.file);
    assert.equal(checkpoint.load(ws, 11, validate).state.attempts, 0);
    assert.equal(checkpoint.read(ws, 11, first.id, validate).state.results.a.status, 'success');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('review checkpoint rejects parse errors, invalid types and read failures without repair', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-checkpoint-'));
  try {
    const entry = checkpoint.create(ws, 11, manifest, validate);
    for (const contents of ['{', JSON.stringify({ version: 1, manifest, attempts: '1', results: {} })]) {
      fs.writeFileSync(entry.file, contents);
      assert.throws(() => checkpoint.load(ws, 11, validate), error => error.message.includes(entry.file));
      assert.equal(fs.readFileSync(entry.file, 'utf8'), contents);
    }
    fs.rmSync(entry.file);
    fs.mkdirSync(entry.file);
    assert.throws(() => checkpoint.load(ws, 11, validate), error => error.message.includes(entry.file));
    assert.equal(fs.statSync(entry.file).isDirectory(), true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
