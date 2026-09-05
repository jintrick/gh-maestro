'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const lifecycle = require('../../scripts/process-lifecycle');
const TEST_PROCESS_START_TIME = '2026-07-25T00:00:00.000Z';
lifecycle.getProcessStartTime = () => TEST_PROCESS_START_TIME;
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'spawn-worker.js');
const {
  shouldPruneStaleWorker,
  establishOrchestratorBaseline,
  parseWorkerArgs,
  ensureStatusPaneForWorkspace,
  _setEnsureStatusPane,
} = require(SCRIPT);
const readStateLib = require('../../scripts/shared/read-state');
const fs = require('fs');
const os = require('os');

const TEST_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-test-ws-'));
const TEST_SESSION_ID = 'test-valid-session-uuid';
readStateLib.initializeState(TEST_WORKSPACE, 'orchestrator', { sessionId: TEST_SESSION_ID });

// 実CLIのargv境界は維持しつつ、各子プロセスのモジュール初期化で発生する
// WindowsのWMI照会だけを固定値へ差し替える。PID再利用を含む実照合は
// tests/process-lifecycle.test.js の専用ケースで実行する。
const FAST_CLI_PRELOAD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-spawn-cli-preload-'));
  const file = path.join(dir, 'preload.js');
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  const lifecyclePath = require.resolve('../../scripts/process-lifecycle');
  const leasePath = require.resolve('../../scripts/shared/worker-lease');
  const statusPanePath = require.resolve('../../scripts/shared/ensure-status-pane');
  const supervisorPath = require.resolve('../../scripts/shared/ensure-worker-supervisor');
  const source = [
    "'use strict';",
    `const childProcess = require(${JSON.stringify(childProcessPath)});`,
    `const fixedStartTime = ${JSON.stringify(TEST_PROCESS_START_TIME)};`,
    'const realExecSync = childProcess.execSync;',
    'const isAlive = (pid) => {',
    '  try { process.kill(Number(pid), 0); return true; }',
    "  catch (e) { return e && e.code !== 'ESRCH'; }",
    '};',
    'childProcess.execSync = (command, opts) => {',
    "  if (String(command).includes('Get-CimInstance Win32_Process')) {",
    '    const match = /ProcessId=(\\d+)/.exec(String(command));',
    '    return match && isAlive(Number(match[1])) ? `${fixedStartTime}\\n` : "";',
    '  }',
    '  return realExecSync(command, opts);',
    '};',
    `const lifecycle = require(${JSON.stringify(lifecyclePath)});`,
    'lifecycle.getProcessStartTime = () => fixedStartTime;',
    `const lease = require(${JSON.stringify(leasePath)});`,
    'lease._setGetProcessStartTime(() => fixedStartTime);',
    `const statusPane = require(${JSON.stringify(statusPanePath)});`,
    "statusPane.ensureStatusPane = () => ({ ok: false, stage: 'test', error: 'injected' });",
    `const supervisor = require(${JSON.stringify(supervisorPath)});`,
    'supervisor._setSpawn(() => ({ pid: 99990, on: () => {}, unref: () => {} }));',
    'supervisor._setFindRunningInstance(() => null);',
    'supervisor._setFindSessionRootPid(() => null);',
    'supervisor._setIsResidentLeaseLive(() => false);',
  ].join('\n');
  fs.writeFileSync(file, source, 'utf8');
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return file;
})();

// Issue #425 のCLI統合テストは各ケースのworkspaceを分離したまま、同じ最小Git fixtureを
// コピーして使う。ケースごとの git init/config/add/commit は、検証対象ではない固定準備であり、
// Windowsでは子プロセス待ちを積み上げる。実プロセス・実argv・失敗時のrollback検証は維持する。
let gitTemplate;
function ensureGitTemplate() {
  if (gitTemplate) return;
  gitTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-spawn-git-template-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: gitTemplate, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(gitTemplate, 'README.md'), '# test\n', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'initial commit');
  process.once('exit', () => {
    try { fs.rmSync(gitTemplate, { recursive: true, force: true }); } catch {}
  });
}

function copyGitTemplate(workspace) {
  ensureGitTemplate();
  fs.cpSync(gitTemplate, workspace, { recursive: true });
}

process.on('exit', () => {
  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  } catch {}
});

