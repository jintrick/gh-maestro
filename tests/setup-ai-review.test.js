'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { buildManifest, WORKFLOWS, SHARED } = require('../scripts/setup-ai-review.js');

// ── buildManifest ──────────────────────────────────────────────────────────

test('buildManifest: workflows/ の .lock.yml が全て含まれる', () => {
  const lockFiles = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.lock.yml'));
  assert.ok(lockFiles.length > 0, '.lock.yml が workflows/ にない（gh aw compile -d workflows 未実行か）');

  const manifest = buildManifest();
  for (const f of lockFiles) {
    const entry = manifest.find(e => e.dest === `.github/workflows/${f}`);
    assert.ok(entry, `${f} のエントリがない`);
    assert.equal(entry.src, path.join(WORKFLOWS, f));
  }
});

test('buildManifest: reviewer.md が含まれる（runtime-import 元）', () => {
  const manifest = buildManifest();
  const entry = manifest.find(e => e.dest === '.github/workflows/reviewer.md');
  assert.ok(entry, 'reviewer.md のエントリがない — lock の runtime-import が CI で解決できなくなる');
  assert.equal(entry.src, path.join(WORKFLOWS, 'reviewer.md'));
});

test('buildManifest: SPEC.md はデプロイされない', () => {
  const manifest = buildManifest();
  const entry = manifest.find(e => e.dest.endsWith('SPEC.md'));
  assert.equal(entry, undefined, 'SPEC.md が対象リポジトリに混入している');
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

test('buildManifest: reviewer-output-policy.md が shared/ としてデプロイされる', () => {
  const manifest = buildManifest();
  const entry = manifest.find(e => e.dest === '.github/workflows/shared/reviewer-output-policy.md');
  assert.ok(entry, 'reviewer-output-policy.md の shared エントリがない — runtime-import が CI で解決できなくなる');
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
