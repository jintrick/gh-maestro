'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withTempDir } = require('../../scripts/shared/temp-directory');
const { runFakeGh } = require('./fake-gh');

test('fake gh rejects and logs unregistered commands instead of forwarding them', () => {
  withTempDir('ghm-fake-gh-reject-', directory => {
    const logPath = path.join(directory, 'calls.jsonl');
    const stderr = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function captureFakeGhError(chunk, ...args) {
      stderr.push(String(chunk));
      const callback = args.find(value => typeof value === 'function');
      if (callback) callback();
      return true;
    };

    let status;
    try {
      status = runFakeGh({ fixtures: [], logPath }, ['repo', 'view', 'jintrick/gh-maestro']);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(status, 97);
    assert.match(stderr.join(''), /unregistered command/);
    const [record] = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(record.args, ['repo', 'view', 'jintrick/gh-maestro']);
    assert.equal(record.fixtureMatched, false);
    assert.equal(record.status, 97);
  });
});
