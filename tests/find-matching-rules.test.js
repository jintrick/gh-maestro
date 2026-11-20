'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  globToRegex,
  matchesAny,
  findMatchingRules,
  findMatchingRulesAtRef,
  main,
} = require('../scripts/find-matching-rules');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'find-matching-rules.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-fmr-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runScript(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

// ── globToRegex ──────────────────────────────────────────────────────────────

test('globToRegex: **/*.js は多段ディレクトリの.jsにマッチする', () => {
  const re = globToRegex('scripts/**/*.js');
  assert.ok(re.test('scripts/foo.js'));
  assert.ok(re.test('scripts/sub/dir/deep.js'));
  assert.ok(!re.test('scripts/foo.ts'));
  assert.ok(!re.test('other/foo.js'));
});

test('globToRegex: ** 末尾は任意のパス全体にマッチする', () => {
  const re = globToRegex('scripts/**');
  assert.ok(re.test('scripts/foo.js'));
  assert.ok(re.test('scripts/sub/dir/file.ts'));
  assert.ok(re.test('scripts/'));
  assert.ok(!re.test('scripts'));
  assert.ok(!re.test('other/file.js'));
});

test('globToRegex: * は単一セグメント内の任意文字にマッチする', () => {
  const re = globToRegex('scripts/shared/*.js');
  assert.ok(re.test('scripts/shared/workspace.js'));
  assert.ok(re.test('scripts/shared/object.js'));
  assert.ok(!re.test('scripts/shared/sub/file.js'));
  assert.ok(!re.test('scripts/shared/file.ts'));
});

test('globToRegex: リテラルパスは完全一致', () => {
  const re = globToRegex('scripts/spawn-worker.js');
  assert.ok(re.test('scripts/spawn-worker.js'));
  assert.ok(!re.test('scripts/spawn-worker.ts'));
  assert.ok(!re.test('scripts/sub/spawn-worker.js'));
});

test('globToRegex: ドット始まりパスにマッチする', () => {
  const re = globToRegex('.claude/rules/**');
  assert.ok(re.test('.claude/rules/foo.md'));
  assert.ok(re.test('.claude/rules/sub/bar.md'));
});

test('globToRegex: ルート直下ファイルにマッチする', () => {
  const re = globToRegex('AGENTS.md');
  assert.ok(re.test('AGENTS.md'));
  assert.ok(!re.test('sub/AGENTS.md'));
});

test('globToRegex: 正規表現の特殊文字をエスケープする', () => {
  const re = globToRegex('test.+foo.js');
  assert.ok(re.test('test.+foo.js'));
  assert.ok(!re.test('testX+foo.js'));
});

// ── matchesAny ───────────────────────────────────────────────────────────────

test('matchesAny: 空のglobs配列は常にfalse', () => {
  assert.ok(!matchesAny('any/file.js', []));
});

test('matchesAny: バックスラッシュパスを正規化する', () => {
  const globs = ['scripts/**/*.js'];
  assert.ok(matchesAny('scripts\\sub\\file.js', globs));
});


// ── findMatchingRules ────────────────────────────────────────────────────────

test('findMatchingRules: .claude/rules/ がなければ空を返す', () => {
  withTempDir(dir => {
    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(matched, []);
    assert.deepEqual(errors, []);
  });
});

test('findMatchingRules: 空のrulesディレクトリは空を返す', () => {
  withTempDir(dir => {
    fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(matched, []);
    assert.deepEqual(errors, []);
  });
});

test('findMatchingRules: paths: がないルールはスキップする', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'no-paths.md'),
      `---\nother: value\n---\n# No paths`);
    fs.writeFileSync(path.join(rulesDir, 'with-paths.md'),
      `---\npaths:\n  - "scripts/**"\n---\n# With paths`);

    const { matched } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.ok(!matched.includes('.claude/rules/no-paths.md'));
    assert.ok(matched.includes('.claude/rules/with-paths.md'));
  });
});

test('findMatchingRules: frontmatterなしのルールはスキップする', () => {
  withTempDir(dir => {
    const rulesDir = path.join(dir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'plain.md'), '# No frontmatter');

    const { matched, errors } = findMatchingRules(dir, ['scripts/foo.js']);
    assert.deepEqual(matched, []);
    assert.deepEqual(errors, []);
  });
});

test('findMatchingRules: サブディレクトリ配下のルールも対象にし、一致しないサブディレクトリは除外する', () => {
  withTempDir(dir => {
    const subDir = path.join(dir, '.claude', 'rules', 'backend', 'api');
    const otherDir = path.join(dir, '.claude', 'rules', 'frontend');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'endpoint.md'),
      `---\npaths:\n  - "api/**/*.ts"\n---\n# API Rule`);
    fs.writeFileSync(path.join(otherDir, 'ui.md'),
      `---\npaths:\n  - "web/**/*.tsx"\n---\n# UI Rule`);

    const { matched, errors } = findMatchingRules(dir, ['api/v1/users.ts']);
    assert.deepEqual(errors, []);
    assert.deepEqual(matched, ['.claude/rules/backend/api/endpoint.md']);
  });
});

