'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spawn-worker.js');
const { shouldPruneStaleWorker, buildAgentsMdContent } = require(SCRIPT);

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// WEZTERM_PANE がないと即失敗するので、ダミー値をセットして引数バリデーションまで到達させる
const BASE_ENV = { WEZTERM_PANE: '999' };

// ── shouldPruneStaleWorker（stale worker除去判定） ────────────────────────────
// 実障害: 新規ワーカー起動のたびに、たまたま休止中（正常）だったセッション再開系
// ワーカーがworkers.jsonから消え、二度とresumeされなくなっていた。

test('shouldPruneStaleWorker: ペインが生存していれば除去しない', () => {
  const result = shouldPruneStaleWorker(
    { paneId: '5', agentId: 'agy' },
    new Set(['5']),
    () => ({ sessionResume: true, asynchronousNotification: false }),
  );
  assert.equal(result, false);
});

test('shouldPruneStaleWorker: ペイン不在でもセッション再開系エージェントなら除去しない（正常な休止）', () => {
  const result = shouldPruneStaleWorker(
    { paneId: '5', agentId: 'agy' },
    new Set(['9']),
    () => ({ sessionResume: true, asynchronousNotification: false }),
  );
  assert.equal(result, false);
});

test('shouldPruneStaleWorker: ペイン不在でclaude系（asynchronousNotification:true）なら除去する', () => {
  const result = shouldPruneStaleWorker(
    { paneId: '5', agentId: 'claude' },
    new Set(['9']),
    () => ({ sessionResume: true, asynchronousNotification: true }),
  );
  assert.equal(result, true);
});

test('shouldPruneStaleWorker: agentConfigが解決できない場合はfail-safeで除去する', () => {
  const result = shouldPruneStaleWorker(
    { paneId: '5', agentId: 'unknown-agent' },
    new Set(['9']),
    () => null,
  );
  assert.equal(result, true);
});

test('shouldPruneStaleWorker: resolveAgentが例外を投げてもfail-safeで除去する', () => {
  const result = shouldPruneStaleWorker(
    { paneId: '5', agentId: 'broken' },
    new Set(['9']),
    () => { throw new Error('boom'); },
  );
  assert.equal(result, true);
});

test('shouldPruneStaleWorker: agentIdが無ければfail-safeで除去する', () => {
  const result = shouldPruneStaleWorker(
    { paneId: '5', agentId: null },
    new Set(['9']),
    () => { throw new Error('should not be called'); },
  );
  assert.equal(result, true);
});

test('--skill がないとエラー終了する', () => {
  const r = run(['--issue', '1', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--skill/);
});

test('--description がないとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '1', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--description/);
});

test('--issue がないとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--issue/);
});

test('--issue が非数値だとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', 'abc', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /正の整数/);
});

test('--issue が 0 だとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '0', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /正の整数/);
});

test('--issue が負数だとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '-1', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /正の整数/);
});

test('--repo がないとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'test'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--repo/);
});

test('gh-maestro-base で --prompt-file がないとエラー終了する', () => {
  const r = run([
    '--skill', 'gh-maestro-base',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prompt-file/);
});

// ── buildAgentsMdContent（skillsViaMdエージェント向けAGENTS.md本文組み立て） ──────────
// 実障害: reasonix（skillsViaMd）向けAGENTS.mdは、SKILL.md本文とセッション変数だけを
// 結合しており、--prompt-file/--short-prompt で渡した「今回の指示」が含まれず、
// reasonixに対してだけプロンプト内容が消えていた。

test('buildAgentsMdContent: promptを指定すると「今回の指示」セクションに含まれる', () => {
  const md = buildAgentsMdContent({
    skillContent: 'スキル本文\n',
    prompt: 'このIssueのバグを調査してください',
    contextLines: ['ISSUE=42'],
  });
  assert.match(md, /## 今回の指示/);
  assert.match(md, /このIssueのバグを調査してください/);
  assert.match(md, /## セッション変数/);
  assert.match(md, /ISSUE=42/);
});

test('buildAgentsMdContent: promptが無ければ「今回の指示」セクション自体が現れない', () => {
  const md = buildAgentsMdContent({
    skillContent: 'スキル本文\n',
    prompt: null,
    contextLines: ['ISSUE=42'],
  });
  assert.doesNotMatch(md, /## 今回の指示/);
  assert.match(md, /## セッション変数/);
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

test('廃止した --prompt は未知の引数として拒否する', () => {
  const r = run([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--prompt', 'legacy prompt',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);

  assert.match(r.stderr, /未知の引数/);
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
  assert.match(r.stderr, /未知の引数/);
  assert.match(r.stderr, /--typo-flag/);
});

test('WEZTERM_PANE が未設定だとエラー終了する', () => {
  const envWithoutPane = { ...process.env };
  delete envWithoutPane.WEZTERM_PANE;
  const r = spawnSync(process.execPath, [SCRIPT,
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
  ], { encoding: 'utf8', env: envWithoutPane });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WEZTERM_PANE/);
});

// ── link-node-modules の解決 ──────────────────────────────────────────────────

test('link-node-modules がリポジトリ内パスから解決できる', () => {
  const nm = path.join(__dirname, '..', 'scripts', 'link-node-modules');
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
    const srcNm = path.join(__dirname, '..', 'scripts', 'link-node-modules.js');
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

test('新規ワーカー登録エントリは paneId/agentId/issue を含む', () => {
  const { normalizeWorkerEntry } = require('../scripts/worker-entry');
  const entry = normalizeWorkerEntry({ paneId: '123', agentId: 'claude', issue: 51 });
  assert.equal(entry.paneId, '123');
  assert.equal(entry.agentId, 'claude');
  assert.equal(entry.issue, 51);
  assert.equal(typeof entry.issue, 'number');
});

test('新規ワーカー登録エントリは issue を数値に変換する（文字列で渡されても Number() される）', () => {
  const { normalizeWorkerEntry } = require('../scripts/worker-entry');
  const entry = normalizeWorkerEntry({ paneId: '456', agentId: 'agy', issue: '99' });
  assert.equal(entry.issue, 99);
  assert.equal(typeof entry.issue, 'number');
});

test('新規ワーカー登録エントリは notifierPid を持たない（null）ため remove-worker等がレガシーnotifierをkillしようとしない', () => {
  const { normalizeWorkerEntry } = require('../scripts/worker-entry');
  const entry = normalizeWorkerEntry({ paneId: '1', agentId: 'claude', issue: 7 });
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
      env: { ...process.env, WEZTERM_PANE: '999', HOME: tmp },
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
      env: { ...process.env, WEZTERM_PANE: '999', HOME: tmp },
    });

    assert.notEqual(r.status, 0, 'exit code should be non-zero');
    assert.match(r.stderr, /見つかりません/, 'error should be about missing agent command');
    assert.match(r.stderr, /nonexistent-cmd-xyz/, 'error should name the missing command');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
