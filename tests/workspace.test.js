'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveWorkspace, parseFlags, findWorkspaceFromCwd } = require('../scripts/shared/workspace');

function withEnv(env, fn) {
  const orig = { ...process.env };
  Object.assign(process.env, env);
  try { return fn(); }
  finally {
    // Restore modified keys only
    for (const k of Object.keys(env)) {
      if (k in orig) process.env[k] = orig[k];
      else delete process.env[k];
    }
  }
}

// ── findWorkspaceFromCwd ────────────────────────────────────────────────

test('findWorkspaceFromCwd: .gh-maestro があればその親を workspace として返す', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.gh-maestro'), { recursive: true });
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      assert.equal(findWorkspaceFromCwd(), tmpDir);
    } finally {
      process.cwd = origCwd;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findWorkspaceFromCwd: 親ディレクトリの .gh-maestro を上方向探索で見つける', () => {
  // 自前の fixture で親方向探索を検証（外部ファイルシステムに依存しない）
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-parent-'));
  const childDir = path.join(parentDir, 'deep', 'nested');
  try {
    fs.mkdirSync(path.join(parentDir, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    const origCwd = process.cwd;
    process.cwd = () => childDir;
    try {
      assert.equal(findWorkspaceFromCwd(), parentDir);
    } finally {
      process.cwd = origCwd;
    }
  } finally {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});

// ── resolveWorkspace ────────────────────────────────────────────────────

test('resolveWorkspace: GH_MAESTRO_WORKSPACE env を最優先', () => {
  withEnv({ GH_MAESTRO_WORKSPACE: '/env/path' }, () => {
    // path.resolve('/env/path') は Windows では C:\env\path になる
    assert.equal(resolveWorkspace('/arg/path'), path.resolve('/env/path'));
  });
});

test('resolveWorkspace: --workspace 引数が次優先', () => {
  // env がなければ --workspace が使われる（cwd に .gh-maestro がない前提）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    withEnv({ GH_MAESTRO_WORKSPACE: undefined }, () => {
      delete process.env.GH_MAESTRO_WORKSPACE;
      assert.equal(resolveWorkspace(tmpDir), tmpDir);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveWorkspace: 引数なし・env なしでも親に .gh-maestro があれば workspace を返す', () => {
  // 自前の fixture で resolveWorkspace(null) が cwd 探索することを検証
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-parent-'));
  const childDir = path.join(parentDir, 'sub');
  try {
    fs.mkdirSync(path.join(parentDir, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    const origCwd = process.cwd;
    process.cwd = () => childDir;
    try {
      withEnv({ GH_MAESTRO_WORKSPACE: undefined }, () => {
        delete process.env.GH_MAESTRO_WORKSPACE;
        assert.equal(resolveWorkspace(null), parentDir);
        assert.ok(fs.existsSync(path.join(parentDir, '.gh-maestro')));
      });
    } finally {
      process.cwd = origCwd;
    }
  } finally {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});

// ── parseFlags ──────────────────────────────────────────────────────────

test('parseFlags: フラグと値を抽出する', () => {
  const args = ['--workspace', '/ws', '--kind', 'notify', 'pos1', 'pos2'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--kind']);

  assert.equal(values['--workspace'], '/ws');
  assert.equal(values['--kind'], 'notify');
  assert.deepEqual(rest, ['pos1', 'pos2']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: フラグなしは全て rest', () => {
  const args = ['pos1', 'pos2'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace']);

  assert.equal(values['--workspace'], null);
  assert.deepEqual(rest, ['pos1', 'pos2']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: フラグに値がない場合 exitFlagMiss=true', () => {
  const args = ['--workspace', '--kind', 'notify'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--kind']);

  assert.equal(values['--workspace'], null);
  assert.equal(values['--kind'], 'notify');
  assert.deepEqual(rest, []);
  assert.equal(exitFlagMiss, true);
});

test('parseFlags: フラグが末尾で値なしは exitFlagMiss=true', () => {
  const args = ['--workspace'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace']);

  assert.equal(values['--workspace'], null);
  assert.deepEqual(rest, []);
  assert.equal(exitFlagMiss, true);
});

test('parseFlags: 複数フラグを同時に処理する', () => {
  const args = ['--message-id', 'myid', '--workspace', '/ws', 'hello'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--kind', '--message-id']);

  assert.equal(values['--workspace'], '/ws');
  assert.equal(values['--kind'], null);
  assert.equal(values['--message-id'], 'myid');
  assert.deepEqual(rest, ['hello']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: 値フラグの次が短縮フラグ（-x）なら exitFlagMiss=true', () => {
  const args = ['--workspace', '-v', 'hello'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace']);

  assert.equal(values['--workspace'], null);
  assert.deepEqual(rest, ['-v', 'hello']);
  assert.equal(exitFlagMiss, true);
});

test('parseFlags: 真偽フラグは存在すれば true、値を消費しない', () => {
  const args = ['--verbose', 'hello'];
  const { values, rest, exitFlagMiss } = parseFlags(args, [], ['--verbose']);

  assert.equal(values['--verbose'], true);
  assert.deepEqual(rest, ['hello']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: 真偽フラグがなければ null', () => {
  const args = ['hello'];
  const { values, rest, exitFlagMiss } = parseFlags(args, [], ['--verbose']);

  assert.equal(values['--verbose'], null);
  assert.deepEqual(rest, ['hello']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: 真偽フラグが末尾にあってもエラーにならない', () => {
  const args = ['hello', '--dry-run'];
  const { values, rest, exitFlagMiss } = parseFlags(args, [], ['--dry-run']);

  assert.equal(values['--dry-run'], true);
  assert.deepEqual(rest, ['hello']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: 真偽フラグと値フラグを混在できる', () => {
  const args = ['--workspace', '/ws', '--verbose', 'hello'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace'], ['--verbose']);

  assert.equal(values['--workspace'], '/ws');
  assert.equal(values['--verbose'], true);
  assert.deepEqual(rest, ['hello']);
  assert.equal(exitFlagMiss, false);
});

test('parseFlags: 値フラグの次が真偽フラグなら exitFlagMiss（真偽フラグ名が値フラグに食われない）', () => {
  // 真偽フラグも - で始まるため、値フラグの次が真偽フラグでも値欠落になる
  const args = ['--workspace', '--verbose', 'hello'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace'], ['--verbose']);

  // 値フラグ --workspace の次が --verbose なので値欠落となる
  // 真偽フラグ --verbose は値フラグの値として消費されず、独立して true になる
  // skipIndices: --verbose は真偽フラグの for ループで idx=1 が追加されるが、
  // 値フラグ --workspace の for ループでは idx=0 と idx+1=1 の両方を skipIndices に入れようとする
  // が、--workspace は idx=0 で idx+1=1 は --verbose で startsWith('-') → exitFlagMiss=true
  // このとき skipIndices には --workspace の idx=0 のみ追加される
  // 真偽フラグのループが先に走るため --verbose の idx=1 はすでに skipIndices に入っている
  // 実際には: values['--verbose']=true, values['--workspace']=null, exitFlagMiss=true
  assert.equal(values['--workspace'], null);
  assert.equal(values['--verbose'], true);
  assert.deepEqual(rest, ['hello']);
  assert.equal(exitFlagMiss, true);
});

test('parseFlags: 後方互換性 — booleanFlags なしでも既存の挙動は変わらない', () => {
  const args = ['--workspace', '/ws', '--kind', 'notify', 'pos1'];
  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--kind']);

  assert.equal(values['--workspace'], '/ws');
  assert.equal(values['--kind'], 'notify');
  assert.deepEqual(rest, ['pos1']);
  assert.equal(exitFlagMiss, false);
});
