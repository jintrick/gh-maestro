'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const storageLayout = require('../scripts/shared/storage-layout');

// process-lifecycle.js は child-process.js の execSync に依存する（Windows WMI）。
// テストは実プロセスを0個spawnする（.claude/rules/test-process-spawn-safety.md 準拠）。
// プラットフォーム依存の execSync 呼び出しを含む関数はモックで置き換える。

// ── テスト用の一時ワークスペース ─────────────────────────────────────────

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-lifecycle-' + Date.now());
const workspace = path.join(tmpBase, 'workspace');

// PID registry の新ロケーションは OS の runtime root（storage-layout.js）配下。
// テストが開発機の実 runtime root に触れないよう、一時ディレクトリへ差し替える。
const prevRuntimeDir = process.env.GH_MAESTRO_RUNTIME_DIR;
process.env.GH_MAESTRO_RUNTIME_DIR = path.join(tmpBase, 'runtime-root');

before(() => {
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  if (prevRuntimeDir === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
  else process.env.GH_MAESTRO_RUNTIME_DIR = prevRuntimeDir;
});

// 各テスト後に process.pid の registry エントリ（新旧両ロケーション）を確実に削除する。
// registerProcess 系テストが残留させたエントリが sweepRegistry で
// テストランナー自身のプロセスを kill する事故を防ぐ。
afterEach(() => {
  const legacyFile = path.join(workspace, '.gh-maestro', 'pids', `${process.pid}.json`);
  try { if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile); } catch {}
  try {
    const newFile = path.join(storageLayout.workspaceRuntimeDir(workspace), 'pids', `${process.pid}.json`);
    if (fs.existsSync(newFile)) fs.unlinkSync(newFile);
  } catch {}
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

// PID再利用を模擬するときの「別プロセス」の起動時刻（MOCK_START_TIME と1秒以上離す）
const OTHER_START_TIME = '2025-06-02T00:00:00.000Z';

/**
 * PID再利用を模擬する execSync モック。
 * 同じPIDに対して WMI（CreationDate）の呼び出しが1回目は MOCK_START_TIME（=捕捉時の
 * 期待値）、以後は OTHER_START_TIME（=再利用された別プロセス）を返す。
 * 「捕捉後に同じPIDに別プロセスが居着いた」状況を呼び出し回数の切替で表現する。
 */
function mockWmiReuse() {
  let calls = 0;
  return (cmd, opts) => {
    const cmdStr = typeof cmd === 'string' ? cmd : '';
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('CreationDate')) {
      calls++;
      return (calls === 1 ? MOCK_START_TIME : OTHER_START_TIME) + '\n';
    }
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('ParentProcessId')) {
      return '42\n';
    }
    throw new Error(`unexpected execSync call in test: ${cmdStr.slice(0, 80)}`);
  };
}

/**
 * 起動時刻の取得失敗を模擬する execSync モック。
 * 捕捉時（1回目）は MOCK_START_TIME を返し、以後は空文字（=null 相当）を返す。
 * expectedStartTime は捕捉できたが、ポーリング中の WMI 読取が一過性で失敗する状況。
 */
