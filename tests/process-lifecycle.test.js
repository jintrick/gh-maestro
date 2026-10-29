'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const storageLayout = require('../scripts/shared/storage-layout');
const processLiveness = require('../scripts/shared/process-liveness');
const { createResourceLiveness } = require('./helpers/process-liveness-test-double');

// process-lifecycle.js は child-process.js の execSync に依存する（Windows WMI）。
// テストは実プロセスを0個spawnする。
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
    const childProcessPath = require.resolve('../scripts/shared/child-process');
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

  const lifecycle = require('../scripts/process-lifecycle');
  lifecycle._setLiveness(overrides.liveness || processLiveness.createLiveness({
    probePid: (pid) => {
      try {
        process.kill(Number(pid), 0);
        return 'alive';
      } catch (error) {
        return error && error.code === 'ESRCH' ? 'dead' : 'unknown';
      }
    },
    readStartTime: () => MOCK_START_TIME,
  }));
  return lifecycle;
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
// process-liveness public API
// ═══════════════════════════════════════════════════════════════════════════

test('observe: endpointless PR1 recordはPIDの生死によらず持ち主なしとしてdeadを返し、PIDを照会しない', () => {
  loadModule();
  const probed = [];
  const liveness = require('../scripts/shared/process-liveness').createLiveness({
    probePid: (pid) => { probed.push(pid); return pid === 4242 ? 'alive' : pid === 4343 ? 'dead' : 'unknown'; },
    readStartTime: () => MOCK_START_TIME,
  });
  for (const pid of [4242, 4343, 4444]) {
    const ref = liveness.readRef({ pid, startTime: MOCK_START_TIME, legacyEndpointless: true });
    assert.equal(liveness.observe(ref), 'dead');
  }
  assert.deepEqual(probed, []);
});

test('ProcessRef: OS resource識別子を不透明な文字列として保存・復元できる', () => {
  const liveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'alive' });
  const ref = liveness.captureProcess(4242, 'resource-id-4242');
  const record = liveness.writeRef({ startTime: MOCK_START_TIME }, ref);

  assert.equal(typeof ref, 'string');
  assert.equal(liveness.observe(ref), 'alive');
  assert.equal(liveness.sameRef(ref, liveness.readRef(record)), true);
  assert.equal(liveness.readRef({ pid: 0, resourceKey: 'bad' }), null);
});

test('watchParent: PID消失は3回連続で確認し、生存でカウンターを戻す', () => {
  loadModule();
  let states = ['dead', 'dead', 'alive', 'dead', 'dead', 'dead'];
  const liveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => states.shift() || 'dead' });
  const check = liveness.watchParent(liveness.captureProcess(4242, 'parent-resource'));

  assert.equal(check(), true);
  assert.equal(check(), true);
  assert.equal(check(), true, 'alive resets the consecutive-dead count');
  assert.equal(check(), true);
  assert.equal(check(), true);
  assert.equal(check(), false);
});

test('watchParent: OS resourceの死亡を連続観測し、unknownは猶予する', () => {
  const liveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'dead' });
  const check = liveness.watchParent(liveness.captureProcess(4242, 'dead-parent-resource'));
  assert.equal(check(), true, 'resource disappearance is confirmed across three observations');
  assert.equal(check(), true);
  assert.equal(check(), false);

  const unavailable = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' });
  const keepAlive = unavailable.watchParent(unavailable.captureProcess(4242, 'unknown-parent-resource'));
  assert.equal(keepAlive(), true);
});

