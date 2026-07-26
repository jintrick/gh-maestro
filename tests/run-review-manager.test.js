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
  buildReviewManagerAgentArgs, runAgentHeadless, runAgentVisible, buildVisiblePaneArgs,
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

// ── runAgentHeadless / runAgentVisible ──────────────────────────────────
// Codex実行そのものはネットワーク/実エージェント依存のため統合テスト対象外。
// ここではプロセスをspawnしても即終了する軽量コマンド、または
// spawnに到達しないフォールバック分岐だけを確認する
// （.claude/rules/test-process-spawn-safety.md 準拠: detachしない同期spawnのみ）。

test('runAgentHeadless: 軽量コマンドの終了コードをそのまま返す', () => {
  const result = runAgentHeadless([process.execPath, '-e', 'process.exit(0)'], tmpBase);
  assert.equal(result.status, 0);
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
test('runAgentVisible: WEZTERM_PANE未設定ならwezterm等を呼ばずnullを返す（headlessへフォールバック）', () => {
  const originalPane = process.env.WEZTERM_PANE;
  delete process.env.WEZTERM_PANE;
  try {
    const logs = [];
    const result = runAgentVisible(['dummy-cmd'], tmpBase, path.join(tmpBase, 'nonexistent-output.json'), (m) => logs.push(m));
    assert.equal(result, null);
    assert.ok(logs.some(m => m.includes('WEZTERM_PANE')));
  } finally {
    if (originalPane !== undefined) process.env.WEZTERM_PANE = originalPane;
  }
});

// ── buildVisiblePaneArgs ─────────────────────────────────────────────────
// 可視ペインは`exec`によるシェル置換をしないため、エージェント終了後に
// 終了コードをexitMarkerFileへ書き出す後続ステップを挟める（PR #103 Review Manager指摘）。

test('buildVisiblePaneArgs (win32): pwshの $LASTEXITCODE をexitMarkerFileへ書き出すコマンドを構築する', () => {
  const args = buildVisiblePaneArgs(['codex.exe', 'exec', 'hello world'], 'C:\\ws\\out.json.exitcode', 'win32');
  assert.deepEqual(args.slice(0, 3), ['pwsh', '-NoLogo', '-EncodedCommand']);
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(decoded, /& 'codex\.exe' 'exec' 'hello world'/);
  assert.match(decoded, /Set-Content -LiteralPath 'C:\\ws\\out\.json\.exitcode' -Value \$LASTEXITCODE/);
});

test('buildVisiblePaneArgs (win32): 引数中のシングルクォートをエスケープする', () => {
  const args = buildVisiblePaneArgs(["it's"], 'C:\\ws\\o.exitcode', 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(decoded, /'it''s'/);
});

test('buildVisiblePaneArgs (win32): ログ複製のパイプ（Tee-Object）を構築しない', () => {
  // 第4引数（旧captureLogPath）を渡しても無視され、パイプは復活しない（Issue #151）
  const args = buildVisiblePaneArgs(['codex.exe', 'exec'], 'C:\\ws\\out.json.exitcode', 'win32', 'C:\\ws\\review-manager-7.log');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.doesNotMatch(decoded, /Tee-Object/);
  assert.doesNotMatch(decoded, /review-manager-7\.log/);
  assert.ok(!decoded.includes('|'), `パイプ演算子が含まれない: ${decoded}`);
  assert.match(decoded, /Set-Content -LiteralPath 'C:\\ws\\out\.json\.exitcode' -Value \$LASTEXITCODE/);
});

test('buildVisiblePaneArgs (posix): ログ複製のパイプ（tee）を構築しない', () => {
  const args = buildVisiblePaneArgs(['codex', 'exec'], '/tmp/out.json.exitcode', 'linux', '/tmp/review-manager-7.log');
  assert.equal(args[0], 'bash');
  assert.doesNotMatch(args[2], /tee/);
  assert.doesNotMatch(args[2], /PIPESTATUS/);
  assert.match(args[2], /echo \$\? > '\/tmp\/out\.json\.exitcode'/);
});

test('buildVisiblePaneArgs (posix): 終了コードを $? でexitMarkerFileへ書き出す', () => {
  const args = buildVisiblePaneArgs(['codex', 'exec'], '/tmp/out.json.exitcode', 'linux');
  assert.equal(args[0], 'bash');
  assert.equal(args[1], '-lc');
  assert.match(args[2], /echo \$\? > '\/tmp\/out\.json\.exitcode'/);
  assert.deepEqual(args.slice(3), ['codex', 'exec']);
});

// ── runAgentVisible: split-pane自体に失敗した場合はheadlessへフォールバックする ──
// 実際のタイムアウト→kill-pane経路（buildVisiblePaneArgsの出力が実際に使われ、
// エージェント終了後にexitMarkerFileが現れる）はwezterm実機とエージェントの実起動が
// 必要なため統合テスト対象外（.claude/rules/test-process-spawn-safety.md 準拠）。
// ここではPANE指定はあるがwezterm split-paneが失敗する（未インストール/不正なpane-id）
// ケースでnullを返すことだけを確認する。

test('runAgentVisible: wezterm split-paneが失敗するとnullを返す（headlessへフォールバック）', () => {
  const originalPane = process.env.WEZTERM_PANE;
  process.env.WEZTERM_PANE = '999';
  try {
    const logs = [];
    const result = runAgentVisible(['dummy-cmd'], tmpBase, path.join(tmpBase, 'nonexistent-output-2.json'), (m) => logs.push(m));
    assert.equal(result, null);
  } finally {
    if (originalPane !== undefined) process.env.WEZTERM_PANE = originalPane;
    else delete process.env.WEZTERM_PANE;
  }
});