function run(args, env = {}) {
  const hasSessionId = args.includes('--session-id');
  const wsIdx = args.indexOf('--workspace');
  const targetWs = wsIdx !== -1 && args[wsIdx + 1] ? args[wsIdx + 1] : TEST_WORKSPACE;
  const effectiveArgs = [...args];
  if (wsIdx === -1 && !args.includes('--help') && !args.includes('-h')) {
    effectiveArgs.push('--workspace', TEST_WORKSPACE);
  }
  if (!hasSessionId && !args.includes('--help') && !args.includes('-h')) {
    // Ensure the target workspace has valid orchestrator session initialized
    if (!readStateLib.readState(targetWs, 'orchestrator').state?.sessionId) {
      readStateLib.initializeState(targetWs, 'orchestrator', { sessionId: TEST_SESSION_ID });
    }
    effectiveArgs.push('--session-id', TEST_SESSION_ID);
  }
  return spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT, ...effectiveArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function parseRejects(args, pattern) {
  const result = parseWorkerArgs(args);
  assert.ok(result.errors.length > 0, `expected parse error for ${args.join(' ')}`);
  assert.match(result.errors.map(e => e.message).join('\n'), pattern);
}

// headless起動になったため WEZTERM_PANE は不要。引数バリデーションの検証には追加の環境変数は要らない。
const BASE_ENV = {};

// 生存判定を注入して、実プロセスに触れずに stale 判定だけを検証する
const ALIVE = () => true;
const DEAD = () => false;

test('ensureStatusPaneForWorkspace: 起動時に保証ヘルパーを呼び、失敗結果を起動失敗へ変換しない', () => {
  let captured = null;
  _setEnsureStatusPane((params) => {
    captured = params;
    return { ok: false, stage: 'launch', error: 'WezTerm unavailable' };
  });
  try {
    const result = ensureStatusPaneForWorkspace('C:\\workspace');
    assert.deepEqual(result, { ok: false, stage: 'launch', error: 'WezTerm unavailable' });
    assert.deepEqual(captured, {
      workspace: 'C:\\workspace',
      scriptsPath: path.dirname(SCRIPT),
    });
  } finally {
    _setEnsureStatusPane(null);
  }
});

test('ensureStatusPaneForWorkspace: 予期しない例外も吸収する', () => {
  _setEnsureStatusPane(() => { throw new Error('unexpected'); });
  try {
    assert.deepEqual(ensureStatusPaneForWorkspace('C:\\workspace'), {
      ok: false,
      stage: 'unknown',
      error: 'unexpected',
    });
  } finally {
    _setEnsureStatusPane(null);
  }
});

// ── shouldPruneStaleWorker（stale worker除去判定） ────────────────────────────
// 実障害: 新規ワーカー起動のたびに、たまたま休止中（正常）だったセッション再開系
// ワーカーがworkers.jsonから消え、二度とresumeされなくなっていた。

test('shouldPruneStaleWorker: プロセスが生存していれば除去しない', () => {
  const result = shouldPruneStaleWorker({ pid: 5, agentId: 'agy' }, () => ({ id: 'agy' }), ALIVE);
  assert.equal(result, false);
});

test('shouldPruneStaleWorker: プロセス不在でもagentConfigが解決できれば除去しない（正常な休止）', () => {
  // 全エージェントがセッション再開方式のため、プロセス不在は1ターン完了ごとの正常な状態。
  const result = shouldPruneStaleWorker({ pid: 5, agentId: 'agy' }, () => ({ id: 'agy' }), DEAD);
  assert.equal(result, false);
});

test('shouldPruneStaleWorker: agentConfigが解決できない場合はfail-safeで除去する', () => {
  const result = shouldPruneStaleWorker({ pid: 5, agentId: 'unknown-agent' }, () => null, DEAD);
  assert.equal(result, true);
});

test('shouldPruneStaleWorker: resolveAgentが例外を投げてもfail-safeで除去する', () => {
  const result = shouldPruneStaleWorker(
    { pid: 5, agentId: 'broken' },
    () => { throw new Error('boom'); },
    DEAD,
  );
  assert.equal(result, true);
});

test('shouldPruneStaleWorker: agentIdが無ければfail-safeで除去する', () => {
  const result = shouldPruneStaleWorker(
    { pid: 5, agentId: null },
    () => { throw new Error('should not be called'); },
    DEAD,
  );
  assert.equal(result, true);
});

test('shouldPruneStaleWorker: pidが無くagentIdも解決できなければ除去する', () => {
  const result = shouldPruneStaleWorker({ pid: null, agentId: 'gone' }, () => null, DEAD);
  assert.equal(result, true);
});

test('--skill がないとエラー終了する', () => {
  parseRejects(['--issue', '1', '--description', 'test', '--repo', 'o/r'], /--skill/);
});

test('--description がないとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '1', '--repo', 'o/r'], /--description/);
});

// ── --description のバリデーション ────────────────────────────────────────────
// 実障害: --description はworkerName（worktreeディレクトリ名・gitブランチ名の一部）に
// そのまま使われるにもかかわらず、空でないことしか検証していなかった。
// "../../../"のようなパストラバーサル値でworktreeDirがpath.resolve()により
// 意図した.gh-maestro/worktrees/配下から脱出しうる、スペース・gitの特殊文字混入で
// git branch作成が壊れる等の危険があった。

test('--description にパストラバーサル文字列(../)を含むとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', '../../../etc', '--repo', 'o/r'], /--description/);
});

test('--description にスラッシュを含むとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'foo/bar', '--repo', 'o/r'], /--description/);
});

test('--description にスペースを含むとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'foo bar', '--repo', 'o/r'], /--description/);
});

test('--description が51文字以上だとエラー終了する', () => {
  const tooLong = 'a'.repeat(51);
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', tooLong, '--repo', 'o/r'], /--description/);
});

test('--description の英数字・ハイフン・アンダースコアはバリデーションを通過する', () => {
  // 実在しない --agent を渡し、エージェント解決（worktree作成より前）で確実に停止させる。
  // 全引数を妥当にすると worktree を作り実エージェントを起動してしまうため、
  // 引数バリデーションだけを見たいテストは必ず副作用の手前で止める。
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'explore-auth_v2',
    '--repo', 'o/r', '--agent', 'nonexistent-agent-for-test'], BASE_ENV);
  assert.notEqual(r.status, 0);
  // description自体のバリデーションでは落ちず、後段（エージェント解決）で止まることを確認
  assert.doesNotMatch(r.stderr, /--description は英数字/);
  assert.match(r.stderr, /nonexistent-agent-for-test/);
});

test('--issue がないとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--description', 'test', '--repo', 'o/r'], /--issue/);
});

test('--issue が非数値だとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', 'abc', '--description', 'test', '--repo', 'o/r'], /正の整数/);
});

test('--issue が 0 だとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '0', '--description', 'test', '--repo', 'o/r'], /正の整数/);
});

test('--issue が負数だとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '-1', '--description', 'test', '--repo', 'o/r'], /正の整数/);
});

test('--repo がないとエラー終了する', () => {
  parseRejects(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'test'], /--repo/);
});

