'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// process-lifecycle.js は child-process.js の execSync に依存する（Windows WMI）。
// テストは実プロセスを0個spawnする（.claude/rules/test-process-spawn-safety.md 準拠）。
// プラットフォーム依存の execSync 呼び出しを含む関数はモックで置き換える。

// ── テスト用の一時ワークスペース ─────────────────────────────────────────

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-lifecycle-' + Date.now());
const workspace = path.join(tmpBase, 'workspace');

before(() => {
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// 各テスト後に process.pid の registry エントリを確実に削除する。
// registerProcess 系テストが残留させたエントリが sweepRegistry で
// テストランナー自身のプロセスを kill する事故を防ぐ。
afterEach(() => {
  const pidsFile = path.join(workspace, '.gh-maestro', 'pids', `${process.pid}.json`);
  try { if (fs.existsSync(pidsFile)) fs.unlinkSync(pidsFile); } catch {}
});

// ── ヘルパー: モジュールをリロードして依存を注入 ──────────────────────

/**
 * process-lifecycle.js を再ロードする。
 *
 * @param {object} [overrides]
 * @param {Function} [overrides.execSync]  child-process.js の execSync を置き換える。
 *   WMI/PowerShell呼び出しをモック化し、実プロセスspawnを回避する。
 */
function loadModule(overrides = {}) {
  // キャッシュクリア
  delete require.cache[require.resolve('../scripts/process-lifecycle')];

  // execSync のモック注入（実プロセス spawn 回避）
  if (overrides.execSync) {
    const childProcessPath = require.resolve('../scripts/child-process');
    delete require.cache[childProcessPath];
    require.cache[childProcessPath] = {
      id: childProcessPath,
      filename: childProcessPath,
      loaded: true,
      exports: {
        spawn: () => { throw new Error('spawn not allowed in tests'); },
        spawnSync: () => { throw new Error('spawnSync not allowed in tests'); },
        execSync: overrides.execSync,
      },
    };
  }

  return require('../scripts/process-lifecycle');
}

// ── モック用ヘルパー ──────────────────────────────────────────────────

// getProcessStartTime が WMI から受け取る ISO 8601 形式の固定タイムスタンプ
const MOCK_START_TIME = '2025-06-01T12:00:00.000Z';

/**
 * getProcessStartTime(WMI) の成功を模倣する execSync モックを作成する。
 * コマンド文字列に 'Win32_Process' が含まれていれば固定タイムスタンプを返す。
 * それ以外の呼び出しはエラーにする（想定外の spawn を検出）。
 */
function mockWmiSuccess() {
  return (cmd, opts) => {
    const cmdStr = typeof cmd === 'string' ? cmd : '';
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('CreationDate')) {
      return MOCK_START_TIME + '\n';
    }
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('ParentProcessId')) {
      return '42\n';  // 適当な親PID
    }
    throw new Error(`unexpected execSync call in test: ${cmdStr.slice(0, 80)}`);
  };
}

/** WMI が空文字列を返す（プロセス不在）execSync モック */
function mockWmiEmpty() {
  return (cmd, opts) => {
    const cmdStr = typeof cmd === 'string' ? cmd : '';
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('CreationDate')) {
      return '\n';
    }
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('ParentProcessId')) {
      return '\n';
    }
    throw new Error(`unexpected execSync call in test: ${cmdStr.slice(0, 80)}`);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// isProcessAlive（実プロセスspawnなしでテスト可能）
// ═══════════════════════════════════════════════════════════════════════════

test('isProcessAlive: 生存しているPIDは true', () => {
  const plc = loadModule();
  assert.equal(plc.isProcessAlive(process.pid), true);
});