function mockWmiReuseToEmpty() {
  let calls = 0;
  return (cmd, opts) => {
    const cmdStr = typeof cmd === 'string' ? cmd : '';
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('CreationDate')) {
      calls++;
      return (calls === 1 ? MOCK_START_TIME : '') + '\n';
    }
    if (cmdStr.includes('Win32_Process') && cmdStr.includes('ParentProcessId')) {
      return '42\n';
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

// ── 受け入れ条件: PID 再利用でも生存と誤判定しない ──────────────────────

test('createDeadManSwitch: PID が別プロセスに再利用された状況で生存と誤判定しない（受け入れ条件）', () => {
  const plc = loadModule({ execSync: mockWmiReuse() });
  // 捕捉時（1回目のWMI呼び出し）は MOCK_START_TIME が返る → これが期待値になる
  const expectedStartTime = plc.getProcessStartTime(process.pid);
  assert.equal(expectedStartTime, MOCK_START_TIME);
  const check = plc.createDeadManSwitch(process.pid, { expectedStartTime });
  // isProcessAlive(process.pid) は true（PID は存在する）が、起動時刻が OTHER_START_TIME に
  // 切り替わっている = 同じPIDに別プロセスが居る。startTime 不一致は確定事実なので即 false。
  assert.equal(check(), false, 'PID が再利用されていれば生存と誤判定しない');
});

test('createDeadManSwitch: expectedStartTime を渡さないと PID 再利用で居座る（対照・従来挙動）', () => {
  // 修正は「expectedStartTime を渡すことで初めて効く」性質のものである。渡し忘れが
  // 将来起きた場合、この対照テストが失敗として現れる（orchestrator 確認事項）。
  const plc = loadModule({ execSync: mockWmiReuse() });
  const check = plc.createDeadManSwitch(process.pid); // expectedStartTime なし
  assert.equal(check(), true, 'PID 再利用があっても従来どおり生存扱い（居座り）');
  assert.equal(check(), true);
  assert.equal(check(), true);
});

test('createDeadManSwitch: 起動時刻が一致する場合は生存を維持する（誤自滅しない）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const expectedStartTime = plc.getProcessStartTime(process.pid);
  assert.equal(expectedStartTime, MOCK_START_TIME);
  const check = plc.createDeadManSwitch(process.pid, { expectedStartTime });
  assert.equal(check(), true, '起動時刻が一致すれば生存を維持');
  assert.equal(check(), true);
});

test('createDeadManSwitch: 起動時刻の取得失敗（WMI 空）は生存扱い（fail-open・誤自滅しない）', () => {
  // expectedStartTime は捕捉できたが、以後の WMI 読取が空文字（null 相当）を返す一過性の
  // 失敗。fail-open を誤自滅防止側に倒し、生存扱いにする。
  const plc = loadModule({ execSync: mockWmiReuseToEmpty() });
  const expectedStartTime = plc.getProcessStartTime(process.pid);
  assert.equal(expectedStartTime, MOCK_START_TIME);
  const check = plc.createDeadManSwitch(process.pid, { expectedStartTime });
  assert.equal(check(), true, '読取失敗は生存扱い');
  assert.equal(check(), true);
});

// ── startTimesMatch ─────────────────────────────────────────────────────

test('startTimesMatch: 1秒以内の差は同一プロセスとみなす', () => {
  const plc = loadModule();
  assert.equal(plc.startTimesMatch('2025-06-01T12:00:00.000Z', '2025-06-01T12:00:00.500Z'), true);
  assert.equal(plc.startTimesMatch('2025-06-01T12:00:00.000Z', '2025-06-01T12:00:02.000Z'), false);
});

test('startTimesMatch: 不正な日付（NaN）・欠落は不一致として扱う', () => {
  const plc = loadModule();
  assert.equal(plc.startTimesMatch('not-a-date', MOCK_START_TIME), false);
  assert.equal(plc.startTimesMatch(null, MOCK_START_TIME), false);
  assert.equal(plc.startTimesMatch(undefined, MOCK_START_TIME), false);
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
// bridge: dual-write / union-read / dual-delete（Issue #214 移行）
// ═══════════════════════════════════════════════════════════════════════════

test('registerProcess: 新ロケーションに加え、旧ロケーション（legacy）にも dual-write する', () => {
  const plc = loadModule();
  plc.registerProcess(workspace, { script: 'msg-poll.js', startTime: MOCK_START_TIME });

  try {
    const legacyPath = plc.legacyPidFilePath(workspace, process.pid);
    assert.ok(fs.existsSync(legacyPath), 'legacy ロケーションにも書かれるはず');
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    assert.equal(raw.pid, process.pid);
    assert.equal(raw.script, 'msg-poll.js');
  } finally {
    plc.unregisterProcess(workspace, process.pid);
  }
});

test('unregisterProcess: 新旧両ロケーションから削除する（dual-delete）', () => {
  const plc = loadModule();
  plc.registerProcess(workspace, { script: 'test.js', startTime: MOCK_START_TIME });
  const newPath = plc.pidFilePath(workspace, process.pid);
  const legacyPath = plc.legacyPidFilePath(workspace, process.pid);
  assert.ok(fs.existsSync(newPath));
  assert.ok(fs.existsSync(legacyPath));

  plc.unregisterProcess(workspace, process.pid);
  assert.ok(!fs.existsSync(newPath));
  assert.ok(!fs.existsSync(legacyPath));
});

test('findRunningInstance: legacyロケーションのみに存在するエントリ（旧コードのプロセス）も見つかる（union-read）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const legacyDir = plc.legacyPidsDir(workspace);
  fs.mkdirSync(legacyDir, { recursive: true });
  const otherPid = process.ppid;

  fs.writeFileSync(path.join(legacyDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workerName: null, workspace, startTime: MOCK_START_TIME,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.ok(result, 'legacyのみのエントリでも見つかるはず');
    assert.equal(result.pid, otherPid);
  } finally {
    fs.unlinkSync(path.join(legacyDir, `${otherPid}.json`));
  }
});

test('findRunningInstance: 新旧両方に同一pidのエントリがあっても1回だけ判定する（dual-write後の重複排除）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const newDir = plc.pidsDir(workspace);
  const legacyDir = plc.legacyPidsDir(workspace);
  fs.mkdirSync(newDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  const otherPid = process.ppid;
  const entry = { pid: otherPid, script: 'msg-poll.js', workerName: null, workspace, startTime: MOCK_START_TIME };

  fs.writeFileSync(path.join(newDir, `${otherPid}.json`), JSON.stringify(entry));
  fs.writeFileSync(path.join(legacyDir, `${otherPid}.json`), JSON.stringify(entry));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.ok(result);
    assert.equal(result.pid, otherPid);
  } finally {
    fs.unlinkSync(path.join(newDir, `${otherPid}.json`));
    fs.unlinkSync(path.join(legacyDir, `${otherPid}.json`));
  }
});

test('sweepRegistry: legacyロケーションのみに存在する stale エントリも掃除される（union-read）', () => {
  const plc = loadModule();
  const legacyDir = plc.legacyPidsDir(workspace);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, '99996.json'), JSON.stringify({
    pid: -1, script: 'test.js', startTime: '2025-01-01T00:00:00.000Z',
  }));

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const cleaned = results.cleaned.filter(c => c.reason && c.reason.includes('not alive'));
  assert.ok(cleaned.length >= 1);
  assert.ok(!fs.existsSync(path.join(legacyDir, '99996.json')));
});