// [無効化] このテストは実リポジトリを workspace として使い、実ワークスペースの
// .gh-maestro/msg-state/orchestrator.json を上書き・削除する（既読状態が失われ
// msg-poll が過去コメントを再送する実害が発生した）。安全な形に書き直すまで無効化する。
// test('クローズ済みPRのブランチは新規起動せず、副作用も発生させない（実リポジトリ状態）', () => {
//   // PR #350 はこのリポジトリで CLOSED のまま残る既知のブランチ。
//   // 実際の gh pr list --state all を使い、spawn-worker.js のガード位置そのものを検証する。
//   const workerName = 'issue-349-senior-coder-split-review-aspects';
//   const workspace = path.resolve(__dirname, '..', '..');
//   const worktreeDir = path.join(workspace, '.gh-maestro', 'worktrees', workerName);
//   const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
//   const workersBefore = fs.existsSync(workersPath) ? fs.readFileSync(workersPath, 'utf8') : null;
// 
//   readStateLib.initializeState(workspace, 'orchestrator', { sessionId: 'valid-test-session' });
//   try {
//     const r = run([
//       '--skill', 'gh-maestro-senior-coder', '--short-prompt', 'test',
//       '--issue', '349', '--description', 'split-review-aspects', '--repo', 'jintrick/gh-maestro',
//       '--workspace', workspace, '--agent', 'agy',
//       '--session-id', 'valid-test-session',
//     ], BASE_ENV);
// 
//     assert.notEqual(r.status, 0);
//     assert.match(r.stderr, /issue-349-senior-coder-split-review-aspects/);
//     assert.match(r.stderr, /クローズ済みPR #350/);
//     assert.equal(fs.existsSync(worktreeDir), false, '遮断時はworktreeを作成しない');
//     const workersAfter = fs.existsSync(workersPath) ? fs.readFileSync(workersPath, 'utf8') : null;
//     assert.equal(workersAfter, workersBefore, '遮断時はリース・workers.jsonを書き換えない');
//   } finally {
//     try {
//       fs.rmSync(path.join(workspace, '.gh-maestro', 'msg-state', 'orchestrator.json'), { force: true });
//     } catch {}
//   }
// });

test('gh-maestro-base で --prompt-file がないとエラー終了する', () => {
  const r = run([
    '--skill', 'gh-maestro-base',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prompt-file/);
});

// ── --help ──────────────────────────────────────────────────────────────────

test('--help はUsageを表示して終了コード0', () => {
  const r = run(['--help'], BASE_ENV);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node spawn-worker\.js/);
  assert.match(r.stdout, /--prompt-file/);
  assert.match(r.stdout, /--execution-id/);
});

test('-h はUsageを表示して終了コード0', () => {
  const r = parseWorkerArgs(['-h']);
  assert.equal(r.help, true);
  assert.deepEqual(r.errors, []);
});

// ── --prompt-file ─────────────────────────────────────────────────────────

test('--prompt-file で存在しないファイルを指定するとエラー終了する', () => {
  const fs = require('fs');
  const os = require('os');
  const missing = path.join(os.tmpdir(), 'gh-maestro-test-prompt-file-missing.md');
  const r = run([
    '--skill', 'gh-maestro-base',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--prompt-file', missing,
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prompt-file/);
});

test('--short-prompt と --prompt-file を同時指定するとエラー終了する', () => {
  const r = parseWorkerArgs([
    '--skill', 'gh-maestro-base',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--short-prompt', 'inline prompt',
    '--prompt-file', 'C:\\tmp\\prompt.md',
    '--session-id', TEST_SESSION_ID,
  ]);
  assert.equal(r.help, false);
  assert.match(r.errors.map(e => e.message).join('\n'), /--short-prompt と --prompt-file は同時に指定できません/);
});

test('--prompt-file の内容が gh-maestro-base の必須チェックを満たす（バリデーションを通過する）', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-promptfile-ok-'));
  const promptFile = path.join(tmp, 'prompt.md');
  fs.writeFileSync(promptFile, 'バッククォート ` を含む長文プロンプト');
  try {
    const r = run([
      '--skill', 'gh-maestro-base',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--prompt-file', promptFile,
      '--agent', 'nonexistent',
    ], BASE_ENV);
    // --prompt-file自体は受理され、後段の（無関係な）--agent解決エラーで落ちることを確認する
    // （gh-maestro-base の --prompt-file 必須チェックでは落ちない = 有効なプロンプトとして扱われた証拠）
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /--prompt-file が必要です/);
    assert.match(r.stderr, /nonexistent/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--short-prompt は短い安全なメッセージを受け付ける', () => {
  const r = run([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--short-prompt', 'Issue 1 follow-up',
    '--agent', 'nonexistent',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /--short-prompt は1行/);
  assert.match(r.stderr, /nonexistent/);
});

test('--short-prompt は改行またはシェル特殊文字を拒否して --prompt-file へ誘導する', () => {
  for (const prompt of ['first\nsecond', 'run `command`', 'value $HOME', 'quote "text"', 'path\\name']) {
    const r = parseWorkerArgs([
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--short-prompt', prompt,
      '--session-id', TEST_SESSION_ID,
    ], BASE_ENV);
    assert.equal(r.help, false, prompt);
    assert.match(r.errors.map(e => e.message).join('\n'), /--short-prompt は1行/, prompt);
    assert.match(r.errors.map(e => e.message).join('\n'), /--prompt-file/, prompt);
  }
});

test('廃止した --prompt は未知のフラグとして拒否する', () => {
  const r = parseWorkerArgs([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--prompt', 'legacy prompt',
    '--session-id', TEST_SESSION_ID,
  ], BASE_ENV);
  assert.equal(r.help, false);
  assert.match(r.errors.map(e => e.message).join('\n'), /未知のフラグ/);
  assert.match(r.errors.map(e => e.message).join('\n'), /--prompt/);
});
// ── 未知フラグの拒否 ──────────────────────────────────────────────────────────

test('未知のフラグを指定するとエラー終了する（黙って無視しない）', () => {
  const r = parseWorkerArgs([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--typo-flag', 'value',
    '--session-id', TEST_SESSION_ID,
  ], BASE_ENV);
  assert.equal(r.help, false);
  assert.match(r.errors.map(e => e.message).join('\n'), /未知のフラグ/);
  assert.match(r.errors.map(e => e.message).join('\n'), /--typo-flag/);
});

test('WEZTERM_PANE が未設定でも WEZTERM 由来の理由では失敗しない（headless化で不要になった）', () => {
  const envWithoutPane = { ...process.env };
  delete envWithoutPane.WEZTERM_PANE;
  // 副作用（worktree作成・エージェント起動）の手前で止めるため、実在しない --agent を渡す
  const r = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT, '--skill', 'gh-maestro-coder', '--issue', '1',
    '--description', 'test', '--repo', 'o/r', '--agent', 'nonexistent-agent-for-test'],
  { encoding: 'utf8', env: envWithoutPane });

  assert.doesNotMatch(r.stderr, /WEZTERM_PANE/);
});

// ── link-node-modules の解決 ──────────────────────────────────────────────────