test('observe: endpointを持つ記録のprobe失敗はunknown、PIDだけの記録はPIDを照会せずdead', () => {
  loadModule();
  let probes = 0;
  const liveness = processLiveness.createLiveness({
    probePid: () => { probes++; throw new Error('probe failed'); },
    readStartTime: () => { throw new Error('start time unavailable'); },
  });
  assert.equal(liveness.observe(liveness.readRef({ pid: 4242, legacyEndpointless: true })), 'dead');
  assert.equal(probes, 0, 'PIDだけの記録ではPIDを照会しない');

  const failedProbe = liveness.readRef({ pid: 4242, startTime: MOCK_START_TIME });
  assert.equal(liveness.observe(failedProbe), 'unknown');
  assert.equal(probes, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// registerProcess / unregisterProcess
// ═══════════════════════════════════════════════════════════════════════════

test('registerProcess: 起動時刻を取得できなくてもOS資源を登録する', () => {
  const plc = loadModule();
  plc._setLiveness(processLiveness.createLiveness({
    probePid: () => 'alive',
    readStartTime: () => null,
  }));
  const filePath = plc.pidFilePath(workspace, process.pid);
  const entry = plc.registerProcess(workspace, {
    script: 'msg-poll.js',
    workerName: 'test-worker',
  });
  assert.equal(typeof entry.resourceKey, 'string');
  assert.equal(fs.existsSync(filePath), true, 'resource reference is stored without a start-time lookup');
  plc.unregisterProcess(workspace, process.pid);
});

test('registerProcess: startTime が明示指定されればそれを使う', () => {
  const plc = loadModule();
  const customStart = '2025-01-15T10:30:00.000Z';
  plc._setLiveness(processLiveness.createLiveness({
    probePid: () => 'alive',
    readStartTime: () => customStart,
  }));
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
  plc._setLiveness(processLiveness.createLiveness({
    probePid: () => 'alive',
    readStartTime: () => MOCK_START_TIME,
  }));
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

test('unregisterProcess: expected identity不一致の新しいregistryを削除しない', () => {
  const plc = loadModule();
  plc._setLiveness(processLiveness.createLiveness({
    probePid: () => 'alive',
    readStartTime: () => '2026-07-29T00:00:00.424Z',
  }));
  const entry = plc.registerProcess(workspace, {
    script: 'worker-supervisor.js',
    workerName: null,
    startTime: '2026-07-29T00:00:00.424Z',
  });
  const newPath = plc.pidFilePath(workspace, entry.pid);
  const legacyPath = plc.legacyPidFilePath(workspace, entry.pid);

  plc.unregisterProcess(workspace, entry.pid, {
    script: entry.script,
    workerName: entry.workerName,
    resourceKey: 'different-resource',
  });
  assert.equal(fs.existsSync(newPath), true);
  assert.equal(fs.existsSync(legacyPath), false);

  plc.unregisterProcess(workspace, entry.pid, {
    script: entry.script,
    workerName: entry.workerName,
    resourceKey: entry.resourceKey,
  });
  assert.equal(fs.existsSync(newPath), false);
  assert.equal(fs.existsSync(legacyPath), false);
});

test('registry と起動ロックは runtime のみに作成し旧レコードを参照しない', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const ws = path.join(tmpBase, 'runtime-only');
  fs.mkdirSync(ws, { recursive: true });
  const oldDir = plc.legacyPidsDir(ws);
  const entry = plc.registerProcess(ws, { script: 'msg-poll.js', startTime: MOCK_START_TIME });
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(plc.acquireStartupLock(ws, 'example.js', null), true);
  assert.equal(fs.existsSync(oldDir), false);
  assert.ok(fs.existsSync(plc.startupLockPath(ws, 'example.js', null)));
  plc.releaseStartupLock(ws, 'example.js', null);
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, `${process.ppid}.json`);
  fs.writeFileSync(oldFile, JSON.stringify({ pid: process.ppid, script: 'old.js', workspace: ws, startTime: MOCK_START_TIME }));
  assert.equal(plc.findRunningInstance(ws, { script: 'old.js' }), null);
  plc.sweepRegistry(ws, { match: () => true, dryRun: true });
  assert.ok(fs.existsSync(oldFile));
  plc.unregisterProcess(ws, entry.pid);
});

test('findRunningInstances: runtime registry 読み取り失敗を伝播する', () => {
  const plc = loadModule();
  const ws = path.join(tmpBase, 'broken-runtime');
  fs.mkdirSync(ws, { recursive: true });
  const dir = plc.pidsDir(ws);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'not a directory');
  assert.throws(() => plc.findRunningInstances(ws, { failOnReadError: true }), /読み取れません/);
});

test('findRunningInstances: 起動判定中に対象registryのPID欠落・不正値を見つけたら中止する', () => {
  const plc = loadModule();
  const ws = path.join(tmpBase, 'invalid-runtime-entry');
  const dir = plc.pidsDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '12345.json');
  fs.writeFileSync(filePath, JSON.stringify({
    pid: 'not-a-pid', script: 'msg-poll.js', workerName: null, workspace: ws,
  }));

  assert.throws(() => plc.findRunningInstance(ws, {
    script: 'msg-poll.js', workerName: null, failOnReadError: true,
  }), /PIDが不正/);
});

test('findRunningInstances: 起動判定中に対象registryのJSON破損を空扱いしない', () => {
  const plc = loadModule();
  const ws = path.join(tmpBase, 'corrupt-runtime-entry');
  const dir = plc.pidsDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, '12345.json');
  fs.writeFileSync(filePath, '{broken');

  assert.throws(() => plc.findRunningInstance(ws, {
    script: 'msg-poll.js', workerName: null, failOnReadError: true,
  }), /エントリを読み取れません/);
});