test('sweepRegistry: 新旧両方にある同一pidのstaleエントリは、両方のファイルが削除される', () => {
  const plc = loadModule();
  const newDir = plc.pidsDir(workspace);
  const legacyDir = plc.legacyPidsDir(workspace);
  fs.mkdirSync(newDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  const entry = JSON.stringify({ pid: -1, script: 'test.js', startTime: '2025-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(newDir, '99995.json'), entry);
  fs.writeFileSync(path.join(legacyDir, '99995.json'), entry);

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  assert.ok(!fs.existsSync(path.join(newDir, '99995.json')));
  assert.ok(!fs.existsSync(path.join(legacyDir, '99995.json')));
  const cleaned = results.cleaned.filter(c => c.pid === -1);
  assert.equal(cleaned.length, 1, '新旧2ファイルにまたがっていても1エントリとして報告されるはず');
});

// ═══════════════════════════════════════════════════════════════════════════
// bridge: acquireStartupLock の取得順序（legacy → new）
// ═══════════════════════════════════════════════════════════════════════════

test('acquireStartupLock: 成功時は新旧両方のロックファイルを作成する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const legacyLock = plc.legacyStartupLockPath(workspace, 'test-lock-both.js', null);
  const newLock = plc.startupLockPath(workspace, 'test-lock-both.js', null);
  try {
    assert.equal(plc.acquireStartupLock(workspace, 'test-lock-both.js', null), true);
    assert.ok(fs.existsSync(legacyLock), '旧ロケーションのロックも作られるはず');
    assert.ok(fs.existsSync(newLock));
  } finally {
    try { fs.unlinkSync(legacyLock); } catch {}
    try { fs.unlinkSync(newLock); } catch {}
  }
});

test('acquireStartupLock: 旧ロケーションを他プロセスが保持中なら新ロケーションを触らず失敗する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const legacyDir = plc.legacyPidsDir(workspace);
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyLock = plc.legacyStartupLockPath(workspace, 'test-lock-legacy-held.js', null);
  const newLock = plc.startupLockPath(workspace, 'test-lock-legacy-held.js', null);
  // 生存かつ同一性一致する他プロセス（process.ppid）が legacy ロックを保持中と偽装
  fs.writeFileSync(legacyLock, JSON.stringify({ pid: process.ppid, startTime: MOCK_START_TIME }));

  try {
    const ok = plc.acquireStartupLock(workspace, 'test-lock-legacy-held.js', null, { maxRetries: 1 });
    assert.equal(ok, false);
    assert.ok(!fs.existsSync(newLock), '旧ロケーションで失敗した場合、新ロケーションは触らないはず');
  } finally {
    try { fs.unlinkSync(legacyLock); } catch {}
  }
});

test('acquireStartupLock: 新ロケーションの取得に失敗したら旧ロケーションのロックを解放する（rollback）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const newDir = plc.pidsDir(workspace);
  fs.mkdirSync(newDir, { recursive: true });
  const legacyLock = plc.legacyStartupLockPath(workspace, 'test-lock-rollback.js', null);
  const newLock = plc.startupLockPath(workspace, 'test-lock-rollback.js', null);
  // 生存かつ同一性一致する他プロセスが新ロケーションのロックを保持中と偽装
  fs.writeFileSync(newLock, JSON.stringify({ pid: process.ppid, startTime: MOCK_START_TIME }));

  try {
    const ok = plc.acquireStartupLock(workspace, 'test-lock-rollback.js', null, { maxRetries: 1 });
    assert.equal(ok, false);
    assert.ok(!fs.existsSync(legacyLock), '新ロケーションで失敗した場合、取得済みの旧ロケーションロックは解放されるはず');
  } finally {
    try { fs.unlinkSync(newLock); } catch {}
    try { fs.unlinkSync(legacyLock); } catch {}
  }
});

test('releaseStartupLock: 新旧両方のロックを解放する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const legacyLock = plc.legacyStartupLockPath(workspace, 'test-lock-release-both.js', null);
  const newLock = plc.startupLockPath(workspace, 'test-lock-release-both.js', null);
  plc.acquireStartupLock(workspace, 'test-lock-release-both.js', null);
  assert.ok(fs.existsSync(legacyLock));
  assert.ok(fs.existsSync(newLock));

  plc.releaseStartupLock(workspace, 'test-lock-release-both.js', null);
  assert.ok(!fs.existsSync(legacyLock));
  assert.ok(!fs.existsSync(newLock));
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
// findRunningInstance
// ═══════════════════════════════════════════════════════════════════════════
// verifyProcessIdentity 経由でWMIを呼ぶため、生存PIDを扱うテストは
// mockWmiSuccess() で決定的にする（実WMI呼び出しを回避）。

test('findRunningInstance: 一致する生存エントリを返す（自PID以外・起動時刻が一致）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  // process.ppid は自プロセスとは別の生存プロセス（テストランナーの親）
  const otherPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workerName: null, workspace, startTime: MOCK_START_TIME,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.ok(result, 'マッチする生存エントリが見つかるはず');
    assert.equal(result.pid, otherPid);
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${otherPid}.json`));
  }
});

test('findRunningInstance: 起動時刻が一致しない（PID再利用）場合は重複とみなさない', () => {
  // mockWmiSuccess は常に MOCK_START_TIME を返す。登録エントリのstartTimeを
  // それとは異なる値にすることで「別プロセスが同じPIDを再利用した」状況を模擬する。
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  const otherPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workerName: null, workspace,
    startTime: '2020-01-01T00:00:00.000Z',
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.equal(result, null, 'PID再利用と判定される場合は重複として扱わない（誤って起動をブロックしない）');
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${otherPid}.json`));
  }
});

