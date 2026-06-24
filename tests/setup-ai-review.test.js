'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { buildManifest, WORKFLOWS, SHARED, CALLER } = require('../scripts/setup-ai-review.js');

// ── buildManifest ──────────────────────────────────────────────────────────

test('buildManifest: caller template が含まれる', () => {
  const manifest = buildManifest();
  const entry = manifest.find(e => e.dest === '.github/workflows/ai-review.yml');
  assert.ok(entry, 'ai-review.yml のエントリがない');
  assert.equal(entry.src, CALLER);
});

test('buildManifest: workflows/ の .lock.yml が全て含まれる', () => {
  const lockFiles = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.lock.yml'));
  assert.ok(lockFiles.length > 0, '.lock.yml が workflows/ にない');

  const manifest = buildManifest();
  for (const f of lockFiles) {
    const entry = manifest.find(e => e.dest === `.github/workflows/${f}`);
    assert.ok(entry, `${f} のエントリがない`);
    assert.equal(entry.src, path.join(WORKFLOWS, f));
  }
});

test('buildManifest: workflows/ の .md が全て含まれる', () => {
  const mdFiles = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.md'));
  assert.ok(mdFiles.length > 0, '.md が workflows/ にない');

  const manifest = buildManifest();
  for (const f of mdFiles) {
    const entry = manifest.find(e => e.dest === `.github/workflows/${f}`);
    assert.ok(entry, `${f} のエントリがない`);
    assert.equal(entry.src, path.join(WORKFLOWS, f));
  }
});

test('buildManifest: shared/ のファイルが全て含まれる', () => {
  assert.ok(fs.existsSync(SHARED), `shared/ ディレクトリが存在しない: ${SHARED}`);
  const sharedFiles = fs.readdirSync(SHARED);
  assert.ok(sharedFiles.length > 0, 'shared/ にファイルがない');

  const manifest = buildManifest();
  for (const f of sharedFiles) {
    const entry = manifest.find(e => e.dest === `.github/workflows/shared/${f}`);
    assert.ok(entry, `shared/${f} のエントリがない`);
    assert.equal(entry.src, path.join(SHARED, f));
  }
});

test('buildManifest: dest に重複がない', () => {
  const manifest = buildManifest();
  const dests = manifest.map(e => e.dest);
  const unique = new Set(dests);
  assert.equal(unique.size, dests.length, `dest に重複あり: ${dests.filter((d, i) => dests.indexOf(d) !== i).join(', ')}`);
});

test('buildManifest: 全エントリの src ファイルが実在する', () => {
  const manifest = buildManifest();
  for (const { src, dest } of manifest) {
    assert.ok(fs.existsSync(src), `src が存在しない: ${src} (dest: ${dest})`);
  }
});

test('buildManifest: reviewer-output-policy.md が shared/ としてデプロイされる', () => {
  const manifest = buildManifest();
  const entry = manifest.find(e => e.dest === '.github/workflows/shared/reviewer-output-policy.md');
  assert.ok(entry, 'reviewer-output-policy.md の shared エントリがない — runtime-import が CI で解決できなくなる');
});