test('link-node-modules がリポジトリ内パスから解決できる', () => {
  const nm = path.join(__dirname, '..', '..', 'scripts', 'shared', 'link-node-modules');
  assert.doesNotThrow(() => {
    const resolved = require.resolve(nm);
    assert.ok(resolved.endsWith('link-node-modules.js'));
  });
  const mod = require(nm);
  assert.ok(mod.linkNodeModules);
  assert.equal(typeof mod.linkNodeModules, 'function');
});

test('link-node-modules がインストール先と同構造のディレクトリから解決できる', () => {
  const tmpdir = require('os').tmpdir();
  const { mkdtempSync, copyFileSync } = require('fs');
  const { rmSync } = require('fs');
  const tmp = mkdtempSync(path.join(tmpdir, 'gh-maestro-test-linknm-'));
  try {
    const srcNm = path.join(__dirname, '..', '..', 'scripts', 'shared', 'link-node-modules.js');
    const destNm = path.join(tmp, 'link-node-modules.js');
    copyFileSync(srcNm, destNm);

    // 別のプロセスで require してキャッシュの影響を排除
    const verify = spawnSync(process.execPath, ['-e', `
      const mod = require(${JSON.stringify(destNm)});
      if (typeof mod.linkNodeModules !== 'function') process.exit(1);
      console.log('OK');
    `], { encoding: 'utf8' });
    assert.equal(verify.status, 0);
    assert.match(verify.stdout, /^OK/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── agent 解決 ────────────────────────────────────────────────────────────────

// ── ワーカーエントリ構築 ────────────────────────────────────────────────────────
// spawn-worker.js は新規ワーカー登録時に worker-entry.js::normalizeWorkerEntry を
// 使ってエントリを構築する（buildWorkerEntry という別実装は持たない）。
// ここでは workers.json に実際に書き込まれる形（観測可能な振る舞い）を検証する。

test('新規ワーカー登録エントリは pid/startTime/logPath/agentId/issue を含む', () => {
  const { normalizeWorkerEntry } = require('../../scripts/shared/worker-entry');
  const entry = normalizeWorkerEntry({
    pid: 123, startTime: '2026-07-25T00:00:00.000Z', logPath: 'C:/ws/w.log', agentId: 'claude', issue: 51,
  });
  assert.equal(entry.pid, 123);
  assert.equal(entry.startTime, '2026-07-25T00:00:00.000Z');
  assert.equal(entry.logPath, 'C:/ws/w.log');
  assert.equal(entry.agentId, 'claude');
  assert.equal(entry.issue, 51);
  assert.equal(typeof entry.issue, 'number');
});

test('新規ワーカー登録エントリは issue を数値に変換する（文字列で渡されても Number() される）', () => {
  const { normalizeWorkerEntry } = require('../../scripts/shared/worker-entry');
  const entry = normalizeWorkerEntry({ pid: 456, agentId: 'agy', issue: '99' });
  assert.equal(entry.issue, 99);
  assert.equal(typeof entry.issue, 'number');
});

test('新規ワーカー登録エントリは paneId を持たない（null）ためレガシーkill-pane経路が誤発火しない', () => {
  const { normalizeWorkerEntry } = require('../../scripts/shared/worker-entry');
  const entry = normalizeWorkerEntry({ pid: 1, agentId: 'claude', issue: 7 });
  assert.equal(entry.paneId, null);
});

test('新規ワーカー登録エントリは notifierPid を持たない（null）ため remove-worker等がレガシーnotifierをkillしようとしない', () => {
  const { normalizeWorkerEntry } = require('../../scripts/shared/worker-entry');
  const entry = normalizeWorkerEntry({ pid: 1, agentId: 'claude', issue: 7 });
  assert.equal(entry.notifierPid, null);
});

// ── agent 解決 ────────────────────────────────────────────────────────────────

test('--agent で存在しないエージェントを指定した場合はエラー終了する', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-agent-'));
  try {
    fs.mkdirSync(path.join(tmp, '.gh-maestro'), { recursive: true });
    // config.json を意図的に作らない → デフォルトにも無いエージェントIDはエラー

    const r = run([
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--agent', 'nonexistent',
    ], { HOME: tmp, USERPROFILE: tmp });

    assert.notEqual(r.status, 0, 'exit code should be non-zero');
    assert.match(r.stderr, /nonexistent/, 'error should name the missing agent');
    assert.match(r.stderr, /config\.json/, 'error should reference config.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 引数パースは scripts/shared/workspace.js の parseFlags に委譲している。
// parseFlags 自体の網羅的なエッジケースは tests/workspace.test.js でカバー済みのため、
// ここではフラグ/値衝突が実際のCLI起動でも安全に処理されることだけを確認する。

test('--description の値が"--issue"文字列と一致する場合、値欠落として安全にエラー終了する（フラグ誤認しない）', () => {
  // parseFlags は '--'始まりの値を許容しない設計（safe-by-default）。
  // 誤ってフラグとして解釈されるのではなく、値欠落エラーとして扱われることを確認する。
  const r = parseWorkerArgs([
    '--skill', 'gh-maestro-coder', '--issue', '1', '--description', '--issue', '--repo', 'o/r',
    '--session-id', TEST_SESSION_ID,
  ]);
  assert.equal(r.help, false);
  assert.match(r.errors.map(e => e.message).join('\n'), /--description/);
});

test('config.json に定義されていてもバイナリが PATH になければエラー終了する', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-bin-'));
  const preload = path.join(tmp, 'preload-agent-exec.js');
  try {
    fs.mkdirSync(path.join(tmp, '.gh-maestro'), { recursive: true });
    // agent-defaults.json にある claude を上書きして存在しないバイナリを指定
    fs.writeFileSync(
      path.join(tmp, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: {
          claude: { command: 'nonexistent-cmd-xyz', label: 'Fake CLI', promptDelivery: 'system-prompt-file' },
        },
      }),
    );

    // checkAgentExists のログインシェル境界は別テストで実プロセスを検証するため、
    // ここでは「spawn-worker が設定したコマンドを存在確認へ渡す」経路だけを保ち、
    // 高価な pwsh 起動は引数を検証する注入モックに置き換える。
    fs.writeFileSync(
      preload,
      `
      const agentExec = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'agent-exec.js'))});
      let calls = 0;
      agentExec._setSpawnSync((command, args) => {
        calls++;
        if (process.platform === 'win32') {
          if (command !== 'pwsh' || !Array.isArray(args) || args[0] !== '-NoLogo') {
            throw new Error('unexpected checkAgentExists argv');
          }
          if (calls === 1 && (args[1] !== '-NoProfile' || args[2] !== '-Command'
            || !String(args[3]).includes("Get-Command 'nonexistent-cmd-xyz'"))) {
            throw new Error('unexpected pwsh no-profile argv');
          }
          if (calls === 2 && (args[1] !== '-EncodedCommand' || !args[2])) {
            throw new Error('unexpected pwsh profile argv');
          }
        } else if (command !== 'bash' || args[0] !== '-lc'
          || !String(args[1]).includes("command -v 'nonexistent-cmd-xyz'")) {
          throw new Error('unexpected shell check argv');
        }
        return { status: 1 };
      });
      `,
      'utf8',
    );

    const r = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, '-r', preload, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--agent', 'claude',
      '--workspace', TEST_WORKSPACE,
      '--session-id', TEST_SESSION_ID,
    ], { encoding: 'utf8', env: { ...process.env, HOME: tmp, USERPROFILE: tmp } });

    assert.notEqual(r.status, 0, 'exit code should be non-zero');
    assert.match(r.stderr, /見つかりません/, 'error should be about missing agent command');
    assert.match(r.stderr, /nonexistent-cmd-xyz/, 'error should name the missing command');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── フェイルクローズ: send-text-after-launch は headless では使えない ──────────
// 画面への入力注入を前提とする方式のため、headless実行では本文を渡せない。
// 黙ってプロンプト無しで起動するとワーカーが指示を受け取れないまま走り出す。
// 将来 promptDelivery: send-text-after-launch のエージェントが追加されたとき、
// このガードが無言で壊れていないことを保証する。

test('send-text-after-launch のエージェントは起動を拒否する（フェイルクローズ）', () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-stal-'));
  try {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), JSON.stringify({
      agents: {
        'legacy-sendtext': {
          id: 'legacy-sendtext',
          command: process.execPath,
          extraArgs: [],
          promptDelivery: 'send-text-after-launch',
          asynchronousNotification: false,
          sessionResume: true,
          resumeCommand: ['--continue'],
        },
      },
    }, null, 2), 'utf8');

    const r = run(
      ['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'sendtext',
        '--repo', 'o/r', '--agent', 'legacy-sendtext'],
      { HOME: home, USERPROFILE: home },
    );

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /send-text-after-launch/);
    assert.match(r.stderr, /headless/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('send-text-after-launch の拒否は worktree を作る前に起きる（副作用を残さない）', () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-stal2-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-stalws-'));
  try {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), JSON.stringify({
      agents: {
        'legacy-sendtext': {
          id: 'legacy-sendtext',
          command: process.execPath,
          extraArgs: [],
          promptDelivery: 'send-text-after-launch',
          asynchronousNotification: false,
          sessionResume: true,
          resumeCommand: ['--continue'],
        },
      },
    }, null, 2), 'utf8');

    const r = run(
      ['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'sendtext',
        '--repo', 'o/r', '--workspace', ws, '--agent', 'legacy-sendtext'],
      { HOME: home, USERPROFILE: home },
    );

    assert.notEqual(r.status, 0);
    assert.equal(
      fs.existsSync(path.join(ws, '.gh-maestro', 'worktrees', 'issue-1-coder-sendtext')), false,
      'ガードは worktree 作成より前に落ちること',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── establishOrchestratorBaseline（Issue #207: ワーカー生成時のベースライン既読化） ──
// ワーカー起動前に、対象 Issue の既存コメントIDを orchestrator の既読集合へ追加する。
// 実プロセス spawn はせず、gh-comments の取得と markRead を注入して検証する
//

test('establishOrchestratorBaseline: 既存コメントIDが orchestrator 既読集合に記録され、取得最適化カーソルも設定される', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline-'));
  try {
    const init = readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });
    assert.equal(init.ok, true);

    const listCommentsFn = () => ({
      status: 0,
      stdout: JSON.stringify([
        [{ id: 1, created_at: '2026-07-07T10:00:00Z' }, { id: 2, created_at: '2026-07-07T11:00:00Z' }],
        [{ id: 3, created_at: '2026-07-07T12:00:00Z' }],
      ]),
    });
    const result = establishOrchestratorBaseline(ws, { repo: 'o/r', issue: '207', listCommentsFn });

    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    const st = readStateLib.readState(ws, 'orchestrator');
    assert.deepEqual(st.state.readByIssue['207'], [1, 2, 3], '全ページ分のIDが既読集合に入る');
    assert.equal(st.state.sinceByIssue['207'], '2026-07-07T12:00:00Z', '直近 created_at が取得最適化カーソルになる');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('establishOrchestratorBaseline: 冪等（再実行しても重複しない）', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline2-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });
    const listCommentsFn = () => ({ status: 0, stdout: JSON.stringify([{ id: 1 }]) });

    const r1 = establishOrchestratorBaseline(ws, { repo: 'o/r', issue: '207', listCommentsFn });
    const r2 = establishOrchestratorBaseline(ws, { repo: 'o/r', issue: '207', listCommentsFn });

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const st = readStateLib.readState(ws, 'orchestrator');
    assert.deepEqual(st.state.readByIssue['207'], [1], '再実行でも重複しない（集合和）');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('establishOrchestratorBaseline: orchestrator state 未初期化なら失敗し取得も呼ばない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline3-'));
  try {
    let listCalled = false;
    const listCommentsFn = () => { listCalled = true; return { status: 0, stdout: '[]' }; };

    const result = establishOrchestratorBaseline(ws, { repo: 'o/r', issue: '207', listCommentsFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /reset-session\.js/);
    assert.equal(listCalled, false, '未初期化ではコメント取得を呼ばない');
    assert.equal(fs.existsSync(readStateLib.statePath(ws, 'orchestrator')), false, '空状態を暗黙作成しない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('establishOrchestratorBaseline: v1（旧形式）state でも失敗する（移行が必要）', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline4-'));
  try {
    const sp = readStateLib.statePath(ws, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: { 10: 'x' }, seenIds: [] }), 'utf8');

    const result = establishOrchestratorBaseline(ws, { repo: 'o/r', issue: '207', listCommentsFn: () => ({ status: 0, stdout: '[]' }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /legacy/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('establishOrchestratorBaseline: コメント一覧の取得失敗時は失敗し状態を変更しない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline5-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { byIssue: { 207: [99] }, sessionId: 'valid-test-session' });

    const result = establishOrchestratorBaseline(ws, {
      repo: 'o/r', issue: '207',
      listCommentsFn: () => ({ status: 1, stderr: 'gh: rate limit' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /に失敗しました/);

    const st = readStateLib.readState(ws, 'orchestrator');
    assert.deepEqual(st.state.readByIssue['207'], [99], '失敗時は既読集合を変更しない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('establishOrchestratorBaseline: 応答が配列でない場合に失敗する', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline6-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });
    const result = establishOrchestratorBaseline(ws, {
      repo: 'o/r', issue: '207',
      listCommentsFn: () => ({ status: 0, stdout: JSON.stringify({ not: 'array' }) }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /配列ではありません/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('establishOrchestratorBaseline: markRead が失敗すれば失敗として報告される', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline7-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });
    const result = establishOrchestratorBaseline(ws, {
      repo: 'o/r', issue: '207',
      listCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ id: 1 }]) }),
      markReadFn: () => ({ ok: false, error: 'injected failure' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /injected failure/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── 非対話化トークン検証（Issue #163） ─────────────────────────────────────────
// config.json の extraArgs 上書きで非対話化トークン（--print / run / exec 等）が欠落すると、
// headless 起動が対話モードでハングする。起動をフェイルクローズで拒否する。

test('非対話化トークンを欠落させたエージェントは起動を拒否する（フェイルクローズ, Issue #163）', () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-tokenchk-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-tokenchkws-'));
  try {
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), JSON.stringify({
      agents: {
        claude: {
          id: 'claude',
          command: process.execPath,
          extraArgs: ['--dangerously-skip-permissions'], // --print を欠落
          promptDelivery: 'system-prompt-file',
          nonInteractiveTokens: ['--print'],
        },
      },
    }, null, 2), 'utf8');

    const r = run(
      ['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'tokenchk',
        '--repo', 'o/r', '--workspace', ws, '--agent', 'claude'],
      { HOME: home, USERPROFILE: home },
    );

    assert.notEqual(r.status, 0, `非ゼロ終了であること: ${r.stderr}`);
    assert.match(r.stderr, /非対話化トークン/);
    assert.match(r.stderr, /--print/);
    assert.match(r.stderr, /config\.json/);
    // ガードは worktree 作成より前に落ちる（副作用を残さない）
    assert.equal(
      fs.existsSync(path.join(ws, '.gh-maestro', 'worktrees', 'issue-1-coder-tokenchk')), false,
      'ガードは worktree 作成より前に落ちること',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
// 注: 正のケース（トークン保持ならガードを通る）は tests/resolve-config.test.js の
// validateNonInteractiveTokens 単体テスト + 実機の `node scripts/config.js status`
// （正常時は警告なし）で担保する。ここで subprocess で検証すると checkAgentExists が
// ログインシェル（pwsh）を起動するため、テスト内実プロセス spawn 禁止ルールに反する。

// ── linkNodeModules のフェイルクローズ（Issue #425） ─────────────────────────
// worktree への node_modules junction 作成に失敗（missing が空でない）した場合、
// 動かない環境でワーカーを起動せず、worktree をロールバックして非ゼロ終了する。

test('junction 作成失敗時 (missing 非空) はワーカーを起動せず、worktree をロールバックして非ゼロ終了する (Issue #425)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-fail-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-fail-home-'));
  const preload = path.join(home, 'preload-link-fail.js');
  try {
    // 1. 共有fixtureをコピー & orchestrator msg-state 初期化
    copyGitTemplate(ws);
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });

    // 2. ~/.gh-maestro/config.json にテスト用エージェント定義
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: {
          'test-agent': {
            id: 'test-agent',
            command: process.execPath,
            extraArgs: [],
            promptDelivery: 'positional',
          },
        },
      }),
      'utf8',
    );

    // 3. linkNodeModules が missing を返すように preload でモック + 外部通信ヘルパーもモック
    fs.writeFileSync(
      preload,
      `
      const path = require('path');
      const workerLease = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'worker-lease.js'))});
      workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
      const closedGuard = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'closed-pr-guard.js'))});
      closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });
      const ghComments = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'gh-comments.js'))});
      ghComments.listComments = () => ({ status: 0, stdout: '[]' });
      const mod = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'link-node-modules.js'))});
      mod.linkNodeModules = (worktreeDir, workspace) => {
        const fakeMissing = path.join(worktreeDir, 'node_modules') + ' (error: EPERM: operation not permitted)';
        return {
          linked: [],
          skipped: [],
          missing: [fakeMissing],
        };
      };
      `,
      'utf8',
    );

    const workerName = 'issue-425-coder-failjunction';
    const worktreeDir = path.join(ws, '.gh-maestro', 'worktrees', workerName);
    const workersPath = path.join(ws, '.gh-maestro', 'workers.json');

    const r = spawnSync(
      process.execPath,
      ['-r', FAST_CLI_PRELOAD, '-r', preload, SCRIPT,
        '--skill', 'gh-maestro-coder',
        '--issue', '425',
        '--description', 'failjunction',
        '--repo', 'o/r',
        '--workspace', ws,
        '--agent', 'test-agent',
        '--session-id', 'valid-test-session',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );

    // 終了コードが非ゼロであること
    assert.notEqual(r.status, 0, `非ゼロ終了であること: ${r.stderr}`);
    // missing に含まれる各パスが stderr に出力されること
    assert.match(r.stderr, /spawn-worker: junction作成失敗/);
    assert.match(r.stderr, /node_modules/);
    assert.match(r.stderr, /EPERM/);
    // worktree ディレクトリが残らないこと（ロールバック完了）
    assert.equal(fs.existsSync(worktreeDir), false, 'worktreeディレクトリがロールバックで削除されていること');
    // workers.json にエントリが登録されないこと
    if (fs.existsSync(workersPath)) {
      const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
      assert.equal(workers[workerName], undefined, 'workers.json にワーカーが登録されていないこと');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('linkNodeModules の予期しない例外発生時もワーカーを起動せず、worktree をロールバックして非ゼロ終了する (Issue #425)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-throw-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-throw-home-'));
  const preload = path.join(home, 'preload-link-throw.js');
  try {
    copyGitTemplate(ws);
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });

    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: {
          'test-agent': {
            id: 'test-agent',
            command: process.execPath,
            extraArgs: [],
            promptDelivery: 'positional',
          },
        },
      }),
      'utf8',
    );

    fs.writeFileSync(
      preload,
      `
      const workerLease = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'worker-lease.js'))});
      workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
      const closedGuard = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'closed-pr-guard.js'))});
      closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });
      const ghComments = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'gh-comments.js'))});
      ghComments.listComments = () => ({ status: 0, stdout: '[]' });
      const mod = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'link-node-modules.js'))});
      mod.linkNodeModules = () => {
        throw new Error('simulated unexpected filesystem crash');
      };
      `,
      'utf8',
    );

    const workerName = 'issue-425-coder-throwjunction';
    const worktreeDir = path.join(ws, '.gh-maestro', 'worktrees', workerName);
    const workersPath = path.join(ws, '.gh-maestro', 'workers.json');

    const r = spawnSync(
      process.execPath,
      ['-r', FAST_CLI_PRELOAD, '-r', preload, SCRIPT,
        '--skill', 'gh-maestro-coder',
        '--issue', '425',
        '--description', 'throwjunction',
        '--repo', 'o/r',
        '--workspace', ws,
        '--agent', 'test-agent',
        '--session-id', 'valid-test-session',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );

    assert.notEqual(r.status, 0, `非ゼロ終了であること: ${r.stderr}`);
    assert.match(r.stderr, /spawn-worker: junction作成処理で予期しない例外が発生しました/);
    assert.match(r.stderr, /simulated unexpected filesystem crash/);
    assert.equal(fs.existsSync(worktreeDir), false, 'worktreeディレクトリがロールバックで削除されていること');
    if (fs.existsSync(workersPath)) {
      const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
      assert.equal(workers[workerName], undefined, 'workers.json にワーカーが登録されていないこと');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('junction 作成で missing が空かつ skipped が非空の場合、ワーカーを正常起動しワーカー名を出力して終了コード0になる (Issue #425 / 受入条件6・8)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-skip-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-skip-home-'));
  const preload = path.join(home, 'preload-link-skip.js');
  try {
    copyGitTemplate(ws);
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });

    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: {
          'test-agent': {
            id: 'test-agent',
            command: process.execPath,
            extraArgs: [],
            promptDelivery: 'positional',
          },
        },
      }),
      'utf8',
    );

    // missing が空で skipped のみ
    fs.writeFileSync(
      preload,
      `
      const path = require('path');
      const workerLease = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'worker-lease.js'))});
      workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
      const closedGuard = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'closed-pr-guard.js'))});
      closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });
      const ghComments = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'gh-comments.js'))});
      ghComments.listComments = () => ({ status: 0, stdout: '[]' });
      const headless = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'headless-launch.js'))});
      headless._setSpawn(() => ({
        pid: 99991,
        unref: () => {},
        on: () => {},
      }));
      headless._setGetProcessStartTime(() => new Date().toISOString());
      const supervisor = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'ensure-worker-supervisor.js'))});
      supervisor._setSpawn(() => ({
        pid: 99992,
        unref: () => {},
        on: () => {},
      }));
      const mod = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'link-node-modules.js'))});
      mod.linkNodeModules = (worktreeDir, workspace) => {
        return {
          linked: [],
          skipped: [path.join(worktreeDir, 'node_modules')],
          missing: [],
        };
      };
      `,
      'utf8',
    );

    const workerName = 'issue-425-coder-skipjunction';
    const worktreeDir = path.join(ws, '.gh-maestro', 'worktrees', workerName);
    const workersPath = path.join(ws, '.gh-maestro', 'workers.json');

    const r = spawnSync(
      process.execPath,
      ['-r', FAST_CLI_PRELOAD, '-r', preload, SCRIPT,
        '--skill', 'gh-maestro-coder',
        '--issue', '425',
        '--description', 'skipjunction',
        '--repo', 'o/r',
        '--workspace', ws,
        '--agent', 'test-agent',
        '--session-id', 'valid-test-session',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );

    assert.equal(r.status, 0, `終了コード0であること: ${r.stderr}`);
    const stdoutLines = r.stdout.trim().split(/\r?\n/);
    assert.equal(stdoutLines[stdoutLines.length - 1], workerName, '標準出力にワーカー名が出力されること');
    assert.equal(fs.existsSync(worktreeDir), true, 'worktreeディレクトリが存在すること');
    assert.equal(fs.existsSync(workersPath), true, 'workers.jsonが存在すること');
    const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
    assert.equal(workers[workerName].pid, 99991, 'workers.jsonにワーカーが登録されていること');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('junction 作成で linked / skipped / missing がいずれも空の場合、ワーカーを正常起動しワーカー名を出力して終了コード0になる (Issue #425 / 受入条件7・8)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-empty-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-empty-home-'));
  const preload = path.join(home, 'preload-link-empty.js');
  const workerName = 'issue-425-coder-emptyjunction';
  const worktreeDir = path.join(ws, '.gh-maestro', 'worktrees', workerName);
  const workersPath = path.join(ws, '.gh-maestro', 'workers.json');
  try {
    copyGitTemplate(ws);
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-test-session' });

    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'config.json'),
      JSON.stringify({
        agents: {
          'test-agent': {
            id: 'test-agent',
            command: process.execPath,
            extraArgs: [],
            promptDelivery: 'positional',
          },
        },
      }),
      'utf8',
    );

    // 全て空
    fs.writeFileSync(
      preload,
      `
      const path = require('path');
      const workerLease = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'worker-lease.js'))});
      workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
      const closedGuard = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'closed-pr-guard.js'))});
      closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });
      const ghComments = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'gh-comments.js'))});
      ghComments.listComments = () => ({ status: 0, stdout: '[]' });
      const headless = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'headless-launch.js'))});
      headless._setSpawn(() => ({
        pid: 99993,
        unref: () => {},
        on: () => {},
      }));
      headless._setGetProcessStartTime(() => new Date().toISOString());
      const supervisor = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'ensure-worker-supervisor.js'))});
      supervisor._setSpawn(() => ({
        pid: 99994,
        unref: () => {},
        on: () => {},
      }));
      const mod = require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'shared', 'link-node-modules.js'))});
      mod.linkNodeModules = () => {
        return {
          linked: [],
          skipped: [],
          missing: [],
        };
      };
      `,
      'utf8',
    );

    const r = spawnSync(
      process.execPath,
      ['-r', FAST_CLI_PRELOAD, '-r', preload, SCRIPT,
        '--skill', 'gh-maestro-coder',
        '--issue', '425',
        '--description', 'emptyjunction',
        '--repo', 'o/r',
        '--workspace', ws,
        '--agent', 'test-agent',
        '--session-id', 'valid-test-session',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );

    assert.equal(r.status, 0, `終了コード0であること: ${r.stderr}`);
    const stdoutLines = r.stdout.trim().split(/\r?\n/);
    assert.equal(stdoutLines[stdoutLines.length - 1], workerName, '標準出力にワーカー名が出力されること');
    assert.equal(fs.existsSync(worktreeDir), true, 'worktreeディレクトリが存在すること');
    assert.equal(fs.existsSync(workersPath), true, 'workers.jsonが存在すること');
    const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
    assert.equal(workers[workerName].pid, 99993, 'workers.jsonにワーカーが登録されていること');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ── セッション同一性検証（Issue #444） ─────────────────────────────────────────
// スキル未ロードのセッションからの直接実行や古いセッションIDの使い回しを防ぐため、
// 副作用の前に msg-state/orchestrator.json の sessionId と厳密照合する。

test('Issue #444 受入条件1・2: --session-id がない場合は副作用前に非ゼロ終了し、/gh-maestro への誘導を出力する', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-guard-noid-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'valid-uuid' });
    const r = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '444',
      '--description', 'test-guard',
      '--repo', 'o/r',
      '--workspace', ws,
    ], { encoding: 'utf8' });

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--session-id が必要です/);
    assert.match(r.stderr, /\/gh-maestro を実行して/);
    assert.equal(fs.existsSync(path.join(ws, '.gh-maestro', 'worktrees')), false, 'worktreeディレクトリを作らない');
    assert.equal(fs.existsSync(path.join(ws, '.gh-maestro', 'workers.json')), false, 'workers.jsonを作らない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('Issue #444 受入条件1・2: 不一致の --session-id の場合は副作用前に非ゼロ終了し、/gh-maestro への誘導を出力する', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-guard-mismatch-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'actual-uuid-1111' });
    const r = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '444',
      '--description', 'test-guard',
      '--repo', 'o/r',
      '--workspace', ws,
      '--session-id', 'wrong-uuid-2222',
    ], { encoding: 'utf8' });

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /セッションIDが無効または一致しません/);
    assert.match(r.stderr, /\/gh-maestro を実行して/);
    assert.equal(fs.existsSync(path.join(ws, '.gh-maestro', 'worktrees')), false, 'worktreeディレクトリを作らない');
    assert.equal(fs.existsSync(path.join(ws, '.gh-maestro', 'workers.json')), false, 'workers.jsonを作らない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('Issue #444 受入条件1・2: orchestrator.json の sessionId が空の場合は拒否する', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-guard-empty-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: '' });
    const r = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '444',
      '--description', 'test-guard',
      '--repo', 'o/r',
      '--workspace', ws,
      '--session-id', 'some-uuid',
    ], { encoding: 'utf8' });

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /セッションIDが無効または一致しません/);
    assert.match(r.stderr, /\/gh-maestro を実行して/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('Issue #444 受入条件4: 環境変数の偽装（例: GH_MAESTRO_WORKER）でもガードを迂回できない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-guard-forge-'));
  try {
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: 'real-session-uuid' });
    const r = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '444',
      '--description', 'test-guard',
      '--repo', 'o/r',
      '--workspace', ws,
      '--session-id', 'forged-session-uuid',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_MAESTRO_WORKER: 'orchestrator',
        GH_MAESTRO_SESSION: 'real-session-uuid',
      },
    });

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /セッションIDが無効または一致しません/);
    assert.equal(fs.existsSync(path.join(ws, '.gh-maestro', 'worktrees')), false, 'worktreeディレクトリを作らない');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('Issue #444 受入条件5: 古いセッションIDは新しいセッションで再利用できない（決定論的失効）', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-guard-expiry-'));
  try {
    const oldSessionId = 'old-session-uuid-1';
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: oldSessionId });

    // 新セッションへの更新（reset-session相当）
    const newSessionId = 'new-session-uuid-2';
    readStateLib.initializeState(ws, 'orchestrator', { sessionId: newSessionId });

    // 古い sessionId での実行は拒否される
    const rOld = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '444',
      '--description', 'test-guard',
      '--repo', 'o/r',
      '--workspace', ws,
      '--session-id', oldSessionId,
    ], { encoding: 'utf8' });

    assert.notEqual(rOld.status, 0);
    assert.match(rOld.stderr, /セッションIDが無効または一致しません/);

    // 新しい sessionId はセッション同一性検証を通過する（後段のエージェント解決エラーで止まる）
    const rNew = spawnSync(process.execPath, ['-r', FAST_CLI_PRELOAD, SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '444',
      '--description', 'test-guard',
      '--repo', 'o/r',
      '--workspace', ws,
      '--agent', 'nonexistent-agent',
      '--session-id', newSessionId,
    ], { encoding: 'utf8' });

    assert.notEqual(rNew.status, 0);
    assert.doesNotMatch(rNew.stderr, /セッションIDが無効または一致しません/);
    assert.match(rNew.stderr, /nonexistent-agent/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