test('findRunningInstance: 自PIDのエントリは除外する（自分自身は重複とみなさない）', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, script: 'msg-poll.js', workerName: null, workspace,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.equal(result, null, '自PIDのエントリは自分自身なので除外される（WMI呼び出しに到達する前に弾かれる）');
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${process.pid}.json`));
  }
});

test('findRunningInstance: script が一致しないエントリは無視する', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, '55555.json'), JSON.stringify({
    pid: -1, script: 'poll-pr.js', workerName: null, workspace,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.equal(result, null);
  } finally {
    fs.unlinkSync(path.join(pidsDir, '55555.json'));
  }
});

test('findRunningInstance: workerName が一致しないエントリは無視する（orchestrator/worker の混同防止）', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, '44444.json'), JSON.stringify({
    pid: process.pid, script: 'msg-poll.js', workerName: 'issue-5-implement', workspace,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.equal(result, null, 'orchestrator(workerName:null) 検索は worker エントリと一致しない');
  } finally {
    fs.unlinkSync(path.join(pidsDir, '44444.json'));
  }
});

test('findRunningInstance: workerNameフィールド自体が欠落しているエントリもnull(orchestrator)として扱う', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  const otherPid = process.ppid;

  // workerName フィールド自体が無い（旧形式レジストリエントリを模擬）
  fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workspace, startTime: MOCK_START_TIME,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.ok(result, 'workerNameフィールド欠落(undefined)はnullとして扱われ、orchestrator検索にマッチするはず');
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${otherPid}.json`));
  }
});

test('findRunningInstance: workspace が一致しないエントリは無視する', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, '33333.json'), JSON.stringify({
    pid: process.pid, script: 'msg-poll.js', workerName: null, workspace: '/some/other/workspace',
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.equal(result, null);
  } finally {
    fs.unlinkSync(path.join(pidsDir, '33333.json'));
  }
});

test('findRunningInstance: 生存していないPIDのエントリは無視する', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, '99997.json'), JSON.stringify({
    pid: -1, script: 'msg-poll.js', workerName: null, workspace,
  }));

  try {
    const result = plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null });
    assert.equal(result, null);
  } finally {
    fs.unlinkSync(path.join(pidsDir, '99997.json'));
  }
});

test('findRunningInstance: registry ディレクトリが無い場合は null', () => {
  const plc = loadModule();
  const nonexistent = path.join(tmpBase, 'no-pids-dir-workspace');
  const result = plc.findRunningInstance(nonexistent, { script: 'msg-poll.js', workerName: null });
  assert.equal(result, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// acquireStartupLock / releaseStartupLock
// ═══════════════════════════════════════════════════════════════════════════

test('acquireStartupLock: 未取得の場合は取得できる', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const lockPath = plc.startupLockPath(workspace, 'test-lock.js', null);
  const legacyLockPath = plc.legacyStartupLockPath(workspace, 'test-lock.js', null);
  try {
    const ok = plc.acquireStartupLock(workspace, 'test-lock.js', null);
    assert.equal(ok, true);
    assert.ok(fs.existsSync(lockPath));
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
    try { fs.unlinkSync(legacyLockPath); } catch {}
  }
});

test('acquireStartupLock: 自分自身が既に保持している場合は再取得できない（生存かつ同一性一致）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const lockPath = plc.startupLockPath(workspace, 'test-lock.js', null);
  const legacyLockPath = plc.legacyStartupLockPath(workspace, 'test-lock.js', null);
  try {
    assert.equal(plc.acquireStartupLock(workspace, 'test-lock.js', null), true);
    // 自PIDが生存かつ同一性一致のロックを保持中 → 2回目の取得は失敗する
    assert.equal(plc.acquireStartupLock(workspace, 'test-lock.js', null, { maxRetries: 1 }), false);
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
    try { fs.unlinkSync(legacyLockPath); } catch {}
  }
});

test('acquireStartupLock: staleなロック（保持者が非生存）は奪取して取得できる', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  const lockPath = plc.startupLockPath(workspace, 'test-lock.js', null);
  const legacyLockPath = plc.legacyStartupLockPath(workspace, 'test-lock.js', null);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: -1, startTime: MOCK_START_TIME }));

  try {
    const ok = plc.acquireStartupLock(workspace, 'test-lock.js', null);
    assert.equal(ok, true, '保持者が非生存のロックは奪取されるはず');
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(holder.pid, process.pid);
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
    try { fs.unlinkSync(legacyLockPath); } catch {}
  }
});

