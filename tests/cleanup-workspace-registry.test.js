'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storageLayout = require('../scripts/shared/storage-layout');
const { main, USAGE, writeResult } = require('../scripts/cleanup-workspace-registry');

function withRuntime(fn) {
  const previous = process.env.GH_MAESTRO_RUNTIME_DIR;
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-cleanup-registry-runtime-'));
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  try {
    return fn(runtime);
  } finally {
    if (previous === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previous;
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

function makeWorkspace(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('cleanup-workspace-registry CLI: helpは0、未知引数は1', () => {
  const help = main(['--help']);
  assert.equal(help.code, 0);
  assert.deepEqual(help.lines, [USAGE]);

  const invalid = main(['--unknown']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.errLines.join('\n'), /cleanup-workspace-registry/);
  assert.match(invalid.errLines.join('\n'), /--unknown/);
});

test('cleanup-workspace-registry: stale登録だけを削除し、現存workspace登録を保持する', () => {
  withRuntime(() => {
    const existing = makeWorkspace('gh-maestro-cleanup-existing-');
    const stale = makeWorkspace('gh-maestro-cleanup-stale-');
    try {
      storageLayout.ensureWorkspaceRuntimeDir(existing);
      storageLayout.ensureWorkspaceRuntimeDir(stale);
      const staleRuntimeDir = storageLayout.workspaceRuntimeDir(stale);
      fs.rmSync(stale, { recursive: true, force: true });

      const result = main([]);

      assert.equal(result.code, 0);
      assert.match(result.lines.join('\n'), /Removed stale workspace registrations \(1\)/);
      assert.match(
        result.lines.join('\n'),
        new RegExp(storageLayout.canonicalWorkspace(stale).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      );
      assert.deepEqual(storageLayout.listRegisteredWorkspaces(), [storageLayout.canonicalWorkspace(existing)]);
      assert.ok(!fs.existsSync(staleRuntimeDir), 'staleなregistryディレクトリが削除される');
      assert.ok(fs.existsSync(path.join(storageLayout.workspaceRuntimeDir(existing), 'workspace.json')));
    } finally {
      fs.rmSync(existing, { recursive: true, force: true });
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });
});

test('cleanup-workspace-registry: dry-runは対象を表示するが削除しない', () => {
  withRuntime(() => {
    const stale = makeWorkspace('gh-maestro-cleanup-dry-run-');
    try {
      storageLayout.ensureWorkspaceRuntimeDir(stale);
      const staleRuntimeDir = storageLayout.workspaceRuntimeDir(stale);
      fs.rmSync(stale, { recursive: true, force: true });

      const result = main(['--dry-run']);

      assert.equal(result.code, 0);
      assert.match(result.lines.join('\n'), /\[dry-run\]/);
      assert.match(result.lines.join('\n'), /Stale workspace registrations \(1\)/);
      assert.ok(fs.existsSync(staleRuntimeDir), 'dry-runではregistryディレクトリを削除しない');
      assert.deepEqual(storageLayout.listRegisteredWorkspaces(), [storageLayout.canonicalWorkspace(stale)]);
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });
});

test('cleanup-workspace-registry: registry読取失敗時は削除せず1を返す', () => {
  withRuntime(() => {
    const stale = makeWorkspace('gh-maestro-cleanup-invalid-');
    try {
      storageLayout.ensureWorkspaceRuntimeDir(stale);
      const staleRuntimeDir = storageLayout.workspaceRuntimeDir(stale);
      fs.rmSync(stale, { recursive: true, force: true });
      fs.writeFileSync(path.join(staleRuntimeDir, 'workspace.json'), '{invalid-json', 'utf8');

      const result = main([]);

      assert.equal(result.code, 1);
      assert.match(result.errLines.join('\n'), /workspace registry/);
      assert.ok(fs.existsSync(staleRuntimeDir), 'registry読取失敗時は削除を開始しない');
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });
});

test('cleanup-workspace-registry CLI: 結果行はstdout、エラー行はstderrへ書き分ける', () => {
  const stdout = [];
  const stderr = [];
  const code = writeResult({
    code: 1,
    lines: ['Removed stale workspace registrations (1):'],
    errLines: ['cleanup-workspace-registry: registry unreadable'],
  }, { write: (line) => stdout.push(line) }, { write: (line) => stderr.push(line) });

  assert.equal(code, 1);
  assert.deepEqual(stdout, ['Removed stale workspace registrations (1):\n']);
  assert.deepEqual(stderr, ['cleanup-workspace-registry: registry unreadable\n']);
});
