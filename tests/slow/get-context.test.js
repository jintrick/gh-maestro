'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'get-context.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

// get-context の実CLI境界とGit照会は維持する。一方、読み込まれる read-state の
// 自プロセス起動時刻取得だけは、各ケースでPowerShell/WMIを起動しない固定値へ差し替える。
const FAST_CONTEXT_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-get-context-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../../scripts/process-lifecycle');
  const source = [
    "'use strict';",
    `const childProcess = require(${JSON.stringify(childProcessPath)});`,
    "const fixedStartTime = '2026-07-25T00:00:00.000Z';",
    'const realExecSync = childProcess.execSync;',
    'childProcess.execSync = (command, opts) => {',
    "  if (String(command).includes('Get-CimInstance Win32_Process')) return `${fixedStartTime}\\n`;",
    '  return realExecSync(command, opts);',
    '};',
    `const lifecycle = require(${JSON.stringify(lifecyclePath)});`,
    'lifecycle.getProcessStartTime = () => fixedStartTime;',
  ].join('\n');
  fs.writeFileSync(file, source, 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return file;
})();

function runContext(options = {}) {
  return spawnSync(process.execPath, ['-r', FAST_CONTEXT_PRELOAD, SCRIPT], options);
}

function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-get-context-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.GH_MAESTRO_WORKSPACE;
  return { home, env };
}

function createContextWorkspace(configText) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-get-context-workspace-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  const remote = spawnSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/test/repo.git'],
    { cwd: workspace, encoding: 'utf8' },
  );
  assert.equal(remote.status, 0, `git remote add failed: ${remote.stderr}`);
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  if (configText !== undefined) {
    fs.writeFileSync(path.join(workspace, '.gh-maestro', 'config.json'), configText, 'utf8');
  }
  return workspace;
}

test('REPO と WORKSPACE を正しいフォーマットで出力する', () => {
  const r = runContext({
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  // フォーマット: クォートなし、owner/repo形式
  assert.match(r.stdout, /^REPO=[^/\s]+\/[^\s]+/m);
  assert.match(r.stdout, /^WORKSPACE=.+/m);
  assert.match(r.stdout, /^GH_MAESTRO_WORKER=orchestrator$/m);
});

test('GH_MAESTRO_WORKER=orchestrator がセッション変数として出力される（Issue #384）', () => {
  const r = runContext({
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/);
  assert.ok(
    lines.includes('GH_MAESTRO_WORKER=orchestrator'),
    `出力に GH_MAESTRO_WORKER=orchestrator が含まれること: ${r.stdout}`
  );
});

test('test.layers宣言が無い場合はmissingをsession contextへ出力する', () => {
  const { home, env } = isolatedHome();
  const workspace = createContextWorkspace();
  try {
    const r = runContext({ cwd: workspace, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^TEST_LAYERS_STATUS=missing$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('有効なtest.layers宣言がある場合はdeclaredをsession contextへ出力する', () => {
  const { home, env } = isolatedHome();
  const workspace = createContextWorkspace(JSON.stringify({
    test: {
      layers: {
        every: { scope: 'full', command: [process.execPath, '--version'] },
      },
    },
  }));
  try {
    const r = runContext({ cwd: workspace, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^TEST_LAYERS_STATUS=declared$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('壊れたtest.layersでもcontextを出力し、終了コード0で完了する', () => {
  const { home, env } = isolatedHome();
  const workspace = createContextWorkspace('{ broken');
  try {
    const r = runContext({ cwd: workspace, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^\[gh-maestro session context\]$/m);
    assert.match(r.stdout, /^TEST_LAYERS_STATUS=invalid$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('WORKSPACE はGH_MAESTRO_WORKSPACEが無い場合にCWD上方探索で解決される（Unixスラッシュ）', () => {
  const workspace = createContextWorkspace();
  const subDir = path.join(workspace, 'sub', 'deep');
  fs.mkdirSync(subDir, { recursive: true });
  const env = { ...process.env };
  delete env.GH_MAESTRO_WORKSPACE;
  try {
    const r = runContext({
      cwd: subDir,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const match = r.stdout.match(/^WORKSPACE=(.+)/m);
    assert.ok(match, 'WORKSPACEが出力に含まれない');
    // スクリプトはWindowsパスをUnixスラッシュに変換して出力する
    const expected = workspace.replace(/\\/g, '/');
    assert.equal(match[1].trim(), expected);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('BASE_BRANCH が出力に含まれる', () => {
  const { mkdtempSync, rmSync } = require('fs');
  const { execSync } = require('child_process');
  const os = require('os');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-branch-'));
  try {
    // 既知のブランチを持つ git リポジトリ fixture を作成し、
    // detached HEAD 等の呼び出し元の状態に依存せず BASE_BRANCH が必ず出力される状態で検証する。
    // git init のみでデフォルトブランチ（main）が作られ、commit は不要。
    execSync('git init', { cwd: tmp, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/test/repo.git', { cwd: tmp, stdio: 'pipe' });
    fs.mkdirSync(path.join(tmp, '.gh-maestro'));

    const r = runContext({
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^BASE_BRANCH=.+/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('orchestrator.json に sessionId がある場合は SESSION_ID が出力される', () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('fs');
  const { execSync } = require('child_process');
  const os = require('os');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-session-'));
  const env = { ...process.env };
  delete env.GH_MAESTRO_WORKSPACE;
  try {
    execSync('git init', { cwd: tmp, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/test/repo.git', { cwd: tmp, stdio: 'pipe' });
    const msgStateDir = path.join(tmp, '.gh-maestro', 'msg-state');
    mkdirSync(msgStateDir, { recursive: true });
    writeFileSync(
      path.join(msgStateDir, 'orchestrator.json'),
      JSON.stringify({
        schemaVersion: 2,
        initialized: true,
        sessionId: 'test-uuid-abc-123',
        readByIssue: {},
        sinceByIssue: {},
      }),
      'utf8'
    );

    const r = runContext({
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^SESSION_ID=test-uuid-abc-123$/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('orchestrator.json に sessionId が空文字または存在しない場合は SESSION_ID が出力されない', () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('fs');
  const { execSync } = require('child_process');
  const os = require('os');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-nosession-'));
  const env = { ...process.env };
  delete env.GH_MAESTRO_WORKSPACE;
  try {
    execSync('git init', { cwd: tmp, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/test/repo.git', { cwd: tmp, stdio: 'pipe' });
    const msgStateDir = path.join(tmp, '.gh-maestro', 'msg-state');
    mkdirSync(msgStateDir, { recursive: true });
    writeFileSync(
      path.join(msgStateDir, 'orchestrator.json'),
      JSON.stringify({ schemaVersion: 2, initialized: true, sessionId: '' }),
      'utf8'
    );

    const r = runContext({
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.includes('SESSION_ID='), false, '空文字の sessionId は出力されないこと');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