test('releaseStartupLock: 自分が保持者なら解放する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const lockPath = plc.startupLockPath(workspace, 'test-lock.js', null);
  const legacyLockPath = plc.legacyStartupLockPath(workspace, 'test-lock.js', null);
  plc.acquireStartupLock(workspace, 'test-lock.js', null);
  assert.ok(fs.existsSync(lockPath));

  plc.releaseStartupLock(workspace, 'test-lock.js', null);
  assert.ok(!fs.existsSync(lockPath));
  try { fs.unlinkSync(legacyLockPath); } catch {}
});

test('releaseStartupLock: 自分が保持者でなければ何もしない（他プロセスのロックを誤って消さない）', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  const lockPath = plc.startupLockPath(workspace, 'test-lock.js', null);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, startTime: MOCK_START_TIME }));

  try {
    plc.releaseStartupLock(workspace, 'test-lock.js', null);
    assert.ok(fs.existsSync(lockPath), '自分の保持するロックでなければ削除されない');
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
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

test('sweepRegistry: stale registry掃除とhousekeepingを一連で実行する', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  const logDir = path.join(workspace, '.gh-maestro', 'records', 'issue', '237', 'workers');
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const staleName = 'issue-237-stale';
  const activeName = 'issue-237-active';
  const reviewPr = '237';
  const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
  const reviewLockPath = path.join(workspace, '.gh-maestro', 'records', 'pr', reviewPr, 'review', 'manager.running');
  const leasePath = path.join(workspace, '.gh-maestro', 'leases', `${activeName}.json`);
  const previousWorkers = fs.existsSync(workersPath) ? fs.readFileSync(workersPath) : null;
  fs.writeFileSync(path.join(pidsDir, 'stale.json'), JSON.stringify({
    pid: -1, script: 'worker.js', workerName: staleName,
  }));
  const noise = '{"type":"system","subtype":"thinking_tokens"}\n';
  fs.writeFileSync(path.join(logDir, `${staleName}.log`), noise);
  fs.writeFileSync(path.join(logDir, `${activeName}.log`), noise);
  const reviewLogPath = path.join(workspace, '.gh-maestro', 'records', 'pr', reviewPr, 'review', 'manager.log');
  fs.mkdirSync(path.dirname(reviewLogPath), { recursive: true });
  fs.writeFileSync(reviewLogPath, noise);
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(workersPath, JSON.stringify({ [activeName]: { pid: process.pid, startTime: null } }));
  fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, workerName: activeName }));
  fs.writeFileSync(reviewLockPath, String(process.pid));
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(logDir, `${staleName}.log`), old, old);

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    assert.ok(results.housekeeping, 'housekeeping must be owned by the lifecycle sweep');
    // 項目8: sweepはログ圧縮を行わない（圧縮は worker-exit-hook.js と手動CLIのみ）。
    // したがって stale ログも圧縮されず、中身がそのまま残る。
    assert.equal(results.housekeeping.compacted.length, 0);
    assert.equal(fs.readFileSync(path.join(logDir, `${activeName}.log`), 'utf8'), noise);
    assert.equal(fs.readFileSync(reviewLogPath, 'utf8'), noise);
    assert.equal(fs.readFileSync(path.join(logDir, `${staleName}.log`), 'utf8'), noise);
  } finally {
    for (const p of [path.join(pidsDir, 'stale.json'), path.join(pidsDir, 'active.json')]) {
      try { fs.unlinkSync(p); } catch {}
    }
    for (const p of [leasePath, reviewLockPath, workersPath]) {
      try { fs.unlinkSync(p); } catch {}
    }
    if (previousWorkers !== null) fs.writeFileSync(workersPath, previousWorkers);
  }
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
// pidsDir / legacyPidsDir / pidFilePath（純粋関数、spawn不要）
// ═══════════════════════════════════════════════════════════════════════════

test('pidsDir: runtimeRoot()/workspaces/<key>/pids を返す（新ロケーション）', () => {
  const plc = loadModule();
  const dir = plc.pidsDir(workspace);
  assert.equal(
    dir,
    path.join(storageLayout.workspaceRuntimeDir(workspace), 'pids')
  );
});

test('legacyPidsDir: <workspace>/.gh-maestro/pids を返す（旧ロケーション）', () => {
  const plc = loadModule();
  const dir = plc.legacyPidsDir(workspace);
  assert.equal(dir, path.join(workspace, '.gh-maestro', 'pids'));
});

test('pidFilePath: <pid>.json を新ロケーション配下に返す', () => {
  const plc = loadModule();
  const fp = plc.pidFilePath(workspace, 12345);
  assert.equal(fp, path.join(plc.pidsDir(workspace), '12345.json'));
});

test('legacyPidFilePath: <pid>.json を旧ロケーション配下に返す', () => {
  const plc = loadModule();
  const fp = plc.legacyPidFilePath(workspace, 12345);
  assert.equal(fp, path.join(workspace, '.gh-maestro', 'pids', '12345.json'));
});

test('pidsDir: workspace がホームディレクトリに解決される場合は throw する（Issue #214 の根本原因ガード）', () => {
  const plc = loadModule();
  assert.throws(() => plc.pidsDir(os.homedir()));
});

