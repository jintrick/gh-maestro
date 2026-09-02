'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spawn-worker.js');
const {
  shouldPruneStaleWorker,
  establishOrchestratorBaseline,
  parseWorkerArgs,
  ensureStatusPaneForWorkspace,
  _setEnsureStatusPane,
} = require(SCRIPT);
const readStateLib = require('../scripts/shared/read-state');
const fs = require('fs');
const os = require('os');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
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

test('クローズ済みPRのブランチは新規起動せず、副作用も発生させない（実リポジトリ状態）', () => {
  // PR #350 はこのリポジトリで CLOSED のまま残る既知のブランチ。
  // 実際の gh pr list --state all を使い、spawn-worker.js のガード位置そのものを検証する。
  const workerName = 'issue-349-senior-coder-split-review-aspects';
  const workspace = path.resolve(__dirname, '..');
  const worktreeDir = path.join(workspace, '.gh-maestro', 'worktrees', workerName);
  const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
  const workersBefore = fs.existsSync(workersPath) ? fs.readFileSync(workersPath, 'utf8') : null;

  const r = run([
    '--skill', 'gh-maestro-senior-coder', '--short-prompt', 'test',
    '--issue', '349', '--description', 'split-review-aspects', '--repo', 'jintrick/gh-maestro',
    '--workspace', workspace, '--agent', 'agy',
  ], BASE_ENV);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /issue-349-senior-coder-split-review-aspects/);
  assert.match(r.stderr, /クローズ済みPR #350/);
  assert.equal(fs.existsSync(worktreeDir), false, '遮断時はworktreeを作成しない');
  const workersAfter = fs.existsSync(workersPath) ? fs.readFileSync(workersPath, 'utf8') : null;
  assert.equal(workersAfter, workersBefore, '遮断時はリース・workers.jsonを書き換えない');
});

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
  const r = run(['-h'], BASE_ENV);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node spawn-worker\.js/);
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
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-promptfile-'));
  const promptFile = path.join(tmp, 'prompt.md');
  fs.writeFileSync(promptFile, 'こんにちは');
  try {
    const r = run([
      '--skill', 'gh-maestro-base',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--short-prompt', 'inline prompt',
      '--prompt-file', promptFile,
    ], BASE_ENV);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--short-prompt と --prompt-file は同時に指定できません/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
    const r = run([
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--short-prompt', prompt,
    ], BASE_ENV);
    assert.notEqual(r.status, 0, prompt);
    assert.match(r.stderr, /--short-prompt は1行/);
    assert.match(r.stderr, /--prompt-file/);
  }
});

