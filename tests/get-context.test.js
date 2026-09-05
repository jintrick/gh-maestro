'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'get-context.js');
const REPO_ROOT = path.join(__dirname, '..');

// get-context の実CLI境界とGit照会は維持する。一方、読み込まれる read-state の
// 自プロセス起動時刻取得だけは、各ケースでPowerShell/WMIを起動しない固定値へ差し替える。
const FAST_CONTEXT_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-get-context-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../scripts/process-lifecycle');
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

test('WORKSPACE はGH_MAESTRO_WORKSPACEが無い場合にCWD上方探索で解決される（Unixスラッシュ）', () => {
  const env = { ...process.env };
  delete env.GH_MAESTRO_WORKSPACE;
  const r = runContext({
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  const match = r.stdout.match(/^WORKSPACE=(.+)/m);
  assert.ok(match, 'WORKSPACEが出力に含まれない');
  // スクリプトはWindowsパスをUnixスラッシュに変換して出力する
  const expected = REPO_ROOT.replace(/\\/g, '/');
  assert.equal(match[1].trim(), expected);
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