test('findMatchingRules: 作業ツリー読取失敗時は errors を返し matched を空にする (exit 1)', () => {
  withTempDir(dir => {
    // .claude/rules が通常ファイルとして存在すると readdirSync が ENOTDIR で失敗する
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'rules'), 'not-a-directory');

    const res = main(['--root', dir, 'scripts/foo.js']);
    assert.equal(res.exitCode, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /\.claude\/rules\/ の読み取りに失敗しました/);
  });
});

// ── findMatchingRulesAtRef (--ref / git-ref 連携) ─────────────────────────────

function makeMockGitSpawn({
  revParse = () => ({ status: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' }),
  lsTree = () => ({ status: 0, stdout: '', stderr: '' }),
  showRef = (oid) => ({ status: 0, stdout: oid + '\n', stderr: '' }),
  showFile = () => ({ status: 1, stdout: '', stderr: 'fatal: path does not exist' }),
  recordedArgvs = [],
} = {}) {
  return (cmd, args) => {
    assert.equal(cmd, 'git');
    recordedArgvs.push(args);
    if (args[0] === 'rev-parse') return revParse(args);
    if (args[0] === 'ls-tree') return lsTree(args);
    if (args[0] === 'show' && args[1] === '--quiet') return showRef(args[3]);
    if (args[0] === 'show') return showFile(args[1]);
    throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
  };
}

test('findMatchingRulesAtRef: rev-parse 失敗・例外・ls-tree 失敗・不正エントリ・git show 失敗/欠落をすべて exit 1 にする', () => {
  const oid = 'c'.repeat(40);
  const blobOid = 'd'.repeat(40);
  const lsEntry = [`100644 blob ${blobOid}\t.claude/rules/a.md`, `100644 blob ${blobOid}\t.claude/rules/b.md`].join('\0') + '\0';

  const cases = [
    {
      name: 'rev-parse non-zero',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 128, stdout: '', stderr: 'fatal: Needed a single revision' }),
      }),
      expectedErr: /--ref .* を解決できません/,
    },
    {
      name: 'rev-parse throws',
      spawnSyncFn: () => { throw new Error('spawn failed'); },
      expectedErr: /spawn failed/,
    },
    {
      name: 'ls-tree non-zero',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 0, stdout: `${oid}\n`, stderr: '' }),
        lsTree: () => ({ status: 128, stdout: '', stderr: 'fatal: not a tree object' }),
      }),
      expectedErr: /git ls-tree .* に失敗しました/,
    },
    {
      name: 'ls-tree malformed entry (missing tab)',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 0, stdout: `${oid}\n`, stderr: '' }),
        lsTree: () => ({ status: 0, stdout: 'malformed-record-without-tab\0', stderr: '' }),
      }),
      expectedErr: /malformed entry/,
    },
    {
      name: 'ls-tree invalid entry (non-hex OID)',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 0, stdout: `${oid}\n`, stderr: '' }),
        lsTree: () => ({ status: 0, stdout: '100644 blob not-a-hex\t.claude/rules/a.md\0', stderr: '' }),
      }),
      expectedErr: /invalid entry/,
    },
    {
      name: 'ls-tree invalid entry (empty path)',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 0, stdout: `${oid}\n`, stderr: '' }),
        lsTree: () => ({ status: 0, stdout: `100644 blob ${blobOid}\t\0`, stderr: '' }),
      }),
      expectedErr: /invalid entry/,
    },
    {
      name: 'readFileAtRef unknown failure after one rule matched',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 0, stdout: `${oid}\n`, stderr: '' }),
        lsTree: () => ({ status: 0, stdout: lsEntry, stderr: '' }),
        showFile: (spec) => spec.endsWith('a.md')
          ? { status: 0, stdout: '---\npaths:\n  - "scripts/**"\n---\n# A', stderr: '' }
          : { status: 128, stdout: '', stderr: 'fatal: unable to read blob' },
      }),
      expectedErr: /読み取りに失敗しました/,
    },
    {
      name: 'readFileAtRef unexpected absent after ls-tree',
      spawnSyncFn: makeMockGitSpawn({
        revParse: () => ({ status: 0, stdout: `${oid}\n`, stderr: '' }),
        lsTree: () => ({ status: 0, stdout: lsEntry, stderr: '' }),
        showFile: (spec) => spec.endsWith('a.md')
          ? { status: 0, stdout: '---\npaths:\n  - "scripts/**"\n---\n# A', stderr: '' }
          : { status: 128, stdout: '', stderr: `fatal: path '.claude/rules/b.md' does not exist in '${oid}'` },
      }),
      expectedErr: /is not present/,
    },
  ];

  for (const c of cases) {
    const res = main(['--root', '/repo', '--ref', 'base', 'scripts/foo.js'], { spawnSyncFn: c.spawnSyncFn });
    assert.equal(res.exitCode, 1, `${c.name}: exitCode should be 1`);
    assert.equal(res.stdout, '', `${c.name}: stdout must be empty on error (no partial match)`);
    assert.match(res.stderr, c.expectedErr, `${c.name}: stderr mismatch`);
  }

  // 直接関数呼び出しで ref が非文字列のケースも拒否されること
  const directInvalid = findMatchingRulesAtRef('/repo', null, ['scripts/foo.js']);
  assert.deepEqual(directInvalid.matched, []);
  assert.equal(directInvalid.errors.length, 1);
});

// ── CLI integration ──────────────────────────────────────────────────────────

