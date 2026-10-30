'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const storageLayout = require('../../scripts/shared/storage-layout');
const processLiveness = require('../../scripts/shared/process-liveness');

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

// ═══════════════════════════════════════════════════════════════════════════
// ProcessRef による生存観測
// ═══════════════════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════════════════
// resolveSessionPid（findSessionRootPid をモック化）
// ═══════════════════════════════════════════════════════════════════════════




// ═══════════════════════════════════════════════════════════════════════════
// 親プロセス監視
// ═══════════════════════════════════════════════════════════════════════════





// ── 受け入れ条件: PID 再利用でも生存と誤判定しない ──────────────────────





// ── startTimesMatch ─────────────────────────────────────────────────────



// ═══════════════════════════════════════════════════════════════════════════
// registerProcess / unregisterProcess
// ═══════════════════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════════════════
// bridge: dual-write / union-read / dual-delete（Issue #214 移行）
// ═══════════════════════════════════════════════════════════════════════════









// ═══════════════════════════════════════════════════════════════════════════
// bridge: acquireStartupLock の取得順序（legacy → new）
// ═══════════════════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════════════════
// ProcessRef の同一性観測
// ═══════════════════════════════════════════════════════════════════════════










// ═══════════════════════════════════════════════════════════════════════════
// findRunningInstance
// ═══════════════════════════════════════════════════════════════════════════
// 生存PIDの同一性は process-liveness の観測依存を使って検証する。











// ═══════════════════════════════════════════════════════════════════════════
// acquireStartupLock / releaseStartupLock
// ═══════════════════════════════════════════════════════════════════════════






// ═══════════════════════════════════════════════════════════════════════════
// sweepRegistry
// ═══════════════════════════════════════════════════════════════════════════











// ═══════════════════════════════════════════════════════════════════════════
// cleanup (統合)
// ═══════════════════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════════════════
// pidsDir / legacyPidsDir / pidFilePath（純粋関数、spawn不要）
// ═══════════════════════════════════════════════════════════════════════════









// ═══════════════════════════════════════════════════════════════════════════
// getParentPid / findSessionRootPid（WMI をモック化）
// ═══════════════════════════════════════════════════════════════════════════






// ═══════════════════════════════════════════════════════════════════════════
// CLI_USAGE
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// CLI引数パース（scripts/shared/workspace.js の parseFlags に委譲）
// parseFlags 自体の網羅的なエッジケースは tests/workspace.test.js でカバー済み。
// ここでは実際のCLI起動でフラグ/値衝突が安全に処理される
// （誤ってhelp表示にならない）ことだけをサブプロセス経由で確認する。
// ═══════════════════════════════════════════════════════════════════════════

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'process-lifecycle.js');
const { cleanSpawnEnv } = require('../_spawn-env');

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
    // endpoint 識別情報を持たない記録は持ち主なしとして扱い、出所を一度だけ報告する。
    const reported = r.stderr.split(/\r?\n/).filter(Boolean);
    assert.equal(reported.length, 1, r.stderr);
    assert.match(reported[0], /旧形式の記録を持ち主なしとして扱いました: .*999999999\.json$/);
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
    fs.writeFileSync(path.join(pidsDir, `${process.pid}.json`), JSON.stringify(processLiveness.writeRef({
      script: 'msg-poll.js',
      workerName: 'resident-worker',
      workspace: ws,
    }, processLiveness.captureSelf())));

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
    // 除外リスト組み立てで process-liveness の観測が実際に呼ばれる
    // 状態を作る。修復前は CLI 主経路でのみ循環 require により undefined 捕捉が TypeError を
    // 起こし、sweep 全体が落ちた（Issue #267）。死んだPIDなら WMI/PowerShell を起動しない
    //
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

test('sweep: 旧形式の孤立 lease を件数に依存しない1行で報告し、詳細一覧を保存する', () => {
  const { spawnSync } = require('child_process');
  for (const count of [1, 50]) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), `gh-maestro-sweep-leases-${count}-`));
    try {
      const leasesDir = path.join(ws, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      for (let i = 0; i < count; i += 1) {
        fs.writeFileSync(path.join(leasesDir, `issue-${i}-coder.json`), JSON.stringify({ pid: 900000 + i }));
      }

      const r = spawnSync(process.execPath, [SCRIPT, 'sweep', '--workspace', ws], {
        encoding: 'utf8',
        env: cleanSpawnEnv(),
      });
      assert.equal(r.status, 0, `sweep failed: ${r.stdout}\n${r.stderr}`);
      const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter(Boolean);
      assert.equal(lines.length, 1, `N=${count}: output must stay to one summary line: ${lines.join('\n')}`);
      assert.match(lines[0], new RegExp(`片付け済みワーカーの lease を ${count} 件削除しました`));
      assert.match(lines[0], /一覧: .*sweep-lease-report\.log/);
      assert.equal(fs.readdirSync(leasesDir).length, 0);

      const reportPath = path.join(ws, '.gh-maestro', 'sweep-lease-report.log');
      const reportLines = fs.readFileSync(reportPath, 'utf8').trim().split(/\r?\n/);
      assert.equal(reportLines.length, count);
      assert.ok(reportLines.every((line) => line.startsWith('removed lease: ')));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
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