test('legacyPidsDir: workspace がホームディレクトリに解決される場合は throw する', () => {
  const plc = loadModule();
  assert.throws(() => plc.legacyPidsDir(os.homedir()));
});

test('registerProcess: workspace がホームディレクトリの場合は throw し、~/.gh-maestro/pids を作らない（Issue #214）', () => {
  const plc = loadModule();
  const legacyHomePids = path.join(os.homedir(), '.gh-maestro', 'pids');
  const existedBefore = fs.existsSync(legacyHomePids);
  assert.throws(() => plc.registerProcess(os.homedir(), { script: 'test.js' }));
  // throw が書き込みより先に発火するため、事前に存在しなかった場合は作られない
  if (!existedBefore) {
    assert.ok(!fs.existsSync(legacyHomePids), 'home解決時は ~/.gh-maestro/pids が作られてはならない');
  }
});

test('pidsDir: GH_MAESTRO_RUNTIME_DIR が managed root（~/.gh-maestro）と衝突する場合も throw する（assertDisjointRoots の実配線確認）', () => {
  // workspace 自体は正当でも、runtime root の誤設定（例: GH_MAESTRO_RUNTIME_DIR が
  // ~/.gh-maestro を指す）は assertValidWorkspace では検出できない。pidsDir() が
  // assertDisjointRoots() も併せて呼んでいることを確認する。
  const prevRuntimeDir = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = storageLayout.managedRoot();
  try {
    const plc = loadModule();
    assert.throws(() => plc.pidsDir(workspace));
  } finally {
    if (prevRuntimeDir === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = prevRuntimeDir;
  }
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
  assert.ok(plc.CLI_USAGE.includes('status'));
  assert.ok(plc.CLI_USAGE.includes('--script'));
  assert.ok(plc.CLI_USAGE.includes('--workspace'));
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI引数パース（scripts/shared/workspace.js の parseFlags に委譲）
// parseFlags 自体の網羅的なエッジケースは tests/workspace.test.js でカバー済み。
// ここでは実際のCLI起動でフラグ/値衝突が安全に処理される
// （誤ってhelp表示にならない）ことだけをサブプロセス経由で確認する。
// ═══════════════════════════════════════════════════════════════════════════

const SCRIPT = path.join(__dirname, '..', 'scripts', 'process-lifecycle.js');
const { cleanSpawnEnv } = require('./_spawn-env');

function runCli(args) {
  const { spawnSync } = require('child_process');
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });
}

function createStatusWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-status-cli-'));
  const pidsDir = path.join(storageLayout.workspaceRuntimeDir(ws), 'pids');
  fs.mkdirSync(pidsDir, { recursive: true });
  return { ws, pidsDir };
}

function createBrokenStatusWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-status-cli-broken-'));
  const runtimeDir = storageLayout.workspaceRuntimeDir(ws);
  const pidsDir = path.join(runtimeDir, 'pids');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(pidsDir, 'not a directory');
  return { ws, pidsDir };
}

