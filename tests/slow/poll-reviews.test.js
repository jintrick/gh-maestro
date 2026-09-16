'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isValidCommentId,
  isValidPrCommentId,
  buildPrCommentRelayEvents,
  formatTestStatusEvent,
} = require('../../scripts/poll-reviews.js');






const { pollDegradationTransition } = require('../../scripts/poll-reviews.js');



// ── reviewTerminalEvent（Issue #289: CLOSED も終端として扱う） ──────────────
const { reviewTerminalEvent } = require('../../scripts/poll-reviews.js');




// ── extractTestDeclaration & evaluateTestDeclaration ────────────────────────
const { extractTestDeclaration, evaluateTestDeclaration } = require('../../scripts/poll-reviews.js');
const { TEST_RESULT_MARKER, LEGACY_TEST_RESULT_MARKER } = require('../../scripts/shared/test-declaration');

function fullDeclarationBody(commit = 'a1b2c3d4e5', fail = 0, pass = 1826, scope = 'full') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}, pass: ${pass})
- **実行件数**: \`${fail + pass}\`
- **実行元**: \`test-runner\`
- **実行範囲**: \`${scope}\``;
}












// ── CLI: workspace 解決（サブプロセス経由） ─────────────────────────────────
// workspace 解決は gh 呼び出しより前に行われるため、この検証だけなら実 gh 呼び出しは発生しない。

test('[WORKSPACE] 位置引数がホームディレクトリと衝突する場合、生の例外ではなくワークスペース解決エラーで exit 1 する（Issue #214）', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-fakehome-'));
  try {
    const script = path.join(__dirname, '..', '..', 'scripts', 'poll-reviews.js');
    const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const env = { ...process.env, [envKey]: fakeHome };
    delete env.GH_MAESTRO_WORKSPACE;

    const r = spawnSync(process.execPath, [script, '999', fakeHome], { encoding: 'utf8', timeout: 10000, env });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /ワークスペースを解決できません/);
    assert.doesNotMatch(r.stderr, /assertValidWorkspace/, `生の例外スタックトレースが漏れてはならない: ${r.stderr}`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('CLI --help documents the lightweight review-event suppression flag', () => {
  const script = path.join(__dirname, '..', '..', 'scripts', 'poll-reviews.js');
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--no-review-manager/);
  assert.match(result.stdout, /inline\/formalレビューの取得・中継を行わず/);
});

test('poll-reviews --no-review-manager skips inline/formal APIs while retaining PR comments and test evaluation', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-reviews-lightweight-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-reviews-runtime-'));
  const logPath = path.join(workspace, 'gh-calls.jsonl');
  const preloadPath = path.join(workspace, 'fake-gh-preload.js');
  const script = path.join(__dirname, '..', '..', 'scripts', 'poll-reviews.js');
  const head = '1234567890abcdef1234567890abcdef12345678';
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const childProcess = require('child_process');
const logPath = process.env.GH_MAESTRO_TEST_GH_LOG;
const head = ${JSON.stringify(head)};
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (command !== 'gh') return originalSpawnSync.apply(this, arguments);
  fs.appendFileSync(logPath, JSON.stringify(args) + '\\n', 'utf8');
  if (args[0] === 'repo' && args[1] === 'view') {
    return { status: 0, stdout: 'fixture/repo\\n', stderr: '' };
  }
  if (args[0] === 'pr' && args[1] === 'view' && args.includes('state,headRefOid,author')) {
    return { status: 0, stdout: 'OPEN|' + head + '|owner\\n', stderr: '' };
  }
  if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
    return { status: 0, stdout: JSON.stringify({ comments: [
      { id: 'IC_test', author: { login: 'owner' }, body: 'keep this comment' },
    ] }) + '\\n', stderr: '' };
  }
  if (args[0] === 'api') {
    return { status: 0, stdout: '123|src/file.js|1|reviewer|must not be relayed\\n', stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
};
`, 'utf8');

  let stdout = '';
  let stderr = '';
  const env = {
    ...process.env,
    GH_MAESTRO_RUNTIME_DIR: runtime,
    GH_MAESTRO_TEST_GH_LOG: logPath,
  };
  const child = spawn(process.execPath, [
    '-r', preloadPath, script, '42', workspace, '0', '--session-pid', String(process.pid), '--no-review-manager',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closePromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const outputPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`poll-reviews output timeout: ${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('PR_COMMENT:owner:keep this comment')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  let calls = [];

  try {
    await outputPromise;
    assert.match(stdout, /TEST_STATUS:NONE:/);
    assert.doesNotMatch(stdout, /REVIEW_COMMENT:/);
    assert.doesNotMatch(stdout, /PR_REVIEW:/);
    calls = fs.readFileSync(logPath, 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    if (child.exitCode === null) child.kill();
    await closePromise;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }

  assert.equal(calls.some((args) => args[0] === 'api'), false, '軽量モードでレビューAPIを呼んではならない');
  assert.equal(calls.some((args) => args[0] === 'pr' && args.includes('state,headRefOid,author')), true);
  assert.equal(calls.some((args) => args[0] === 'pr' && args.includes('comments')), true);
});
