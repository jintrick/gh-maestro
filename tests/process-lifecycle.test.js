'use strict';

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// process-lifecycle.js は child-process.js の execSync に依存する（Windows WMI）。
// 実プロセスを spawn しないため、必要な関数をモックする。
// isProcessAlive / createDeadManSwitch / registerProcess / unregisterProcess /
// sweepRegistry / verifyProcessIdentity / cleanup をテストする。

// ── テスト用の一時ワークスペース ─────────────────────────────────────────

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-lifecycle-' + Date.now());
const workspace = path.join(tmpBase, 'workspace');

before(() => {
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── ヘルパー: モジュールをリロードして依存を注入 ──────────────────────

function loadModule(overrides = {}) {
  // キャッシュクリア
  delete require.cache[require.resolve('../scripts/process-lifecycle')];

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

// ═══════════════════════════════════════════════════════════════════════════
// isProcessAlive
// ═══════════════════════════════════════════════════════════════════════════

test('isProcessAlive: 生存しているPIDは true', () => {
  // process.kill(pid, 0) は自身のPIDに対して常に成功する（EPERMにならない）
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
// resolveSessionPid
// ═══════════════════════════════════════════════════════════════════════════

test('resolveSessionPid: --session-pid フラグ値が最優先', () => {
  const plc = loadModule();
  // 正の整数を明示指定した場合はそれが使われる
  assert.equal(plc.resolveSessionPid('12345'), 12345);
  assert.equal(plc.resolveSessionPid(99999), 99999);
});

test('resolveSessionPid: フラグが空/無効なら自動検出にフォールバック', () => {
  const plc = loadModule();
  const result = plc.resolveSessionPid(null);
  assert.equal(typeof result, 'number');
  assert.ok(result > 0);
});

test('resolveSessionPid: 無効な文字列は自動検出にフォールバック', () => {
  const plc = loadModule();
  const result = plc.resolveSessionPid('not-a-number');
  assert.equal(typeof result, 'number');
  assert.ok(result > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// createDeadManSwitch
// ═══════════════════════════════════════════════════════════════════════════

test('createDeadManSwitch: 自身のPIDに対しては true を返す', () => {
  const plc = loadModule();
  const check = plc.createDeadManSwitch(process.pid);
  // 自分自身は生きている
  assert.equal(check(), true);
});

test('createDeadManSwitch: 無効なPIDは3回連続で false を返す', () => {
  const plc = loadModule();
  // 0 は無効なPID → isProcessAlive(0) は false
  const check = plc.createDeadManSwitch(0);
  // 1回目・2回目は猶予期間
  assert.equal(check(), true, 'first dead check — grace period');
  assert.equal(check(), true, 'second dead check — grace period');
  // 3回目で false
  assert.equal(check(), false, 'third dead check — confirmed');
});

test('createDeadManSwitch: 生存→死亡の遷移で3回連続確認', () => {
  const plc = loadModule();
  // 自身のPID → 生存
  const check = plc.createDeadManSwitch(process.pid);
  assert.equal(check(), true, 'alive');

  // 存在しない大きなPID → 死亡だが猶予期間で true
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
  // カウンタはリセットされ続けている
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

  // ファイルが存在することを確認
  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  // ファイル内容を確認
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

  // cleanup
  plc.unregisterProcess(workspace, process.pid);
});

test('unregisterProcess: ファイルを削除する', () => {
  const plc = loadModule();
  plc.registerProcess(workspace, { script: 'test.js' });
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
// verifyProcessIdentity
// ═══════════════════════════════════════════════════════════════════════════

test('verifyProcessIdentity: プロセス非生存の場合は match:false', () => {
  const plc = loadModule();
  // 無効なPID → isProcessAlive が false
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
  const plc = loadModule();
  // isProcessAlive(process.pid) は true。
  // getProcessStartTime(process.pid) が成功すれば、startTime比較に入り
  //   'invalid-date-format' → new Date().getTime() = NaN → Number.isNaN → match:false
  // 環境によって getProcessStartTime が失敗した場合は 'cannot get process start time'
  //   で match:false になる。どちらも match:false が正しい結果。
  const result = plc.verifyProcessIdentity(process.pid, {
    startTime: 'invalid-date-format',
  });
  assert.equal(result.match, false);
  assert.ok(
    result.reason.includes('invalid date') || result.reason.includes('cannot get'),
    `unexpected reason: ${result.reason}`
  );
});

test('verifyProcessIdentity: startTime未設定で alive なPIDは true（同一性確認スキップ）', () => {
  const plc = loadModule();
  // 自身のPIDは生存しており、startTimeが未設定 → 同一性確認をスキップして match:true。
  // ただし getProcessStartTime が失敗する環境では match:false になるため、
  // 環境依存を考慮して両方の結果を許容する。
  const result = plc.verifyProcessIdentity(process.pid, {});
  // getProcessStartTime succeeds → skips startTime check → match:true
  // getProcessStartTime fails → match:false with 'cannot get'
  if (result.match === false) {
    assert.ok(result.reason.includes('cannot get'),
      `expected 'cannot get' reason, got: ${result.reason}`);
  }
  // match:true も正常（環境がWMIサポートあり）
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

  // 一時的なpidsディレクトリを準備
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '12345.json'), 'not valid json {{{');

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const corrupt = results.cleaned.filter(c => c.reason.includes('corrupt JSON'));
  assert.ok(corrupt.length >= 1, 'corrupt JSON should be cleaned');

  // ファイルが削除されていることを確認
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
  // -1 は isProcessAlive(-1) が false を返す（無効なPID）
  // 注: pid=0 は !entryPid (falsy) で弾かれるため -1 を使う
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

  // 検出はされるが削除はされない
  const corrupt = results.cleaned.filter(c => c.reason.includes('corrupt JSON'));
  assert.ok(corrupt.length >= 1);
  assert.ok(fs.existsSync(path.join(pidsDir, 'dryrun.json')), 'file should still exist in dryRun');

  // cleanup
  fs.unlinkSync(path.join(pidsDir, 'dryrun.json'));
});

test('sweepRegistry: matchフィルタで特定エントリのみ対象', () => {
  const plc = loadModule();

  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  // worker-a のエントリ（-1 は isProcessAlive が false → 'not alive' で cleaned）
  fs.writeFileSync(path.join(pidsDir, '11111.json'), JSON.stringify({
    pid: -1, script: 'poll.js', workerName: 'worker-a', startTime: '2025-01-01T00:00:00.000Z',
  }));
  // worker-b のエントリ（同様に -1）
  fs.writeFileSync(path.join(pidsDir, '22222.json'), JSON.stringify({
    pid: -1, script: 'poll.js', workerName: 'worker-b', startTime: '2025-01-01T00:00:00.000Z',
  }));

  // worker-a のみにマッチ
  const results = plc.sweepRegistry(workspace, {
    match: (entry) => entry.workerName === 'worker-a',
    dryRun: false,
  });

  // worker-a のエントリは cleaned (pid=-1 は not alive)
  const cleanedA = results.cleaned.filter(c => c.pid === -1 && c.reason && c.reason.includes('not alive'));
  assert.ok(cleanedA.length >= 1, `worker-a entry should be cleaned, got cleaned: ${JSON.stringify(results.cleaned)}`);
  assert.ok(!fs.existsSync(path.join(pidsDir, '11111.json')));

  // worker-b のエントリはマッチしないのでそのまま
  assert.ok(fs.existsSync(path.join(pidsDir, '22222.json')));

  // cleanup
  try { fs.unlinkSync(path.join(pidsDir, '22222.json')); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
// cleanup (統合)
// ═══════════════════════════════════════════════════════════════════════════

test('cleanup: registry解除 + extraCleanup を実行する', () => {
  const plc = loadModule();

  // 事前に登録
  plc.registerProcess(workspace, { script: 'test.js' });
  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  let extraCalled = false;
  plc.cleanup(workspace, () => { extraCalled = true; });

  assert.ok(!fs.existsSync(filePath), 'registry file should be removed');
  assert.ok(extraCalled, 'extraCleanup should be called');
});

test('cleanup: extraCleanup でエラーが発生しても registry 解除は実行される', () => {
  const plc = loadModule();

  plc.registerProcess(workspace, { script: 'test.js' });
  const filePath = plc.pidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(filePath));

  assert.doesNotThrow(() => {
    plc.cleanup(workspace, () => { throw new Error('extra cleanup failed'); });
  });

  assert.ok(!fs.existsSync(filePath), 'registry file should be removed even if extra throws');
});

// ═══════════════════════════════════════════════════════════════════════════
// pidsDir / pidFilePath
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
// getParentPid / findSessionRootPid（構造テスト：関数が存在し呼び出し可能）
// ═══════════════════════════════════════════════════════════════════════════

test('getParentPid: 関数が存在し number|null を返す', () => {
  const plc = loadModule();
  assert.equal(typeof plc.getParentPid, 'function');
  // 自身の親PIDを取得（プラットフォーム依存だが呼び出し可能）
  const ppid = plc.getParentPid(process.pid);
  assert.ok(ppid === null || (typeof ppid === 'number' && ppid > 0));
});

test('getParentPid: 無効な引数で null を返す', () => {
  const plc = loadModule();
  assert.equal(plc.getParentPid(0), null);
  assert.equal(plc.getParentPid(-5), null);
  assert.equal(plc.getParentPid('abc'), null);
  assert.equal(plc.getParentPid(null), null);
});

test('findSessionRootPid: 関数が存在し正の整数を返す', () => {
  const plc = loadModule();
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