// ═══════════════════════════════════════════════════════════════════════════
// endpointを持たないPR1記録は、PIDが存在しても世代を判別できないためunknownにする。

test('observe: endpointを持たないPR1 recordは生存PIDでもdeadを返す', () => {
  const liveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'alive' });
  const ref = liveness.readRef({ pid: 4242, startTime: MOCK_START_TIME, legacyEndpointless: true });
  assert.equal(liveness.observe(ref), 'dead');
});
// findRunningInstance
// ═══════════════════════════════════════════════════════════════════════════
// verifyProcessIdentity 経由でWMIを呼ぶため、生存PIDを扱うテストは
// mockWmiSuccess() で決定的にする（実WMI呼び出しを回避）。

test('findRunningInstance: endpointを持たない生存PR1 recordは持ち主なしとして稼働中に含めない', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  // process.ppid は自プロセスとは別の生存プロセス（テストランナーの親）
  const otherPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workerName: null, workspace,
    startTime: MOCK_START_TIME, legacyEndpointless: true,
  }));

  try {
    assert.equal(plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null }), null);
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${otherPid}.json`));
  }
});

test('findRunningInstance: registerProcessで保存した表記違いのworkspaceも見つかる', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const registeredWorkspace = process.platform === 'win32'
    ? workspace.toUpperCase()
    : `${workspace}${path.sep}..${path.sep}${path.basename(workspace)}`;
  const registeredPid = process.pid;

  plc.registerProcess(registeredWorkspace, {
    script: 'msg-poll.js',
    workerName: null,
    startTime: MOCK_START_TIME,
  });

  try {
    // registerProcess はテストランナー自身のPIDを書き込むため、検索時だけ
    // 自PID除外の比較対象を親プロセスへ切り替える。registry自体は実装経路で生成する。
    const originalPid = process.pid;
    Object.defineProperty(process, 'pid', { value: process.ppid, configurable: true });
    try {
      const result = plc.findRunningInstance(storageLayout.canonicalWorkspace(workspace), {
        script: 'msg-poll.js',
        workerName: null,
      });
      assert.ok(result, '登録時と検索時のworkspace表記が異なっても見つかるはず');
      assert.equal(result.pid, registeredPid);
      assert.equal(result.workspace, registeredWorkspace);
    } finally {
      Object.defineProperty(process, 'pid', { value: originalPid, configurable: true });
    }
  } finally {
    plc.unregisterProcess(registeredWorkspace, registeredPid);
  }
});

test('findRunningInstance: PIDだけのPR1 recordはstartTimeによらず稼働中に含めない', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  // process.ppid は自プロセスとは別の生存プロセス（テストランナーの親）
  const otherPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workerName: null, workspace,
    startTime: '2020-01-01T00:00:00.000Z', legacyEndpointless: true,
  }));

  try {
    assert.equal(plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null }), null);
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

test('findRunningInstance: workerName欠落のPR1 recordもendpointlessなら稼働中に含めない', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  // process.ppid は自プロセスとは別の生存プロセス（テストランナーの親）
  const otherPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
    pid: otherPid, script: 'msg-poll.js', workspace,
    startTime: MOCK_START_TIME, legacyEndpointless: true,
  }));

  try {
    assert.equal(plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null }), null);
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

test('findRunningInstance: 識別情報が片方だけのエントリは判定不能として拒否する', () => {
  const plc = loadModule({
    liveness: createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' }),
  });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  const ownerPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${ownerPid}.json`), JSON.stringify({
    pid: ownerPid, script: 'msg-poll.js', workerName: null, workspace, instanceId: 'only-instance',
  }));

  try {
    assert.throws(() => plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null }), /生死を判定できません/);
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${ownerPid}.json`));
  }
});

test('findRunningInstance: 識別情報のない生存PIDのエントリは持ち主なしとして稼働中に含めない', () => {
  const plc = loadModule({
    liveness: createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' }),
  });
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  const ownerPid = process.ppid;

  fs.writeFileSync(path.join(pidsDir, `${ownerPid}.json`), JSON.stringify({
    pid: ownerPid, script: 'msg-poll.js', workerName: null, workspace,
  }));

  try {
    assert.equal(plc.findRunningInstance(workspace, { script: 'msg-poll.js', workerName: null }), null);
  } finally {
    fs.unlinkSync(path.join(pidsDir, `${ownerPid}.json`));
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
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startTime: MOCK_START_TIME }));

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

for (const [label, raw] of [
  ['JSON構文', 'not valid json {{{'],
  ['null', 'null'],
  ['配列', '[1, 2, 3]'],
  ['文字列', '"just a string"'],
  ['PID欠落', '{"script":"test.js"}'],
]) {
  test(`sweepRegistry: ${label} の不正な記録を保持し処理を中断する`, () => {
    const plc = loadModule();
    const dir = plc.pidsDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, raw);
    try {
      const result = plc.sweepRegistry(workspace);
      assert.ok(result.errors.some(error => error.includes(file)));
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
      assert.deepEqual(result.killed, []);
      assert.deepEqual(result.cleaned, []);
    } finally { fs.unlinkSync(file); }
  });
}

test('sweepRegistry: process resource が dead のエントリは cleaned', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, '99998.json'), JSON.stringify({
    pid: 2147483647,
    script: 'test.js',
    startTime: '2025-01-01T00:00:00.000Z',
  }));

  const results = plc.sweepRegistry(workspace, { dryRun: false });

  const deadResources = results.cleaned.filter(c => c.reason === 'process resource is dead');
  assert.ok(deadResources.length >= 1, `dead resource should be cleaned, got: ${JSON.stringify(results.cleaned)}`);
  assert.ok(!fs.existsSync(path.join(pidsDir, '99998.json')));
});

test('findRunningInstances / sweepRegistry: startTime欠落でもdead PIDは発見対象外として回収する', () => {
  const plc = loadModule();
  const isolatedWorkspace = path.join(tmpBase, 'missing-start-dead');
  fs.mkdirSync(isolatedWorkspace, { recursive: true });
  const pid = process.pid + 51000;
  const entryPath = plc.pidFilePath(isolatedWorkspace, pid);
  const checker = processLiveness.createLiveness({
    probePid: (observedPid) => observedPid === pid ? 'dead' : 'unknown',
    readStartTime: () => { throw new Error('dead PID must not need a start-time read'); },
  });
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, JSON.stringify({
    pid,
    script: 'poll-pr.js',
    workerName: 'dead-worker',
    workspace: isolatedWorkspace,
    startTime: null,
  }));

  const matches = plc.findRunningInstances(isolatedWorkspace, {
    script: 'poll-pr.js', workerName: 'dead-worker', liveness: checker,
  });
  assert.deepEqual(matches, []);
  const result = plc.sweepRegistry(isolatedWorkspace, {
    match: (entry) => entry.pid === pid,
    liveness: checker,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cleaned.map((item) => item.pid), [pid]);
  assert.equal(fs.existsSync(entryPath), false);
});

test('sweepRegistry: housekeeping exclusions reuse the state observed for each registry entry', () => {
  const plc = loadModule();
  const collectExclusions = require('../scripts/shared/collect-housekeeping-exclusions');
  const isolatedWorkspace = path.join(tmpBase, 'sweep-state-cache');
  const pid = 52001;
  const startTime = '2025-06-01T12:00:00.000Z';
  const entryPath = plc.pidFilePath(isolatedWorkspace, pid);
  const workersPath = path.join(isolatedWorkspace, '.gh-maestro', 'workers.json');
  const calls = { probe: 0, readStartTime: 0 };
  const checker = processLiveness.createLiveness({
    probePid: (observedPid) => {
      assert.equal(observedPid, pid);
      calls.probe++;
      return 'alive';
    },
    readStartTime: (observedPid) => {
      assert.equal(observedPid, pid);
      calls.readStartTime++;
      return startTime;
    },
  });
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.mkdirSync(path.dirname(workersPath), { recursive: true });
  const resourceRef = checker.captureProcess(pid, 'sweep-worker', 'instance-sweep-worker');
  const entry = checker.writeRef({
    script: 'worker.js', workerName: 'sweep-worker', workspace: isolatedWorkspace, startTime,
  }, resourceRef);
  fs.writeFileSync(entryPath, JSON.stringify(entry));
  fs.writeFileSync(workersPath, JSON.stringify({ 'sweep-worker': entry }));
  collectExclusions._setLiveness(checker);

  try {
    const result = plc.sweepRegistry(isolatedWorkspace, { liveness: checker, dryRun: true });
    assert.deepEqual(result.errors, []);
    assert.equal(calls.probe, 2, 'one observation for workers.json and one for the registry state map');
    assert.equal(calls.readStartTime, 0, '生存確認ではプロセス起動時刻を照会しない');
    assert.equal(fs.existsSync(entryPath), true, 'dryRun retains the registry entry');
  } finally {
    collectExclusions._setLiveness(null);
    try { fs.unlinkSync(entryPath); } catch {}
    try { fs.rmSync(isolatedWorkspace, { recursive: true, force: true }); } catch {}
  }
});

test('sweepRegistry: stale registry掃除とhousekeepingを一連で実行する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
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
    pid: 2147483647, resourceKey: 'dead-stale-registry', instanceId: 'dead-stale-instance',
    script: 'worker.js', workerName: staleName,
  }));
  const noise = '{"type":"system","subtype":"thinking_tokens"}\n';
  fs.writeFileSync(path.join(logDir, `${staleName}.log`), noise);
  fs.writeFileSync(path.join(logDir, `${activeName}.log`), noise);
  const reviewLogPath = path.join(workspace, '.gh-maestro', 'records', 'pr', reviewPr, 'review', 'manager.log');
  fs.mkdirSync(path.dirname(reviewLogPath), { recursive: true });
  fs.writeFileSync(reviewLogPath, noise);
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(workersPath, JSON.stringify({ [activeName]: { pid: process.pid, resourceKey: 'active-worker', instanceId: 'active-worker-instance', startTime: MOCK_START_TIME } }));
  fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, resourceKey: 'active-lease', instanceId: 'active-lease-instance', startTime: MOCK_START_TIME, workerName: activeName }));
  fs.writeFileSync(reviewLockPath, JSON.stringify({ pid: process.pid, resourceKey: 'active-review-manager', instanceId: 'active-review-instance', startTime: MOCK_START_TIME }));
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(logDir, `${staleName}.log`), old, old);

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    assert.ok(results.housekeeping, `housekeeping must be owned by the lifecycle sweep: ${JSON.stringify(results.errors)}`);
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
  const runningFile = path.join(workspace, '.gh-maestro', 'records', 'pr', '409', 'review', 'manager.running');
  fs.mkdirSync(path.dirname(runningFile), { recursive: true });
  fs.writeFileSync(runningFile, '999999999\n', 'utf8');

  const results = plc.sweepRegistry(workspace, { dryRun: true });

  assert.ok(results.errors.some(error => error.includes('dryrun.json')));
  assert.ok(fs.existsSync(path.join(pidsDir, 'dryrun.json')), 'file should still exist in dryRun');
  assert.ok(fs.existsSync(runningFile), 'manager.running のstale回収もdryRunでは行わない');

  fs.unlinkSync(path.join(pidsDir, 'dryrun.json'));
  fs.unlinkSync(runningFile);
});

test('sweepRegistry: matchフィルタで特定エントリのみ対象', () => {
  const plc = loadModule();
  const pidsDir = plc.pidsDir(workspace);
  fs.mkdirSync(pidsDir, { recursive: true });

  fs.writeFileSync(path.join(pidsDir, '11111.json'), JSON.stringify({
    pid: 2147483647, script: 'poll.js', workerName: 'worker-a', startTime: '2025-01-01T00:00:00.000Z',
  }));
  fs.writeFileSync(path.join(pidsDir, '22222.json'), JSON.stringify({
    pid: 2147483647, script: 'poll.js', workerName: 'worker-b', startTime: '2025-01-01T00:00:00.000Z',
  }));

  const results = plc.sweepRegistry(workspace, {
    match: (entry) => entry.workerName === 'worker-a',
    dryRun: false,
  });

  const cleanedA = results.cleaned.filter(c => c.pid === 2147483647 && c.reason === 'process resource is dead');
  assert.ok(cleanedA.length >= 1, `worker-a dead resource should be cleaned, got cleaned: ${JSON.stringify(results.cleaned)}`);
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

test('process-lifecycle はClaude親プロセスのPIDを解決しない', () => {
  const plc = loadModule({ execSync: () => { throw new Error('must not inspect parent processes'); } });
  assert.equal('getParentPid' in plc, false);
  assert.equal('findSessionRootPid' in plc, false);
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
  const residentPidFile = path.join(pidsDir, `worker-supervisor.js-${residentPid}.json`);
  const residentLeaseFile = path.join(leasesDir, 'resident-role-worker-supervisor.json');
  const stalePidFile = path.join(pidsDir, 'stale.json');
  const residentRef = processLiveness.captureProcess(residentPid, {
    workspace, kind: 'resident', name: 'worker-supervisor',
    instanceId: 'worker-supervisor-test-instance',
  });
  const residentMetadata = processLiveness.writeRef({}, residentRef);

  // worker-supervisor の PID registry 登録（workerName なし、表示・診断用）
  fs.writeFileSync(residentPidFile, JSON.stringify({
    pid: residentPid,
    resourceKey: residentMetadata.resourceKey,
    instanceId: residentMetadata.instanceId,
    script: 'worker-supervisor.js',
    startTime: MOCK_START_TIME,
  }));

  // worker-supervisor の role lease（排他の正本）
  fs.writeFileSync(residentLeaseFile, JSON.stringify({
    pid: residentPid,
    resourceKey: residentMetadata.resourceKey,
    instanceId: residentMetadata.instanceId,
    workerName: 'worker-supervisor',
    startTime: MOCK_START_TIME,
  }));

  // stale プロセス
  fs.writeFileSync(stalePidFile, JSON.stringify({
    pid: 2147483647, startTime: '2000-01-01T00:00:00.000Z',
    script: 'stale-worker.js',
  }));

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    // stale は cleaned
    assert.ok(results.cleaned.some(c => c.pid === 2147483647));
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

test('sweepRegistry: OS resourceのないmanager.runningとregistryはunknownのまま保持する', () => {
  const liveness = createResourceLiveness({ useRealResources: false, probeEndpoint: () => 'unknown' });
  const plc = loadModule({ liveness });
  const pidsDir = plc.pidsDir(workspace);
  const ghDir = path.join(workspace, '.gh-maestro');
  const reviewDir = path.join(ghDir, 'records', 'pr', '99', 'review');
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });

  // 起動時刻のない manager.running と同 PID の stale registry。旧 marker は PID が生きているため unknown。
  const stalePid = process.ppid;
  const stalePidFile = path.join(pidsDir, `${stalePid}.json`);
  const runningFile = path.join(reviewDir, 'manager.running');

  fs.writeFileSync(runningFile, String(stalePid) + '\n');
  fs.writeFileSync(stalePidFile, JSON.stringify({
    pid: stalePid, startTime: '2000-01-01T00:00:00.000Z',
    script: 'legacy-stale.js',
  }));

  try {
    const results = plc.sweepRegistry(workspace, { liveness, dryRun: false });
    assert.ok(results.errors.some(error => error.includes('判定できません')));
    assert.ok(fs.existsSync(stalePidFile), '旧形式が判定不能なら関連記録を保持する');
  } finally {
    for (const p of [stalePidFile, runningFile]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

test('sweepRegistry: PIDが生存中の旧PID-only manager.running は持ち主なしとして中断せず回収する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const ghDir = path.join(workspace, '.gh-maestro');
  const reviewDir = path.join(ghDir, 'records', 'pr', '409', 'review');
  const runningFile = path.join(reviewDir, 'manager.running');
  const reviewLog = path.join(reviewDir, 'manager.log');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(runningFile, `${process.pid}\n`, 'utf8');
  fs.writeFileSync(reviewLog, 'review manager log\n', 'utf8');

  try {
    const result = plc.sweepRegistry(workspace, { dryRun: false });
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(runningFile), false, '持ち主のいない旧形式markerは stale として回収する');
  } finally {
    for (const p of [runningFile, reviewLog]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

test('registerProcess: meta.pid と追加メタデータを指定して登録・取得・解除できる（process.pidと異なる子PIDを直接検証）', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const customPid = process.pid + 50000;
  const checker = processLiveness.createLiveness({
    probePid: (pid) => pid === customPid ? 'alive' : 'dead',
    readStartTime: () => MOCK_START_TIME,
  });
  const resourceIdentity = {
    workspace, kind: 'review-job', name: 'review-job-pr-415-job-1',
    instanceId: 'review-job-test-instance',
  };
  checker.captureProcess(customPid, resourceIdentity);
  const entry = plc.registerProcess(workspace, {
    pid: customPid,
    script: 'review-job',
    workerName: 'review-job-pr-415-job-1',
    pr: 415,
    jobId: 'job-1',
    aspect: 'correctness',
    leafIds: ['leaf-1'],
    startTime: MOCK_START_TIME,
    resourceKey: processLiveness.resourceKeyFor(resourceIdentity),
    instanceId: resourceIdentity.instanceId,
    liveness: checker,
  });

  assert.equal(entry.pid, customPid);
  assert.equal(entry.script, 'review-job');
  assert.equal(entry.pr, 415);
  assert.equal(entry.jobId, 'job-1');
  assert.equal(entry.aspect, 'correctness');

  // 保存先ファイル名と保存された pid の値を直接検証
  const customPidFile = path.join(plc.pidsDir(workspace), `${customPid}.json`);
  const selfPidFile = path.join(plc.pidsDir(workspace), `${process.pid}.json`);
  assert.ok(fs.existsSync(customPidFile), 'meta.pid のファイル名で保存される');
  assert.ok(!fs.existsSync(selfPidFile), 'process.pid のファイル名では保存されない');

  const fileData = JSON.parse(fs.readFileSync(customPidFile, 'utf8'));
  assert.equal(fileData.pid, customPid);
  assert.equal(fileData.script, 'review-job');
  assert.equal(fileData.workerName, 'review-job-pr-415-job-1');
  assert.equal(fileData.pr, 415);
  assert.equal(fileData.jobId, 'job-1');

  // findRunningInstances で子PID・メタデータが照合できること（allowSelfなしで取得可能）
  const instances = plc.findRunningInstances(workspace, {
    script: 'review-job',
    liveness: checker,
  });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].pid, customPid);
  assert.equal(instances[0].jobId, 'job-1');
  assert.equal(instances[0].pr, 415);

  // 解除
  plc.unregisterProcess(workspace, customPid);
  assert.ok(!fs.existsSync(customPidFile), 'unregisterProcess で customPid のファイルが削除される');
  const instancesAfter = plc.findRunningInstances(workspace, {
    script: 'review-job',
    liveness: checker,
  });
  assert.equal(instancesAfter.length, 0);
});

test('registerProcess: テスト実行中はPID registryを作成してもworkspace登録を残さない', () => {
  assert.equal(storageLayout.isNodeTestContext(), true, '前提: Node test runnerのコンテキストで実行されている');
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const testWorkspace = path.join(tmpBase, 'register-unregistered-workspace');
  const customPid = process.pid + 50001;
  const resourceIdentity = {
    workspace: testWorkspace, kind: 'worker', name: 'test-register-unregistered',
    instanceId: 'test-register-unregistered-instance',
  };
  const checker = processLiveness.createLiveness({
    probePid: (pid) => pid === customPid ? 'alive' : 'dead',
  });
  checker.captureProcess(customPid, resourceIdentity);
  const entry = plc.registerProcess(testWorkspace, {
    pid: customPid,
    script: 'test-register-unregistered',
    startTime: MOCK_START_TIME,
    resourceKey: processLiveness.resourceKeyFor(resourceIdentity),
    instanceId: resourceIdentity.instanceId,
    liveness: checker,
  });

  const runtimeDir = storageLayout.workspaceRuntimeDir(testWorkspace);
  assert.equal(entry.workspace, testWorkspace);
  assert.ok(fs.existsSync(path.join(runtimeDir, 'pids', `${customPid}.json`)), 'PIDレコードは作成される');
  assert.ok(!fs.existsSync(path.join(runtimeDir, 'workspace.json')), 'workspace登録manifestは作成されない');
  assert.equal(
    storageLayout.listRegisteredWorkspaces().includes(storageLayout.canonicalWorkspace(testWorkspace)),
    false,
    'テストworkspaceを常駐registryへ追加しない',
  );

  plc.unregisterProcess(testWorkspace, customPid);
});

test('registerProcess: 不正な meta.pid は throw する', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  assert.throws(() => plc.registerProcess(workspace, { pid: 0 }));
  assert.throws(() => plc.registerProcess(workspace, { pid: -1 }));
  assert.throws(() => plc.registerProcess(workspace, { pid: 'abc' }));
});

test('sweepRegistry: 稼働中 Review Manager PR に属する review-job は保護される', () => {
  const plc = loadModule({ execSync: mockWmiSuccess() });
  const pidsDir = plc.pidsDir(workspace);
  const ghDir = path.join(workspace, '.gh-maestro');
  const reviewDir = path.join(ghDir, 'records', 'pr', '415', 'review');
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });

  const activePid = process.pid;
  const runningFile = path.join(reviewDir, 'manager.running');
  const jobPidFile = path.join(pidsDir, `${activePid}.json`);

  // Review Manager を生存として記録
  fs.writeFileSync(runningFile, JSON.stringify({ pid: activePid, startTime: MOCK_START_TIME }));

  // review-job を PID registry に登録
  fs.writeFileSync(jobPidFile, JSON.stringify({
    pid: activePid,
    script: 'review-job',
    pr: 415,
    jobId: 'job-1',
    startTime: MOCK_START_TIME,
  }));

  try {
    const results = plc.sweepRegistry(workspace, { dryRun: false });
    assert.ok(!results.killed.some(k => k.pid === activePid), '稼働中 RM 配下のジョブは kill されない');
    assert.ok(fs.existsSync(jobPidFile), '稼働中 RM 配下のジョブレコードは保護される');
  } finally {
    for (const p of [jobPidFile, runningFile]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

test('acquireStartupLock: 同一性不明の保持者のロックを残して中断する', () => {
  const plc = loadModule();
  const lp = plc.startupLockPath(workspace, 'unknown-holder.js', null);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const holderPid = process.pid + 1;
  const raw = JSON.stringify({ pid: holderPid, startTime: MOCK_START_TIME });
  fs.writeFileSync(lp, raw);
  const observed = [];
  const checker = processLiveness.createLiveness({
    probePid: (pid) => {
      observed.push(pid);
      return pid === process.pid ? 'alive' : 'unknown';
    },
    readStartTime: () => MOCK_START_TIME,
  });
  try {
    assert.throws(
      () => plc.acquireStartupLock(workspace, 'unknown-holder.js', null, { liveness: checker }),
      /判定できません/
    );
    assert.ok(observed.includes(holderPid), 'acquireLockAt must use the checker supplied by acquireStartupLock');
    assert.equal(fs.readFileSync(lp, 'utf8'), raw);
  } finally { fs.unlinkSync(lp); }
});
