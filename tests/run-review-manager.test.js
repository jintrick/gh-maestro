'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// run-review-manager.js の CLI 実行部は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない
// （.claude/rules/test-process-spawn-safety.md 準拠）。
//
// レビュー観点の選択（旧 heavy/directed モード、MODE=/ASPECTS=/--brief-file、
// review-manager-<PR>.meta.json）は廃止した。ファイルパターンでの機械的な観点自動判定が
// 一部の観点だけに絞り込んでしまい他の観点のレビューが丸ごと欠落する実障害があったため、
// 観点を絞り込むかどうかの判断はオーケストレーター側からは完全に排除し、Review Manager
// 自身がPR diffを見た上で判断する方式に一本化した（skills/gh-maestro-reviewer/SKILL.md参照）。
const {
  buildPrompt,
  buildReviewManagerAgentArgs, runAgentHeadless,
} = require('../scripts/run-review-manager');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'run-review-manager.js');

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-run-rm-' + Date.now());

before(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── buildPrompt ──────────────────────────────────────────────────────────

test('buildPrompt instructs the 3-aspect parallel review', () => {
  const prompt = buildPrompt({
    pr: '5', repo: 'o/r', workspace: 'C:\\ws', outputFile: 'C:\\ws\\out.json',
  });
  assert.match(prompt, /PR=5/);
  assert.match(prompt, /REPO=o\/r/);
  assert.match(prompt, /3観点のReviewerを独立に並列spawnする/);
});

test('buildPrompt normalizes backslash paths to forward slashes', () => {
  const prompt = buildPrompt({
    pr: '5', repo: 'o/r', workspace: 'C:\\ws', outputFile: 'C:\\ws\\out.json',
  });
  assert.match(prompt, /WORKSPACE=C:\/ws/);
  assert.match(prompt, /OUTPUT=C:\/ws\/out\.json/);
});

// ── CLI引数パース（scripts/shared/workspace.js の parseFlags に委譲） ─────────

test('サブプロセス経由: --help は終了コード0でUsageを表示する', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /run-review-manager\.js/);
});

test('サブプロセス経由: 位置引数が不足しているとUsageエラーになる', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '5', 'o/r'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

// ── runAgentHeadless ─────────────────────────────────────────────────────
// Codex実行そのものはネットワーク/実エージェント依存のため統合テスト対象外。
// ここではspawnしても即終了する軽量コマンドだけを使う
// （.claude/rules/test-process-spawn-safety.md 準拠: detachしない同期spawnのみ）。
//
// 可視ペイン実行（runAgentVisible / buildVisiblePaneArgs）はIssue #151で廃止した。
// RMの実行記録はfd直接リダイレクトによるログ追記へ一本化されている。

test('runAgentHeadless: 軽量コマンドの終了コードをそのまま返す', () => {
  const logFile = path.join(tmpBase, 'rm-exit.log');
  const result = runAgentHeadless([process.execPath, '-e', 'process.exit(0)'], tmpBase, logFile);
  assert.equal(result.status, 0);
});

test('runAgentHeadless: 非ゼロ終了コードもそのまま返す', () => {
  const logFile = path.join(tmpBase, 'rm-exit-nonzero.log');
  const result = runAgentHeadless([process.execPath, '-e', 'process.exit(3)'], tmpBase, logFile);
  assert.equal(result.status, 3);
});

test('runAgentHeadless: 標準出力・標準エラーをログファイルへ直接書き出す', () => {
  // 以前は出力をメモリにバッファし完了後にまとめて書いていたため、実行中は何も見えなかった。
  const logFile = path.join(tmpBase, 'rm-capture.log');
  runAgentHeadless(
    [process.execPath, '-e', "console.log('stdoutマーカー'); console.error('stderrマーカー');"],
    tmpBase, logFile,
  );

  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /stdoutマーカー/);
  assert.match(content, /stderrマーカー/, '標準エラーも同じログへ集約される');
  assert.ok(!content.includes('�'), `マルチバイト文字が文字化けしない: ${content}`);
});

test('runAgentHeadless: 既存ログへ追記する（launcherが書いた行を消さない）', () => {
  const logFile = path.join(tmpBase, 'rm-append.log');
  fs.writeFileSync(logFile, '[launcher] review started\n', 'utf8');

  runAgentHeadless([process.execPath, '-e', "console.log('エージェント出力')"], tmpBase, logFile);

  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /\[launcher\] review started/);
  assert.match(content, /エージェント出力/);
});

test('runAgentHeadless: stdin は継承しない（TTY不在での入力待ちハングを防ぐ）', () => {
  // codex exec は起動時に stdin を読む。継承すると入力待ちでハングしうる。
  const logFile = path.join(tmpBase, 'rm-stdin.log');
  const result = runAgentHeadless(
    [process.execPath, '-e', "const fs=require('fs'); let d=''; try { d=fs.readFileSync(0,'utf8'); } catch(e) { d='(読めない)'; } console.log('stdin='+JSON.stringify(d));"],
    tmpBase, logFile,
  );

  assert.equal(result.status, 0, 'stdin待ちでハングせず完了する');
  assert.match(fs.readFileSync(logFile, 'utf8'), /stdin=/);
});
test('buildReviewManagerAgentArgs: AntigravityはRMで--printを使い通常の-iを使わない', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-defaults.json'), 'utf8'));
  const agent = defaults.agents.find(entry => entry.id === 'agy');
  const args = buildReviewManagerAgentArgs(agent, {
    reviewWtDir: 'C:\\review-worktree',
    promptFile: 'C:\\tmp\\review-manager.md',
    skill: 'gh-maestro-reviewer',
  });

  assert.deepEqual(args, [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '30m0s',
    '--print', 'Read C:/tmp/review-manager.md and execute it.',
  ]);
  assert.ok(!args.includes('-i'));
});


test('buildReviewManagerAgentArgs: ReasonixはRMでrunと位置引数プロンプトを使う', () => {
  const args = buildReviewManagerAgentArgs({
    command: 'node',
    execArgs: ['C:\\tools\\reasonix.js', 'run', '--dir', '{workspace}'],
    execPromptDelivery: 'positional',
    promptDelivery: 'send-text-after-launch',
  }, {
    reviewWtDir: 'C:\\review-worktree',
    promptFile: 'C:\\tmp\\review-manager.md',
    skill: 'gh-maestro-reviewer',
  });

  assert.deepEqual(args, [
    'node', 'C:\\tools\\reasonix.js', 'run', '--dir', 'C:\\review-worktree',
    'Read C:/tmp/review-manager.md and execute it.',
  ]);
});