test('廃止した --prompt は未知のフラグとして拒否する', () => {
  const r = run([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--prompt', 'legacy prompt',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);

  assert.match(r.stderr, /未知のフラグ/);
  assert.match(r.stderr, /--prompt/);
});
// ── 未知フラグの拒否 ──────────────────────────────────────────────────────────

test('未知のフラグを指定するとエラー終了する（黙って無視しない）', () => {
  const r = run([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--typo-flag', 'value',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知のフラグ/);
  assert.match(r.stderr, /--typo-flag/);
});

test('WEZTERM_PANE が未設定でも WEZTERM 由来の理由では失敗しない（headless化で不要になった）', () => {
  const envWithoutPane = { ...process.env };
  delete envWithoutPane.WEZTERM_PANE;
  // 副作用（worktree作成・エージェント起動）の手前で止めるため、実在しない --agent を渡す
  const r = spawnSync(process.execPath, [SCRIPT, '--skill', 'gh-maestro-coder', '--issue', '1',
    '--description', 'test', '--repo', 'o/r', '--agent', 'nonexistent-agent-for-test'],
  { encoding: 'utf8', env: envWithoutPane });

  assert.doesNotMatch(r.stderr, /WEZTERM_PANE/);
});

// ── link-node-modules の解決 ──────────────────────────────────────────────────

test('link-node-modules がリポジトリ内パスから解決できる', () => {
  const nm = path.join(__dirname, '..', 'scripts', 'shared', 'link-node-modules');
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
    const srcNm = path.join(__dirname, '..', 'scripts', 'shared', 'link-node-modules.js');
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
  const { normalizeWorkerEntry } = require('../scripts/shared/worker-entry');
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
  const { normalizeWorkerEntry } = require('../scripts/shared/worker-entry');
  const entry = normalizeWorkerEntry({ pid: 456, agentId: 'agy', issue: '99' });
  assert.equal(entry.issue, 99);
  assert.equal(typeof entry.issue, 'number');
});

test('新規ワーカー登録エントリは paneId を持たない（null）ためレガシーkill-pane経路が誤発火しない', () => {
  const { normalizeWorkerEntry } = require('../scripts/shared/worker-entry');
  const entry = normalizeWorkerEntry({ pid: 1, agentId: 'claude', issue: 7 });
  assert.equal(entry.paneId, null);
});

test('新規ワーカー登録エントリは notifierPid を持たない（null）ため remove-worker等がレガシーnotifierをkillしようとしない', () => {
  const { normalizeWorkerEntry } = require('../scripts/shared/worker-entry');
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

    const r = spawnSync(process.execPath, [SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--agent', 'nonexistent',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp },
    });

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
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', '--issue', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--description/);
});

test('config.json に定義されていてもバイナリが PATH になければエラー終了する', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-bin-'));
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

    const r = spawnSync(process.execPath, [SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--agent', 'claude',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp },
    });

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
// （test-process-spawn-safety ルール準拠）。

test('establishOrchestratorBaseline: 既存コメントIDが orchestrator 既読集合に記録され、取得最適化カーソルも設定される', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-baseline-'));
  try {
    const init = readStateLib.initializeState(ws, 'orchestrator', { generation: 'g' });
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
    readStateLib.initializeState(ws, 'orchestrator', { generation: 'g' });
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
    readStateLib.initializeState(ws, 'orchestrator', { byIssue: { 207: [99] }, generation: 'g' });

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
    readStateLib.initializeState(ws, 'orchestrator', { generation: 'g' });
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
    readStateLib.initializeState(ws, 'orchestrator', { generation: 'g' });
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
    // 1. git repo 初期化 & orchestrator msg-state 初期化
    spawnSync('git', ['init'], { cwd: ws, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: ws, stdio: 'pipe' });
    fs.writeFileSync(path.join(ws, 'README.md'), '# test\n');
    spawnSync('git', ['add', '.'], { cwd: ws, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: ws, stdio: 'pipe' });
    readStateLib.initializeState(ws, 'orchestrator', { generation: 'g' });

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
      const closedGuard = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'shared', 'closed-pr-guard.js'))});
      closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });
      const ghComments = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'shared', 'gh-comments.js'))});
      ghComments.listComments = () => ({ status: 0, stdout: '[]' });
      const mod = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'shared', 'link-node-modules.js'))});
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
      ['-r', preload, SCRIPT,
        '--skill', 'gh-maestro-coder',
        '--issue', '425',
        '--description', 'failjunction',
        '--repo', 'o/r',
        '--workspace', ws,
        '--agent', 'test-agent',
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

test('junction 作成で missing が空で skipped のみ、または全て空の場合は junction 理由で失敗しない (Issue #425)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-skip-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-nm-skip-home-'));
  const preload = path.join(home, 'preload-link-skip.js');
  try {
    spawnSync('git', ['init'], { cwd: ws, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: ws, stdio: 'pipe' });
    fs.writeFileSync(path.join(ws, 'README.md'), '# test\n');
    spawnSync('git', ['add', '.'], { cwd: ws, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: ws, stdio: 'pipe' });
    readStateLib.initializeState(ws, 'orchestrator', { generation: 'g' });

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
      const closedGuard = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'shared', 'closed-pr-guard.js'))});
      closedGuard.checkClosedPr = () => ({ ok: true, closed: false, prNumber: null });
      const ghComments = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'shared', 'gh-comments.js'))});
      ghComments.listComments = () => ({ status: 0, stdout: '[]' });
      const mod = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'shared', 'link-node-modules.js'))});
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

    const r = spawnSync(
      process.execPath,
      ['-r', preload, SCRIPT,
        '--skill', 'gh-maestro-coder',
        '--issue', '425',
        '--description', 'skipjunction',
        '--repo', 'o/r',
        '--workspace', ws,
        '--agent', 'test-agent',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );

    // NODE_TEST_CONTEXT により launchAgentHeadless が実起動を拒否するが、junction エラーでは落ちないこと
    assert.doesNotMatch(r.stderr, /junction作成失敗/);
    assert.doesNotMatch(r.stderr, /junction 作成に失敗したため/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});





