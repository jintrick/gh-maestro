'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { listKnownAspects } = require('../scripts/shared/review-aspects');

test('listKnownAspects scans the real skills/gh-maestro-reviewer tree', () => {
  const aspects = listKnownAspects();
  assert.ok(aspects.includes('test-quality'));
  assert.ok(aspects.includes('api-contract'));
  assert.ok(aspects.includes('concurrency'));
  assert.equal(aspects.includes('SKILL'), false);
});

test('listKnownAspects returns empty array for a missing directory', () => {
  assert.deepEqual(listKnownAspects(path.join(os.tmpdir(), 'gh-maestro-no-such-dir-' + Date.now())), []);
});

test('listKnownAspects scans a custom two-level trunk/leaf layout', () => {
  const dir = path.join(os.tmpdir(), 'gh-maestro-test-aspects-' + Date.now());
  const trunkDir = path.join(dir, 'trunk-a');
  fs.mkdirSync(trunkDir, { recursive: true });
  fs.writeFileSync(path.join(trunkDir, 'leaf-one.md'), '');
  fs.writeFileSync(path.join(trunkDir, 'leaf-two.md'), '');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), ''); // 幹直下は葉として扱わない

  try {
    const aspects = listKnownAspects(dir);
    assert.deepEqual(aspects, ['leaf-one', 'leaf-two']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