test('isProcessAlive: 無効なPIDは false', () => {
  const plc = loadModule();
  assert.equal(plc.isProcessAlive(0), false);
  assert.equal(plc.isProcessAlive(-1), false);
  assert.equal(plc.isProcessAlive(null), false);
  assert.equal(plc.isProcessAlive(undefined), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveSessionPid（findSessionRootPid をモック化）
// ═══════════════════════════════════════════════════════════════════════════

test('resolveSessionPid: --session-pid フラグ値が最優先', () => {
  const plc = loadModule();
  assert.equal(plc.resolveSessionPid('12345'), 12345);
  assert.equal(plc.resolveSessionPid(99999), 99999);
});

test('resolveSessionPid: フラグが空文字の場合は自動検出にフォールバック', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const result = plc.resolveSessionPid('');
  assert.equal(typeof result, 'number');
  assert.ok(result > 0);
});

test('resolveSessionPid: 無効な文字列は自動検出にフォールバック', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const result = plc.resolveSessionPid('not-a-number');
  assert.equal(typeof result, 'number');
  assert.ok(result > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// createDeadManSwitch（実プロセスspawn不要）
// ═══════════════════════════════════════════════════════════════════════════

test('createDeadManSwitch: 自身のPIDに対しては true を返す', () => {
  const plc = loadModule();
  const check = plc.createDeadManSwitch(process.pid);
  assert.equal(check(), true);
});

test('createDeadManSwitch: 無効なPIDは3回連続で false を返す', () => {
  const plc = loadModule();
  const check = plc.createDeadManSwitch(0);
  assert.equal(check(), true, 'first dead check — grace period');
  assert.equal(check(), true, 'second dead check — grace period');
  assert.equal(check(), false, 'third dead check — confirmed');
});

test('createDeadManSwitch: 生存→死亡の遷移で3回連続確認', () => {
  const plc = loadModule();
  const check = plc.createDeadManSwitch(process.pid);
  assert.equal(check(), true, 'alive');

  const checkDead = plc.createDeadManSwitch(99999999);
  assert.equal(checkDead(), true, 'first dead — grace');
  assert.equal(checkDead(), true, 'second dead — grace');
  assert.equal(checkDead(), false, 'third dead — confirmed');
});

test('createDeadManSwitch: 死亡カウンタは生存確認でリセットされる', () => {
  const plc = loadModule();
  const check = plc.createDeadManSwitch(process.pid);
  assert.equal(check(), true);
  assert.equal(check(), true);
  assert.equal(check(), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// registerProcess / unregisterProcess
// ═══════════════════════════════════════════════════════════════════════════

test('registerProcess: .gh-maestro/pids/<pid>.json を作成する', () => {
  const plc = loadModule();
  const entry = plc.registerProcess(workspace, {
    script: 'msg-poll.js',
    workerName: 'test-worker',
  });

  assert.equal(entry.pid, process.pid);
  assert.equal(entry.script, 'msg-poll.js');
  assert.equal(entry.workerName, 'test-worker');
  assert.equal(entry.workspace, workspace);
  assert.ok(typeof entry.startTime === 'string');
  assert.ok(typeof entry.registeredAt === 'string');

  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.pid, process.pid);
  assert.equal(raw.script, 'msg-poll.js');
  assert.equal(raw.workerName, 'test-worker');
});

test('registerProcess: startTime が明示指定されればそれを使う', () => {
  const plc = loadModule();
  const customStart = '2025-01-15T10:30:00.000Z';
  const entry = plc.registerProcess(workspace, {
    script: 'poll-pr.js',
    startTime: customStart,
  });

  assert.equal(entry.startTime, customStart);

  plc.unregisterProcess(workspace, process.pid);
  assert.ok(!fs.existsSync(plc.pidFilePath(workspace, process.pid)));
});

test('unregisterProcess: ファイルを削除する', () => {
  const plc = loadModule();
  plc.registerProcess(workspace, { script: 'test.js', startTime: MOCK_START_TIME });
  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  plc.unregisterProcess(workspace, process.pid);
  assert.ok(!fs.existsSync(filePath));
});

test('unregisterProcess: ファイルが存在しなくてもエラーにならない', () => {
  const plc = loadModule();
  assert.doesNotThrow(() => plc.unregisterProcess(workspace, 99999999));
});

// ═══════════════════════════════════════════════════════════════════════════
// verifyProcessIdentity（WMI をモック化して決定的にテスト）
// ═══════════════════════════════════════════════════════════════════════════

test('verifyProcessIdentity: プロセス非生存の場合は match:false', () => {
  const plc = loadModule();
  const result = plc.verifyProcessIdentity(0, { startTime: '2025-01-01T00:00:00.000Z' });
  assert.equal(result.match, false);
  assert.ok(result.reason.includes('not alive'));
});

test('verifyProcessIdentity: 起動時刻が取得できない場合は match:false', () => {
  const plc = loadModule();
  // -1 は getProcessStartTime が parseInt + isFinite ではじく
  const result = plc.verifyProcessIdentity(-1, { startTime: '2025-01-01T00:00:00.000Z' });
  assert.equal(result.match, false);
});

test('verifyProcessIdentity: startTime比較 - 不正な日付文字列で match:false (NaNガード)', () => {
  // WMI成功をモック → getProcessStartTime(process.pid) が MOCK_START_TIME を返す
  // → startTime比較に入り 'invalid-date-format' → new Date().getTime() = NaN
  // → Number.isNaN チェックで match:false / reason='invalid date'
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const result = plc.verifyProcessIdentity(process.pid, {
    startTime: 'invalid-date-format',
  });
  assert.equal(result.match, false);
  assert.ok(result.reason.includes('invalid date'),
    `expected 'invalid date' reason, got: ${result.reason}`);
});

test('verifyProcessIdentity: 起動時刻が一致 - 許容範囲内なら match:true', () => {
  // WMI が MOCK_START_TIME を返す → registeredMeta.startTime も MOCK_START_TIME
  // → 差は0 < 1000ms → match:true
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const result = plc.verifyProcessIdentity(process.pid, {
    startTime: MOCK_START_TIME,
  });
  assert.equal(result.match, true);
});

test('verifyProcessIdentity: 起動時刻が大きくずれている場合は match:false', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  // WMI が MOCK_START_TIME (2025-06-01) を返すが、登録時刻は1年前
  const result = plc.verifyProcessIdentity(process.pid, {
    startTime: '2024-06-01T12:00:00.000Z',
  });
  assert.equal(result.match, false);
  assert.ok(result.reason.includes('start time mismatch'));
});

test('verifyProcessIdentity: startTime未設定で alive なPIDは true（同一性確認スキップ）', () => {
  // WMI が成功を返す → getProcessStartTime は値を返すが
  // registeredMeta.startTime が未設定 → 比較をスキップ → match:true
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const result = plc.verifyProcessIdentity(process.pid, {});
  assert.equal(result.match, true);
});

test('verifyProcessIdentity: getProcessStartTime が空文字を返した場合は match:false', () => {
  // WMI が空を返す → actualStartTime が空 → match:false
  const plc = loadModule({ execSync: mockWmiEmpty() });
  const result = plc.verifyProcessIdentity(process.pid, {
    startTime: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(result.match, false);
  assert.ok(result.reason.includes('cannot get'),
    `expected 'cannot get' reason, got: ${result.reason}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// sweepRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('sweepRegistry: ディレクトリが存在しない場合は空結果', () => {
  const plc = loadModule();
  const nonexistent = path.join(tmpBase, 'nonexistent');
  const results = plc.sweepRegistry(nonexistent);
  assert.deepEqual(results, { killed: [], cleaned: [], errors: [] });
});

test('sweepRegistry: 破損JSONファイルは cleaned に分類される', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '12345.json'), 'not valid json {{{');

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const corrupt = results.cleaned.filter(c => c.reason.includes('corrupt JSON'));
  assert.ok(corrupt.length >= 1, 'corrupt JSON should be cleaned');
  assert.ok(!fs.existsSync(path.join(pidsDir, '12345.json')));
});

test('sweepRegistry: nullエントリは cleaned に分類される', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '99999.json'), 'null');

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const nullEntry = results.cleaned.filter(c => c.reason && c.reason.includes('invalid entry type'));
  assert.ok(nullEntry.length >= 1, 'null entry should be cleaned');
  assert.ok(!fs.existsSync(path.join(pidsDir, '99999.json')));
});

test('sweepRegistry: 配列エントリは cleaned に分類される', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '88888.json'), '[1, 2, 3]');

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const arrEntry = results.cleaned.filter(c => c.reason && c.reason.includes('invalid entry type'));
  assert.ok(arrEntry.length >= 1, 'array entry should be cleaned');
  assert.ok(!fs.existsSync(path.join(pidsDir, '88888.json')));
});

test('sweepRegistry: 文字列エントリは cleaned に分類される', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '77777.json'), '"just a string"');

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const strEntry = results.cleaned.filter(c => c.reason && c.reason.includes('invalid entry type'));
  assert.ok(strEntry.length >= 1, 'string entry should be cleaned');
  assert.ok(!fs.existsSync(path.join(pidsDir, '77777.json')));
});

test('sweepRegistry: pidフィールドがないエントリは cleaned', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '66666.json'), JSON.stringify({ script: 'test.js' }));

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const noPid = results.cleaned.filter(c => c.reason && c.reason.includes('missing/invalid pid'));
  assert.ok(noPid.length >= 1, 'missing pid should be cleaned');
  assert.ok(!fs.existsSync(path.join(pidsDir, '66666.json')));
});

test('sweepRegistry: 生存していないPIDのエントリは cleaned', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '99998.json'), JSON.stringify({
    pid: -1,
    script: 'test.js',
    startTime: '2025-01-01T00:00:00.000Z',
  }));

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const notAlive = results.cleaned.filter(c => c.reason && c.reason.includes('not alive'));
  assert.ok(notAlive.length >= 1, `dead PID should be cleaned, got: ${JSON.stringify(results.cleaned)}`);
  assert.ok(!fs.existsSync(path.join(pidsDir, '99998.json')));
});

test('sweepRegistry: dryRun では実際の削除を行わない', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, 'dryrun.json'), 'not valid json {{{');

  const results = plc.sweepRegistry(workspace, { dryRun: true });

  const corrupt = results.cleaned.filter(c => c.reason.includes('corrupt JSON'));
  assert.ok(corrupt.length >= 1);
  assert.ok(fs.existsSync(path.join(pidsDir, 'dryrun.json')), 'file should still exist in dryRun');

  fs.unlinkSync(path.join(pidsDir, 'dryrun.json'));
});

test('sweepRegistry: matchフィルタで特定エントリのみ対象', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, '11111.json'), JSON.stringify({
    pid: -1, script: 'poll.js', workerName: 'worker-a', startTime: '2025-01-01T00:00:00.000Z',
  }));
  fs.writeFileSync(path.join(pidsDir, '22222.json'), JSON.stringify({
    pid: -1, script: 'poll.js', workerName: 'worker-b', startTime: '2025-01-01T00:00:00.000Z',
  }));

  const results = plc.sweepRegistry(workspace, {
    match: (entry) => entry.workerName === 'worker-a',
    dryRun: false,
  });

  const cleanedA = results.cleaned.filter(c => c.pid === -1 && c.reason && c.reason.includes('not alive'));
  assert.ok(cleanedA.length >= 1, `worker-a entry should be cleaned, got cleaned: ${JSON.stringify(results.cleaned)}`);
  assert.ok(!fs.existsSync(path.join(pidsDir, '11111.json')));

  // worker-b はマッチしないので残る
  assert.ok(fs.existsSync(path.join(pidsDir, '22222.json')));

  try { fs.unlinkSync(path.join(pidsDir, '22222.json')); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
// cleanup (統合)
// ═══════════════════════════════════════════════════════════════════════════

test('cleanup: registry解除 + extraCleanup を実行する', () => {
  const plc = loadModule();

  plc.registerProcess(workspace, { script: 'test.js', startTime: MOCK_START_TIME });
  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  let extraCalled = false;
  plc.cleanup(workspace, () => { extraCalled = true; });

  assert.ok(!fs.existsSync(filePath), 'registry file should be removed');
  assert.ok(extraCalled, 'extraCleanup should be called');
});

test('cleanup: extraCleanup でエラーが発生しても registry 解除は実行される', () => {
  const plc = loadModule();

  plc.registerProcess(workspace, { script: 'test.js', startTime: MOCK_START_TIME });
  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  assert.doesNotThrow(() => {
    plc.cleanup(workspace, () => { throw new Error('extra cleanup failed'); });
  });

  assert.ok(!fs.existsSync(filePath), 'registry file should be removed even if extra throws');
});

// ═══════════════════════════════════════════════════════════════════════════
// pidsDir / pidFilePath（純粋関数、spawn不要）
// ═══════════════════════════════════════════════════════════════════════════

test('pidsDir: .gh-maestro/pids を返す', () => {
  const plc = loadModule();
  const dir = plc.pidsDir('/foo/bar');
  assert.equal(dir, path.join('/foo/bar', '.gh-maestro', 'pids'));
});

test('pidFilePath: <pid>.json を返す', () => {
  const plc = loadModule();
  const fp = plc.pidFilePath('/foo/bar', 12345);
  assert.equal(fp, path.join('/foo/bar', '.gh-maestro', 'pids', '12345.json'));
});

// ═══════════════════════════════════════════════════════════════════════════
// getParentPid / findSessionRootPid（WMI をモック化）
// ═══════════════════════════════════════════════════════════════════════════

test('getParentPid: 無効な引数で null を返す（spawn回避）', () => {
  const plc = loadModule();
  assert.equal(plc.getParentPid(0), null);
  assert.equal(plc.getParentPid(-5), null);
  assert.equal(plc.getParentPid('abc'), null);
  assert.equal(plc.getParentPid(null), null);
});

test('getParentPid: WMI成功時は親PIDを返す', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  // mockWmiSuccess は ParentProcessId クエリに対して '42' を返す
  const ppid = plc.getParentPid(99999);
  assert.equal(ppid, 42);
});

test('getParentPid: WMI空応答時は null を返す', () => {
  const plc = loadModule({ execSync: mockWmiEmpty() });
  const ppid = plc.getParentPid(99999);
  assert.equal(ppid, null);
});

test('findSessionRootPid: 関数が存在し正の整数を返す（mockWmi使用）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  assert.equal(typeof plc.findSessionRootPid, 'function');
  const rootPid = plc.findSessionRootPid();
  assert.equal(typeof rootPid, 'number');
  assert.ok(rootPid > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI_USAGE
// ═══════════════════════════════════════════════════════════════════════════

test('CLI_USAGE: 文字列が定義されている', () => {
  const plc = loadModule();
  assert.equal(typeof plc.CLI_USAGE, 'string');
  assert.ok(plc.CLI_USAGE.includes('sweep'));
  assert.ok(plc.CLI_USAGE.includes('--workspace'));
});

// ═══════════════════════════════════════════════════════════════════════════
// parseCliArgs（純粋関数、spawn不要）
// ═══════════════════════════════════════════════════════════════════════════

test('parseCliArgs: sub コマンドとフラグを通常どおりパースする', () => {
  const plc = loadModule();
  const r = plc.parseCliArgs(['sweep', '--workspace', '/ws', '--worker-name', 'issue-1-test', '--dry-run']);
  assert.equal(r.help, false);
  assert.equal(r.dryRun, true);
  assert.equal(r.workspace, '/ws');
  assert.equal(r.workerName, 'issue-1-test');
  assert.deepEqual(r.positional, ['sweep']);
});

test('parseCliArgs: --help はヘルプフラグとして認識される', () => {
  const plc = loadModule();
  const r = plc.parseCliArgs(['--help']);
  assert.equal(r.help, true);
});

test('parseCliArgs: --worker-name の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const plc = loadModule();
  const r = plc.parseCliArgs(['sweep', '--workspace', '/ws', '--worker-name', '--help']);
  assert.equal(r.help, false);
  assert.equal(r.workerName, '--help');
});

test('parseCliArgs: --workspace の値が"--dry-run"文字列でも別フラグとして誤解釈しない', () => {
  const plc = loadModule();
  const r = plc.parseCliArgs(['sweep', '--workspace', '--dry-run']);
  assert.equal(r.workspace, '--dry-run');
  assert.equal(r.dryRun, false);
});