function removeStatusWorkspace(ws) {
  try { fs.rmSync(storageLayout.workspaceRuntimeDir(ws), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

test('サブプロセス経由: --help は終了コード0でCLI_USAGEを表示する', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sweep/);
});

test('サブプロセス経由: --workspace の値が"--help"文字列だと値欠落エラーとなり、誤ってhelp表示にならない', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [SCRIPT, 'sweep', '--workspace', '--help'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('status: --script が無い場合は照会せずエラー終了する', () => {
  const { ws } = createStatusWorkspace();
  try {
    const r = runCli(['status', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /--script/);
  } finally {
    removeStatusWorkspace(ws);
  }
});

test('status: workspace を解決できない場合はエラー終了する', () => {
  const r = runCli(['status', '--workspace', os.homedir(), '--script', 'msg-poll.js']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /ワークスペースを解決できません/);
});

test('status: PID registry ディレクトリの読み取り失敗は running:false に握り潰さずエラー終了する', () => {
  const { ws } = createBrokenStatusWorkspace();
  try {
    const r = runCli(['status', '--workspace', ws, '--script', 'msg-poll.js']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /status の照会に失敗しました/);
    assert.match(r.stderr, /PID registry ディレクトリ/);
  } finally {
    removeStatusWorkspace(ws);
  }
});

test('status: 個別PID registryエントリのJSON解析失敗は running:false に握り潰さずエラー終了する', () => {
  const { ws, pidsDir } = createStatusWorkspace();
  try {
    fs.writeFileSync(path.join(pidsDir, 'broken.json'), '{ invalid json');

    const r = runCli(['status', '--workspace', ws, '--script', 'msg-poll.js']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /status の照会に失敗しました/);
    assert.match(r.stderr, /PID registry エントリ/);
  } finally {
    removeStatusWorkspace(ws);
  }
});

test('status: 停止したPID registryエントリは running:false として一意に判定する', () => {
  const { ws, pidsDir } = createStatusWorkspace();
  try {
    fs.writeFileSync(path.join(pidsDir, '999999999.json'), JSON.stringify({
      pid: 999999999,
      script: 'msg-poll.js',
      workerName: null,
      workspace: ws,
    }));

    const r = runCli(['status', '--workspace', ws, '--script', 'msg-poll.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), {
      script: 'msg-poll.js',
      workerName: null,
      running: false,
      pid: null,
    });
  } finally {
    removeStatusWorkspace(ws);
  }
});

test('status: script と workerName の組み合わせに一致する常駐プロセスだけを running と判定する', () => {
  const { ws, pidsDir } = createStatusWorkspace();
  try {
    fs.writeFileSync(path.join(pidsDir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      script: 'msg-poll.js',
      workerName: 'resident-worker',
      workspace: ws,
    }));

    const matching = runCli([
      'status', '--workspace', ws, '--script', 'msg-poll.js', '--worker-name', 'resident-worker',
    ]);
    assert.equal(matching.status, 0, matching.stderr);
    assert.deepEqual(JSON.parse(matching.stdout), {
      script: 'msg-poll.js',
      workerName: 'resident-worker',
      running: true,
      pid: process.pid,
    });

    const wrongWorker = runCli(['status', '--workspace', ws, '--script', 'msg-poll.js']);
    assert.equal(wrongWorker.status, 0, wrongWorker.stderr);
    assert.deepEqual(JSON.parse(wrongWorker.stdout), {
      script: 'msg-poll.js',
      workerName: null,
      running: false,
      pid: null,
    });

    const wrongScript = runCli([
      'status', '--workspace', ws, '--script', 'poll-pr.js', '--worker-name', 'resident-worker',
    ]);
    assert.equal(wrongScript.status, 0, wrongScript.stderr);
    assert.deepEqual(JSON.parse(wrongScript.stdout), {
      script: 'poll-pr.js',
      workerName: 'resident-worker',
      running: false,
      pid: null,
    });
  } finally {
    removeStatusWorkspace(ws);
  }
});

// ── Issue #267 回帰: CLI 主経路（require.main === module）での循環 require ──
// process-lifecycle.js は module.exports の代入を CLI ブロックより先に行うことで、
// sweepRegistry が require する shared モジュール群（worker-liveness / worker-lease /
// collect-housekeeping-exclusions）へ完全な exports を渡す。CLI 主経路でしか顕在化し
// ないため、ユニットテストではなく実サブプロセス起動で検証する。

test('サブプロセス経由: sweep は CLI 主経路でも除外リストを組み立てて exit 0 で完了する（循環 require 回帰）', () => {
  const { spawnSync } = require('child_process');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-sweep-cli-'));
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(path.join(ghDir, 'leases'), { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'records', 'pr', '42', 'review'), { recursive: true });
    // 全情報源（workers.json / lease / Review Manager .running）に「有効だが死んだ」PIDを置き、
    // 除外リスト組み立てで process-lifecycle の生存述語（isProcessAlive 等）が実際に呼ばれる
    // 状態を作る。修復前は CLI 主経路でのみ循環 require により undefined 捕捉が TypeError を
    // 起こし、sweep 全体が落ちた（Issue #267）。死んだPIDなら WMI/PowerShell を起動しない
    // （test-process-spawn-safety ルール準拠）。
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({
      'issue-1-coder': { pid: 999999999, startTime: '2025-01-01T00:00:00.000Z' },
    }));
    fs.writeFileSync(path.join(ghDir, 'leases', 'issue-2-coder.json'), JSON.stringify({
      pid: 999999999, startTime: '2025-01-01T00:00:00.000Z', workerName: 'issue-2-coder',
    }));
    fs.writeFileSync(path.join(ghDir, 'records', 'pr', '42', 'review', 'manager.running'), '999999999');

    const r = spawnSync(process.execPath, [SCRIPT, 'sweep', '--workspace', ws], {
      encoding: 'utf8',
      env: cleanSpawnEnv(),
    });
    assert.equal(r.status, 0, `sweep は exit 0 で完了すべき。stdout=${r.stdout} stderr=${r.stderr}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('サブプロセス経由: 解析不能な workers.json で sweep は fail-closed の exit 1 を返す（PR #268 指摘回帰）', () => {
  const { spawnSync } = require('child_process');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-sweep-cli-corrupt-'));
  try {
    const ghDir = path.join(ws, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    // 解析不能な workers.json。修復前は readWorkersRaw の null が「ファイル不在」と同列に
    // 扱われ、除外リストが空集合として正常返却されて kill ループ・housekeeping が続行した
    // （PR #268 レビュー指摘）。修正後は fail-closed で exit 1 を返す。
    fs.writeFileSync(path.join(ghDir, 'workers.json'), '{ broken json');
    // 生存しうるワーカーのログも置いておく: 修正前なら除外漏れのまま housekeeping 対象になる。
    fs.mkdirSync(path.join(ghDir, 'records', 'issue', '5', 'workers', 'issue-5-active'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'records', 'issue', '5', 'workers', 'issue-5-active', 'worker.log'), 'x'.repeat(1000));

    const r = spawnSync(process.execPath, [SCRIPT, 'sweep', '--workspace', ws], {
      encoding: 'utf8',
      env: cleanSpawnEnv(),
    });
    assert.equal(r.status, 1, `fail-closed で exit 1 になるべき。stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /除外リストの構築に失敗/, 'fail-closed のエラーが報告される');
    assert.ok(fs.existsSync(path.join(ghDir, 'workers.json')), 'fail-closed では破壊的処理（削除等）を行わない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('sweepRegistry: 除外リスト構築失敗時は fail-closed で kill も housekeeping も実行しない', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, 'alive.json'), JSON.stringify({
    pid: process.pid, script: 'worker.js', workerName: 'issue-fail-closed',
  }));
  // 共有部品を throw するスタブへ差し替え、除外リスト構築の失敗経路を作る。
  const chePath = require.resolve('../scripts/shared/collect-housekeeping-exclusions');
  const orig = require.cache[chePath];
  require.cache[chePath] = {
    id: chePath, filename: chePath, loaded: true,
    exports: { collectHousekeepingExclusions: () => { throw new Error('boom'); } },
  };
  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    assert.ok(results.errors.some((e) => e.includes('除外リストの構築に失敗')), `errors: ${JSON.stringify(results.errors)}`);
    assert.equal(results.killed.length, 0);
    assert.equal(results.cleaned.length, 0);
    assert.ok(!('housekeeping' in results), 'housekeeping は実行されない');
    assert.ok(fs.existsSync(path.join(pidsDir, 'alive.json')), 'kill ループはスキップされる');
  } finally {
    if (orig) require.cache[chePath] = orig; else delete require.cache[chePath];
    try { fs.unlinkSync(path.join(pidsDir, 'alive.json')); } catch {}
  }
});

