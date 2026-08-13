'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveWorkspace, parseFlags, findWorkspaceFromCwd, hasGenuineHelpRequest } = require('../scripts/shared/workspace');

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

test('findWorkspaceFromCwd: ホームディレクトリ自体は workspace として認定しない（Issue #214）', () => {
  // ~/.gh-maestro は install.js の managed root であり、実行時ワークスペースではない。
  // CWD がホーム配下のどこかで、ホーム自体にしか .gh-maestro が無い場合、
  // 上方探索はホームを「見つけて」しまってはならない（見つけると workspace = home に
  // 誤解決され、PID registry 等が managed root 配下に作られてしまう）。
  //
  // フィクスチャは実ホームディレクトリの子孫に置いてはならない。os.tmpdir() は
  // Windows では既定で %USERPROFILE%\AppData\Local\Temp（実ホーム配下）を指すため、
  // このフィクスチャ配下から上方探索すると、この開発機に既にインストール済みの
  // 実 ~/.gh-maestro に到達してしまい（本テストが偽装したホーム以外の場所で）誤って
  // マーカーを「発見」してしまう。実ホームの祖先にならない場所に置く。
  const fixtureRoot = process.platform === 'win32'
    ? path.join(path.parse(os.tmpdir()).root, 'gh-maestro-test-root-' + Date.now())
    : fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-fakehome-'));
  if (process.platform === 'win32') fs.mkdirSync(fixtureRoot, { recursive: true });
  const fakeHome = process.platform === 'win32' ? path.join(fixtureRoot, 'fakehome') : fixtureRoot;
  fs.mkdirSync(path.join(fakeHome, '.gh-maestro'), { recursive: true });
  const childDir = path.join(fakeHome, 'some', 'nested', 'cwd');
  fs.mkdirSync(childDir, { recursive: true });

  const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const origEnvVal = process.env[envKey];
  const origCwd = process.cwd;
  process.env[envKey] = fakeHome;
  process.cwd = () => childDir;
  try {
    assert.equal(findWorkspaceFromCwd(), null);
  } finally {
    process.cwd = origCwd;
    if (origEnvVal === undefined) delete process.env[envKey]; else process.env[envKey] = origEnvVal;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('findWorkspaceFromCwd: ホーム配下でも、子ディレクトリ自身の .gh-maestro は通常通り workspace として返す', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-fakehome2-'));
  const projectDir = path.join(fakeHome, 'work', 'my-project');
  fs.mkdirSync(path.join(projectDir, '.gh-maestro'), { recursive: true });

  const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const origEnvVal = process.env[envKey];
  const origCwd = process.cwd;
  process.env[envKey] = fakeHome;
  process.cwd = () => projectDir;
  try {
    assert.equal(findWorkspaceFromCwd(), projectDir, 'ホーム自身ではなく、実際にマーカーを持つ子ディレクトリが返るはず');
  } finally {
    process.cwd = origCwd;
    if (origEnvVal === undefined) delete process.env[envKey]; else process.env[envKey] = origEnvVal;
    fs.rmSync(fakeHome, { recursive: true, force: true });
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

test('resolveWorkspace: --workspace 引数が明示的にホームディレクトリを指す場合は null（Issue #214）', () => {
  // CWD探索由来だけでなく、--workspace / GH_MAESTRO_WORKSPACE で明示的にホームを
  // 指定した場合も resolveWorkspace() が一元的に弾く。これにより、この戻り値を
  // 使う全呼び出し元（poll-pr.js等）が個別の try/catch なしで安全に扱える。
  withEnv({ GH_MAESTRO_WORKSPACE: undefined }, () => {
    delete process.env.GH_MAESTRO_WORKSPACE;
    assert.equal(resolveWorkspace(os.homedir()), null);
  });
});

test('resolveWorkspace: GH_MAESTRO_WORKSPACE env が明示的にホームディレクトリを指す場合も null', () => {
  withEnv({ GH_MAESTRO_WORKSPACE: os.homedir() }, () => {
    assert.equal(resolveWorkspace('/some/other/arg'), null);
  });
});

test('resolveWorkspace: --workspace 引数が managed root（~/.gh-maestro）配下を指す場合も null', () => {
  withEnv({ GH_MAESTRO_WORKSPACE: undefined }, () => {
    delete process.env.GH_MAESTRO_WORKSPACE;
    assert.equal(resolveWorkspace(path.join(os.homedir(), '.gh-maestro')), null);
  });
});

test('resolveWorkspace: 通常のワークスペースは引き続き解決される（回帰確認）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-normal-'));
  try {
    withEnv({ GH_MAESTRO_WORKSPACE: undefined }, () => {
      delete process.env.GH_MAESTRO_WORKSPACE;
      assert.equal(resolveWorkspace(tmpDir), path.resolve(tmpDir));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── parseFlags（新契約: 仕様オブジェクト + ArgsValidationError throw） ─────

function expectValidationError(args, spec, expectedMessage) {
  assert.throws(
    () => parseFlags(args, spec),
    (err) => {
      assert.equal(err.name, 'ArgsValidationError');
      assert.equal(err.message, expectedMessage);
      return true;
    },
  );
}

test('parseFlags: フラグと値を抽出する', () => {
  const args = ['--workspace', '/ws', '--kind', 'notify', 'pos1', 'pos2'];
  const { values, rest } = parseFlags(args, {
    flags: { '--workspace': {}, '--kind': {} },
    positionals: { min: 0, max: 2 },
  });

  assert.equal(values['--workspace'], '/ws');
  assert.equal(values['--kind'], 'notify');
  assert.deepEqual(rest, ['pos1', 'pos2']);
});

test('parseFlags: 欠落した任意フラグはキー不在（undefined）', () => {
  const { values, rest } = parseFlags(['pos1', 'pos2'], {
    flags: { '--workspace': {} },
    positionals: { min: 0, max: 2 },
  });

  assert.equal('--workspace' in values, false);
  assert.equal(values['--workspace'], undefined);
  assert.deepEqual(rest, ['pos1', 'pos2']);
});

test('parseFlags: 真偽フラグは存在すれば true、なければキー不在', () => {
  const withVerbose = parseFlags(['--verbose', 'hello'], {
    booleans: ['--verbose'],
    positionals: { min: 0, max: 1 },
  });
  assert.equal(withVerbose.values['--verbose'], true);

  const withoutVerbose = parseFlags(['hello'], {
    booleans: ['--verbose'],
    positionals: { min: 0, max: 1 },
  });
  assert.equal('--verbose' in withoutVerbose.values, false);
});

test('parseFlags: 真偽フラグが末尾にあってもエラーにならない', () => {
  const { values } = parseFlags(['hello', '--dry-run'], {
    booleans: ['--dry-run'],
    positionals: { min: 0, max: 1 },
  });

  assert.equal(values['--dry-run'], true);
});

test('parseFlags: 真偽フラグと値フラグを混在できる', () => {
  const { values, rest } = parseFlags(['--workspace', '/ws', '--verbose', 'hello'], {
    flags: { '--workspace': {} },
    booleans: ['--verbose'],
    positionals: { min: 0, max: 1 },
  });

  assert.equal(values['--workspace'], '/ws');
  assert.equal(values['--verbose'], true);
  assert.deepEqual(rest, ['hello']);
});

test('parseFlags: 値フラグの次が真偽フラグなら値欠落（真偽フラグ名が値フラグに食われない）', () => {
  expectValidationError(
    ['--workspace', '--verbose', 'hello'],
    { flags: { '--workspace': {} }, booleans: ['--verbose'], positionals: { min: 0, max: 1 } },
    'フラグ --workspace には値が必要です',
  );
});

test('parseFlags: フラグに値がない場合（次のトークンが既知フラグ）は ArgsValidationError', () => {
  expectValidationError(
    ['--workspace', '--kind', 'notify'],
    { flags: { '--workspace': {}, '--kind': {} }, positionals: { min: 0, max: 2 } },
    'フラグ --workspace には値が必要です',
  );
});

test('parseFlags: フラグが末尾で値なしは ArgsValidationError', () => {
  expectValidationError(
    ['--workspace'],
    { flags: { '--workspace': {} } },
    'フラグ --workspace には値が必要です',
  );
});

test('parseFlags: 必須フラグの欠落は ArgsValidationError（hint 付き）', () => {
  expectValidationError(
    ['--workspace', '/ws'],
    { flags: { '--workspace': {}, '--pr': { required: true, hint: '検証前の起動コンテキストのPR番号' } } },
    '必須フラグがありません: --pr（検証前の起動コンテキストのPR番号）',
  );
});

test('parseFlags: 未知の -- 始まりフラグは位置引数として受理されず ArgsValidationError（Issue #14）', () => {
  expectValidationError(
    ['--bogus', 'hello'],
    { flags: { '--workspace': {} }, positionals: { min: 0, max: 2 } },
    '未知のフラグです: --bogus',
  );
});

test('parseFlags: 重複したフラグは ArgsValidationError', () => {
  expectValidationError(
    ['--workspace', '/ws', '--workspace'],
    { flags: { '--workspace': {} } },
    'フラグが重複しています: --workspace',
  );
});

test('parseFlags: 未知の --長形式フラグは「値欠落」と「未知フラグ」の両方で拒否される', () => {
  let caught;
  try {
    parseFlags(['--workspace', '--unknown-flag', 'hello'], { flags: { '--workspace': {} }, positionals: { min: 0, max: 1 } });
    assert.fail('ArgsValidationError が投げられるべき');
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.name, 'ArgsValidationError');
  const messages = caught.errors.map((e) => e.message);
  assert.ok(messages.includes('フラグ --workspace には値が必要です'));
  assert.ok(messages.includes('未知のフラグです: --unknown-flag'));
});

test('parseFlags: 負数は値として正しく消費される', () => {
  const { values, rest } = parseFlags(['--max-age', '-5', 'hello'], {
    flags: { '--max-age': {} },
    positionals: { min: 0, max: 1 },
  });

  assert.equal(values['--max-age'], '-5');
  assert.deepEqual(rest, ['hello']);
});

test('parseFlags: 短いダッシュ始まりの文字列（-v 等）は値として消費される', () => {
  const { values, rest } = parseFlags(['--workspace', '-v', 'hello'], {
    flags: { '--workspace': {} },
    positionals: { min: 0, max: 1 },
  });

  assert.equal(values['--workspace'], '-v');
  assert.deepEqual(rest, ['hello']);
});

test('parseFlags: --x=value 形式はサポートされない（未知フラグとして拒否）', () => {
  expectValidationError(
    ['--workspace=/ws'],
    { flags: { '--workspace': {} } },
    '未知のフラグです: --workspace=/ws',
  );
});

test('parseFlags: 位置引数の個数が min 未満なら ArgsValidationError', () => {
  expectValidationError(
    [],
    { flags: {}, positionals: { min: 1, max: 1 } },
    '位置引数が必要です',
  );
});

test('parseFlags: 位置引数の個数が max を超えるなら ArgsValidationError', () => {
  expectValidationError(
    ['pos1', 'pos2'],
    { flags: {}, positionals: { min: 0, max: 1 } },
    '予期しない位置引数です: pos2',
  );
});

test('parseFlags: 既定 positionals（max 0）では位置引数は ArgsValidationError', () => {
  expectValidationError(
    ['pos1'],
    { flags: { '--workspace': {} } },
    '予期しない位置引数です: pos1',
  );
});

test('parseFlags: 空引数はエラーなく空 values / rest を返す', () => {
  const { values, rest } = parseFlags([], { flags: {}, booleans: ['--help'], positionals: { min: 0, max: 0 } });
  assert.deepEqual(values, {});
  assert.deepEqual(rest, []);
});

test('parseFlags: 旧形式（第2引数がフラグ名配列）は契約変更エラーで throw', () => {
  assert.throws(
    () => parseFlags(['--workspace', '/ws'], ['--workspace'], ['--help']),
    /parseFlags の契約が変わりました/,
  );
});

test('parseFlags: 旧形式（第2引数なし）は契約変更エラーで throw', () => {
  assert.throws(
    () => parseFlags(['--workspace', '/ws']),
    /parseFlags の契約が変わりました/,
  );
});

// ── hasGenuineHelpRequest（catch でのヘルプ優先判定。値欠落はヘルプに握りつぶさない） ─────

test('hasGenuineHelpRequest: --help があれば true', () => {
  assert.equal(hasGenuineHelpRequest(['--help'], []), true);
});

test('hasGenuineHelpRequest: -h があれば true', () => {
  assert.equal(hasGenuineHelpRequest(['-h'], []), true);
});

test('hasGenuineHelpRequest: 値欠落エラーが混ざっていると false（値として --help を渡された可能性）', () => {
  assert.equal(
    hasGenuineHelpRequest(['--workspace', '--help'], [{ kind: 'missing-value', flag: '--workspace' }]),
    false,
  );
});

test('hasGenuineHelpRequest: 必須欠落エラーだけなら true（--help は真の要求）', () => {
  assert.equal(
    hasGenuineHelpRequest(['--help'], [{ kind: 'required-missing', flag: '--pr' }]),
    true,
  );
});

test('hasGenuineHelpRequest: 未知フラグエラーがあっても true', () => {
  assert.equal(
    hasGenuineHelpRequest(['--help'], [{ kind: 'unknown-flag', flag: '--bogus' }]),
    true,
  );
});

test('hasGenuineHelpRequest: --help が無ければ false', () => {
  assert.equal(hasGenuineHelpRequest(['--workspace', '/ws'], []), false);
});

// ── parseFlags が throw する ArgsValidationError.helpRequested（パーサー側で確定） ─────

function captureArgsValidationError(args, spec) {
  try {
    parseFlags(args, spec);
    assert.fail('ArgsValidationError が投げられるべき');
  } catch (e) {
    assert.equal(e.name, 'ArgsValidationError');
    return e;
  }
}

test('parseFlags: --help + 必須欠落は throw したエラーの helpRequested=true', () => {
  const err = captureArgsValidationError(['--help'], {
    flags: { '--pr': { required: true } },
    booleans: ['--help', '-h'],
  });
  assert.equal(err.helpRequested, true);
});

test('parseFlags: -h + 必須欠落は throw したエラーの helpRequested=true', () => {
  const err = captureArgsValidationError(['-h'], {
    flags: { '--pr': { required: true } },
    booleans: ['--help', '-h'],
  });
  assert.equal(err.helpRequested, true);
});

test('parseFlags: 値欠落が混ざると helpRequested=false（--help は値として渡された可能性）', () => {
  const err = captureArgsValidationError(['--title', '--help'], {
    flags: { '--title': {} },
    booleans: ['--help', '-h'],
  });
  assert.equal(err.helpRequested, false);
});

test('parseFlags: 未知フラグ + --help は helpRequested=true', () => {
  const err = captureArgsValidationError(['--bogus', '--help'], {
    flags: { '--pr': { required: true } },
    booleans: ['--help', '-h'],
  });
  assert.equal(err.helpRequested, true);
});

test('parseFlags: --help が無ければ helpRequested=false', () => {
  const err = captureArgsValidationError(['--pr'], {
    flags: { '--pr': { required: true } },
  });
  assert.equal(err.helpRequested, false);
});

test('parseFlags: 成功時は throw せず helpRequested を持たない', () => {
  const { values } = parseFlags(['--title', 'x'], {
    flags: { '--title': {} },
    booleans: ['--help', '-h'],
  });
  assert.equal(values['--title'], 'x');
});
