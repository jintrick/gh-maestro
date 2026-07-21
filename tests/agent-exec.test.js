'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildLoginShellExecArgs, checkAgentExists } = require('../scripts/agent-exec');

/**
 * bash 経由で command -v を実行し、指定コマンドが解決可能か確認する。
 * WSL 導入済み Windows では bash --version は通るが WSL 内に node が無いケースが
 * あるため、単なる bash 存在確認では不十分。実際に command -v で解決できるかまで
 * 確認することで、実行環境の bash/node 有無に結果が左右されないようにする。
 */
function bashCanResolve(command) {
  try {
    const r = spawnSync('bash', ['-lc', `command -v '${command}' 2>/dev/null`], {
      encoding: 'utf8', stdio: 'pipe',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ── buildLoginShellExecArgs ──────────────────────────────────────────────────

test('buildLoginShellExecArgs: win32 は pwsh -EncodedCommand を返す', () => {
  const args = buildLoginShellExecArgs(['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md', 'start'], 'win32');

  assert.equal(args[0], 'pwsh');
  assert.equal(args[1], '-NoLogo');
  assert.equal(args[2], '-EncodedCommand');
  assert.equal(args.length, 4);

  // 第4引数が有効な base64 であることを確認（UTF-16LE でデコード → 元のコマンド文字列）
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith("& 'claude'"));
  assert.ok(decoded.includes('--dangerously-skip-permissions'));
  assert.ok(decoded.includes('/tmp/p.md'));
  assert.ok(decoded.endsWith("'start'"));
});

test('buildLoginShellExecArgs: win32 で引数内の \' をエスケープする', () => {
  const args = buildLoginShellExecArgs(['claude', "hello 'world' test"], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("'hello ''world'' test'"));
});

test('buildLoginShellExecArgs: win32 で空白を含むパスを安全に扱う', () => {
  const args = buildLoginShellExecArgs(['claude', '--append-system-prompt-file', 'C:/path with spaces/prompt.md', 'start'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("'C:/path with spaces/prompt.md'"));
});

test('buildLoginShellExecArgs: win32 で $ を含む引数を変数展開せず維持する', () => {
  const args = buildLoginShellExecArgs(['claude-ds', '--model', '$DEEPSEEK_MODEL', 'C:/path/$VAR/prompt.md'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  // single-quote なので $ はそのままリテラル
  assert.ok(decoded.includes("'$DEEPSEEK_MODEL'"));
  assert.ok(decoded.includes("'C:/path/$VAR/prompt.md'"));
  // シングルクォートの外に $ がないことを確認
  assert.ok(!decoded.includes('"$'), 'double-quoted $ が残っていない');
});

test('buildLoginShellExecArgs: win32 で env をコマンド冒頭に $env: で注入する', () => {
  const args = buildLoginShellExecArgs(['claude-ds-pro', '--print'], 'win32', null,
    { GH_MAESTRO_WORKER: 'issue-247-x', GH_MAESTRO_WORKSPACE: 'C:\\Users\\J\\gijiai' });
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith("$env:GH_MAESTRO_WORKER='issue-247-x'; "));
  // バックスラッシュはシングルクォート内でリテラル保持される
  assert.ok(decoded.includes("$env:GH_MAESTRO_WORKSPACE='C:\\Users\\J\\gijiai'; "));
  // env の後に本来の & 呼び出しが続く
  assert.ok(decoded.includes("& 'claude-ds-pro' '--print'"));
});

test('buildLoginShellExecArgs: win32 で env が空なら従来通りプリフィックス無し', () => {
  const args = buildLoginShellExecArgs(['claude', '--print'], 'win32', null, {});
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith("& 'claude'"));
});

test('buildLoginShellExecArgs: Unix で env を export で注入する', () => {
  const args = buildLoginShellExecArgs(['agy', '--print'], 'linux', null, { GH_MAESTRO_WORKER: 'issue-9-x' });
  assert.equal(args[0], 'bash');
  assert.equal(args[1], '-lc');
  assert.ok(args[2].startsWith("export GH_MAESTRO_WORKER='issue-9-x'; "));
  assert.ok(args[2].includes('exec "$0" "$@"'));
});

test('buildLoginShellExecArgs: Unix は bash -lc exec を返す', () => {
  const args = buildLoginShellExecArgs(['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md'], 'linux');

  assert.equal(args[0], 'bash');
  assert.equal(args[1], '-lc');
  assert.equal(args[2], 'exec "$0" "$@"');
  assert.deepEqual(args.slice(3), ['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md']);
});

test('buildLoginShellExecArgs: Unix で空白を含む引数を argv として維持する', () => {
  const args = buildLoginShellExecArgs(['claude', '--append-system-prompt-file', '/path/with spaces/prompt.md', 'multi\nline'], 'linux');

  assert.equal(args[3], 'claude');
  assert.equal(args[5], '/path/with spaces/prompt.md');
  assert.equal(args[6], 'multi\nline');
});

test('buildLoginShellExecArgs: 終了フックはエージェント終了後に引数と終了コードを渡す', () => {
  const hook = { command: 'node', args: ['/tmp/worker-exit-hook.js', '/tmp/workspace', 'exec-42'] };
  const winArgs = buildLoginShellExecArgs(['codex-pro', 'start'], 'win32', hook);
  const decoded = Buffer.from(winArgs[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("& 'node' '/tmp/worker-exit-hook.js' '/tmp/workspace' 'exec-42' $exitCode"));

  const unixArgs = buildLoginShellExecArgs(['codex-pro', 'start'], 'linux', hook);
  assert.ok(unixArgs[2].includes('shift 3'));
  assert.deepEqual(unixArgs.slice(3, 7), ['node', '/tmp/worker-exit-hook.js', '/tmp/workspace', 'exec-42']);
  assert.deepEqual(unixArgs.slice(7), ['codex-pro', 'start']);
});

test('buildLoginShellExecArgs: Unix の終了フックはエージェントコマンドを実行してから終了コードを渡す', (t) => {
  const bashProbe = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    t.skip('bash の実行環境が利用できない');
    return;
  }

  const args = buildLoginShellExecArgs(
    ['bash', '-lc', 'printf agent-ran; exit 7'],
    'linux',
    { command: 'bash', args: ['-lc', 'printf hook:$1', 'hook-shell'] },
  );
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /agent-ran/);
  assert.match(result.stdout, /hook:7/);
});

// ── captureLogPath（resume応答の代理送信用stdoutキャプチャ） ──────────────────

test('buildLoginShellExecArgs: win32 で captureLogPath 指定時に Tee-Object へのパイプを組み込む', () => {
  const args = buildLoginShellExecArgs(['claude-ds', '--print'], 'win32', null, {}, 'C:\\ws\\.gh-maestro\\out.log');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("& 'claude-ds' '--print' 2>&1 | Tee-Object -FilePath 'C:\\ws\\.gh-maestro\\out.log'"));
  // captureLogPath のみ（onExit無し）でも $LASTEXITCODE を保存して exit する
  assert.ok(decoded.includes('exit $exitCode'));
});

test('buildLoginShellExecArgs: win32 で captureLogPath と onExit を併用するとパイプの後にフックが呼ばれる', () => {
  const hook = { command: 'node', args: ['/ws/worker-exit-hook.js', '/ws', '', '/ws/out.log', '2024-01-01T00:00:00Z'] };
  const args = buildLoginShellExecArgs(['claude-ds', '--print'], 'win32', hook, {}, '/ws/out.log');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  const teeIdx = decoded.indexOf('Tee-Object');
  const hookIdx = decoded.indexOf("& 'node'");
  assert.ok(teeIdx !== -1 && hookIdx !== -1 && teeIdx < hookIdx,
    `Tee-Object should come before the exit hook invocation: ${decoded}`);
});

test('buildLoginShellExecArgs: win32 で captureLogPath 未指定なら Tee-Object関連の文字列が一切出ない', () => {
  const args = buildLoginShellExecArgs(['claude-ds', '--print'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(!decoded.includes('Tee-Object'));
});

test('buildLoginShellExecArgs: win32 で captureLogPath 内のシングルクォートをエスケープする', () => {
  const args = buildLoginShellExecArgs(['claude-ds'], 'win32', null, {}, "C:\\o'brien\\out.log");
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("Tee-Object -FilePath 'C:\\o''brien\\out.log'"));
});

test('buildLoginShellExecArgs: Unix で captureLogPath 指定時に tee を組み込む', () => {
  const args = buildLoginShellExecArgs(['claude-ds', '--print'], 'linux', null, {}, '/ws/out.log');
  assert.ok(args[2].startsWith("exec > >(tee -a '/ws/out.log') 2>&1; exec \"$0\" \"$@\""));
});

test('buildLoginShellExecArgs: Unix で captureLogPath 未指定なら tee が出ない', () => {
  const args = buildLoginShellExecArgs(['claude-ds', '--print'], 'linux');
  assert.ok(!args[2].includes('tee'));
});

test('buildLoginShellExecArgs (実行): win32 でcaptureLogPath指定時、実際にログファイルへ複製され、終了コードも正しく伝わる', (t) => {
  if (process.platform !== 'win32') {
    t.skip('win32専用のテスト');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-capture-test-'));
  const logPath = path.join(dir, 'out.log');
  const hookOutPath = path.join(dir, 'hook-out.txt');
  const hookScriptPath = path.join(dir, 'hook.js');
  // worker-exit-hook.js と同じ実起動形（command: process.execPath + JSファイル）を模す。
  // pwshの-Command + 末尾位置引数の$args束縛は本番コードが依存する経路ではないため、
  // 曖昧さを避けて実際に使われる形（node + jsファイル）で検証する。
  fs.writeFileSync(hookScriptPath, "require('fs').writeFileSync(process.argv[2], 'received exit code: ' + process.argv[process.argv.length - 1]);");
  try {
    // pwshの組み込みコマンドを「エージェント」役として使い、標準出力と非ゼロ終了を再現する
    const agentArgs = ['pwsh', '-NoLogo', '-NoProfile', '-Command', "Write-Host 'agent-output-marker'; exit 5"];
    const hook = {
      command: process.execPath,
      args: [hookScriptPath, hookOutPath],
    };
    const args = buildLoginShellExecArgs(agentArgs, 'win32', hook, {}, logPath);
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 30000 });

    assert.equal(result.status, 5, `agent exit code should propagate: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(fs.existsSync(logPath), 'capture log file should exist');
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /agent-output-marker/, `captured log should contain the agent's stdout: ${logContent}`);
    assert.ok(fs.existsSync(hookOutPath), 'exit hook should have run');
    const hookOut = fs.readFileSync(hookOutPath, 'utf8');
    assert.match(hookOut, /received exit code: 5/, `exit hook should receive the correct exit code: ${hookOut}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoginShellExecArgs (実行): win32 でcaptureLogPath指定時、マルチバイト文字（日本語）が文字化けせずに複製される', (t) => {
  if (process.platform !== 'win32') {
    t.skip('win32専用のテスト');
    return;
  }
  // 実障害: Tee-Objectへのパイプは既定のコンソール出力エンコーディング（日本語Windowsでは
  // ANSI/OEMコードページ）でネイティブプロセスのUTF-8出力を解釈するため、パイプ無しの
  // 直接リダイレクトでは正しく保存される日本語テキストが、パイプ経由だと文字化けした。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-capture-encoding-test-'));
  const logPath = path.join(dir, 'out.log');
  try {
    const agentArgs = ['node', '-e', "console.log('日本語テストマーカー：これは代理送信で拾われる想定の文字列です')"];
    const args = buildLoginShellExecArgs(agentArgs, 'win32', null, {}, logPath);
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 30000 });

    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /日本語テストマーカー：これは代理送信で拾われる想定の文字列です/,
      `captured log should preserve multi-byte characters without mojibake: ${logContent}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoginShellExecArgs (実行): Unix でcaptureLogPath指定時、実際にログファイルへ複製され、終了コードも正しく伝わる', (t) => {
  const bashProbe = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    t.skip('bash の実行環境が利用できない');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-capture-test-'));
  const logPath = path.join(dir, 'out.log').replace(/\\/g, '/');
  try {
    const args = buildLoginShellExecArgs(
      ['bash', '-lc', 'printf agent-output-marker; exit 5'],
      'linux',
      null,
      {},
      logPath,
    );
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 30000 });

    assert.equal(result.status, 5, `agent exit code should propagate: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.ok(fs.existsSync(logPath), 'capture log file should exist');
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /agent-output-marker/, `captured log should contain the agent's stdout: ${logContent}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoginShellExecArgs: 空配列でエラーになる', () => {
  assert.throws(() => buildLoginShellExecArgs([]), /non-empty array/);
  assert.throws(() => buildLoginShellExecArgs(null), /non-empty array/);
  assert.throws(() => buildLoginShellExecArgs(undefined), /non-empty array/);
});

test('buildLoginShellExecArgs: デフォルトプラットフォームが process.platform を使う', () => {
  // 実行環境のプラットフォームが win32 かそれ以外かで期待値を変える
  const isWin = process.platform === 'win32';
  const args = buildLoginShellExecArgs(['agy', '-i', 'hello']);
  assert.equal(args[0], isWin ? 'pwsh' : 'bash');
});

// ── checkAgentExists ─────────────────────────────────────────────────────────

test('checkAgentExists: node は存在する', () => {
  assert.equal(checkAgentExists('node'), true);
});

test('checkAgentExists: 存在しないコマンドは false を返す', () => {
  assert.equal(checkAgentExists('nonexistent-command-xyz-123-test'), false);
});

test('checkAgentExists: 空文字列は false を返す', () => {
  assert.equal(checkAgentExists(''), false);
});

test('checkAgentExists: win32 で存在するコマンドを確認できる', () => {
  if (process.platform === 'win32') {
    // Windows では node.exe が必ず存在する
    assert.equal(checkAgentExists('node', 'win32'), true);
    assert.equal(checkAgentExists('nonexistent-cmd-xyz-win', 'win32'), false);
  }
});

test('checkAgentExists: Unix で存在するコマンドを確認できる', (t) => {
  // bash 非存在または bash 経由で node が解決不能な環境ではスキップ
  // （WSL 導入済み Windows では bash はあるが WSL 内に node が無いケースがある）
  if (!bashCanResolve('node')) {
    t.diagnostic('bash cannot resolve node — skipping Unix checkAgentExists test');
    return;
  }
  assert.equal(checkAgentExists('node', 'linux'), true);
  assert.equal(checkAgentExists('nonexistent-cmd-xyz-nix', 'linux'), false);
});

test('checkAgentExists: 異なるプラットフォーム指定で同一結果', (t) => {
  // node はどのプラットフォームでも解決可能
  assert.equal(checkAgentExists('node', 'win32'), true);
  // linux の確認は bash 経由で node が解決可能な環境のみ
  if (!bashCanResolve('node')) {
    t.diagnostic('bash cannot resolve node — skipping linux cross-platform check');
  } else {
    assert.equal(checkAgentExists('node', 'linux'), true);
  }
});