test('sweepRegistry: role lease 保持者および稼働中ワーカーは PID registry にあっても kill されず保護される', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(leasesDir, { recursive: true });

  const residentPid = process.pid;
  const residentPidFile = path.join(pidsDir, `inbox-supervisor.js-${residentPid}.json`);
  const residentLeaseFile = path.join(leasesDir, 'resident-role-inbox-supervisor.json');
  const stalePidFile = path.join(pidsDir, 'stale.json');

  // inbox-supervisor の PID registry 登録（workerName なし、表示・診断用）
  fs.writeFileSync(residentPidFile, JSON.stringify({
    pid: residentPid,
    script: 'inbox-supervisor.js',
    startTime: MOCK_START_TIME,
  }));

  // inbox-supervisor の role lease（排他の正本）
  fs.writeFileSync(residentLeaseFile, JSON.stringify({
    pid: residentPid,
    workerName: 'inbox-supervisor',
    startTime: MOCK_START_TIME,
  }));

  // stale プロセス
  fs.writeFileSync(stalePidFile, JSON.stringify({
    pid: -1,
    script: 'stale-worker.js',
  }));

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    // stale は cleaned
    assert.ok(results.cleaned.some(c => c.pid === -1));
    assert.ok(!fs.existsSync(stalePidFile), 'stale ファイルは削除される');

    // resident process は kill されず、ファイルも残る
    assert.ok(!results.killed.some(k => k.pid === residentPid), 'role lease 保持者は kill されない');
    assert.ok(fs.existsSync(residentPidFile), 'role lease 保持者の registry ファイルは保護される');
  } finally {
    for (const p of [residentPidFile, residentLeaseFile, stalePidFile]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

test('sweepRegistry: workers.json の文字列 PID でも registry に workerName が無い稼働中プロセスが保護される', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(ghDir, { recursive: true });

  const activePid = process.pid;
  const activePidFile = path.join(pidsDir, `${activePid}.json`);
  const workersFile = path.join(ghDir, 'workers.json');

  // workers.json に文字列形式の PID で登録
  fs.writeFileSync(workersFile, JSON.stringify({
    'issue-99-coder': { pid: String(activePid), startTime: MOCK_START_TIME },
  }));

  // PID registry には workerName なしで登録（表示・診断用）
  fs.writeFileSync(activePidFile, JSON.stringify({
    pid: activePid,
    script: 'worker.js',
    startTime: MOCK_START_TIME,
  }));

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    assert.ok(!results.killed.some(k => k.pid === activePid), '文字列 PID のワーカーは kill されない');
    assert.ok(fs.existsSync(activePidFile), '文字列 PID ワーカーの registry ファイルは保護される');
  } finally {
    for (const p of [activePidFile, workersFile]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

test('sweepRegistry: manager.running の PID は stale registry エントリを誤って保護しない（PID再利用時のstale回収）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  const ghDir = path.join(workspace, '.gh-maestro');
  const reviewDir = path.join(ghDir, 'records', 'pr', '99', 'review');
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });

  // 死んだ正の PID (999999999) を持つ Review Manager の running ファイルと、同 PID の stale registry
  const stalePid = 999999999;
  const stalePidFile = path.join(pidsDir, `${stalePid}.json`);
  const runningFile = path.join(reviewDir, 'manager.running');

  fs.writeFileSync(runningFile, String(stalePid) + '\n');
  fs.writeFileSync(stalePidFile, JSON.stringify({
    pid: stalePid,
    script: 'legacy-stale.js',
  }));

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    // manager.running に PID が書かれていても、stale エントリは保護されず cleaned される
    assert.ok(results.cleaned.some(c => c.pid === stalePid), 'manager.running の PID は stale エントリを shield しない');
    assert.ok(!fs.existsSync(stalePidFile), 'stale ファイルは回収・削除される');
  } finally {
    for (const p of [stalePidFile, runningFile]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});


