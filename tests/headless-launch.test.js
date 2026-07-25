'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const headlessLaunch = require('../scripts/shared/headless-launch');
const { launchAgentHeadless, workerLogPath, SHIM_PATH } = headlessLaunch;
const { runShim } = require('../scripts/shared/headless-shim');

// 実プロセスは 0 個 spawn する（.claude/rules/test-process-spawn-safety.md）。
// spawn は必ず注入したフェイクへ差し替えてから呼ぶ。

let tmpDir;
let spawnCalls;

/**
 * spawn のフェイク。呼び出し引数を記録し、擬似的な子プロセスハンドルを返す。
 * @param {{pid?: number, noPid?: boolean, throwError?: Error}} [opts]
 *   noPid: true なら pid を持たないハンドルを返す（spawn 失敗時のNode挙動を模す）
 */
function fakeSpawn({ pid = 4242, noPid = false, throwError = null } = {}) {
  return (cmd, args, options) => {
    spawnCalls.push({ cmd, args, options });
    if (throwError) throw throwError;
    return {
      pid: noPid ? undefined : pid,
      unrefCalled: false,
      handlers: {},
      on(event, fn) { this.handlers[event] = fn; return this; },
      unref() { this.unrefCalled = true; },
    };
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-headless-test-'));
  spawnCalls = [];
  headlessLaunch._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');
});

afterEach(() => {
  headlessLaunch._setSpawn(require('../scripts/child-process').spawn);
  headlessLaunch._setGetProcessStartTime(require('../scripts/process-lifecycle').getProcessStartTime);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── workerLogPath ────────────────────────────────────────────────────────────

test('workerLogPath: 1ワーカー1ファイルのパスを .gh-maestro/worker-logs 配下に返す', () => {
  assert.equal(
    workerLogPath('/ws', 'issue-151-headless'),
    path.join('/ws', '.gh-maestro', 'worker-logs', 'issue-151-headless.log'),
  );
});

test('workerLogPath: 同じワーカー名なら毎回同じパスを返す（resumeも同じファイルへ追記される）', () => {
  assert.equal(workerLogPath('/ws', 'issue-5-fix'), workerLogPath('/ws', 'issue-5-fix'));
});

// ── launchAgentHeadless: 中継シム経由の detached 起動 ─────────────────────────

test('launchAgentHeadless: detached な node シム経由で起動する', () => {
  // Windows の detached(DETACHED_PROCESS) では pwsh が起動すらしないため、
  // detached にできる node のシムを1段挟む（実機確認済み。headless-shim.js 冒頭参照）。
  headlessLaunch._setSpawn(fakeSpawn());

  launchAgentHeadless({ argv: ['claude-ds', '--print'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') });

  assert.equal(spawnCalls.length, 1);
  const { cmd, args, options } = spawnCalls[0];
  assert.equal(cmd, process.execPath, 'detachedで起動するのは node でなければならない');
  assert.equal(args[0], SHIM_PATH);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, tmpDir);
});

test('launchAgentHeadless: シムにはログインシェルでラップ済みのargvをJSONで渡す', () => {
  headlessLaunch._setSpawn(fakeSpawn());
  const logPath = path.join(tmpDir, 'w.log');

  launchAgentHeadless({ argv: ['claude-ds', '--print'], cwd: tmpDir, logPath });

  const { args } = spawnCalls[0];
  const shellArgs = JSON.parse(args[1]);
  // $PROFILE の pwsh 関数として定義されたエージェントを解決するためログインシェル経由は必須
  assert.equal(shellArgs[0], process.platform === 'win32' ? 'pwsh' : 'bash');
  assert.notEqual(shellArgs[0], 'claude-ds');
  assert.equal(args[2], logPath);
});

test('launchAgentHeadless: シム自身の標準入出力は使わない（ログ書き込みはシムが開くfdが担う）', () => {
  headlessLaunch._setSpawn(fakeSpawn());

  launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') });

  assert.equal(spawnCalls[0].options.stdio, 'ignore');
});

test('launchAgentHeadless: NO_COLOR=1 を既定で注入する（ログはファイルであり端末ではない）', () => {
  headlessLaunch._setSpawn(fakeSpawn());

  launchAgentHeadless({ argv: ['reasonix', 'run'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') });

  const call = spawnCalls[0];
  assert.equal(call.options.env.NO_COLOR, '1');
  // ログインシェル側にも注入され、エージェントプロセスまで確実に届く
  const shellArgs = JSON.parse(call.args[1]);
  const serialized = process.platform === 'win32'
    ? Buffer.from(shellArgs[3], 'base64').toString('utf16le')
    : shellArgs[2];
  assert.match(serialized, /NO_COLOR/);
});

test('launchAgentHeadless: 呼び出し元が NO_COLOR を明示指定すればそちらが勝つ', () => {
  headlessLaunch._setSpawn(fakeSpawn());

  launchAgentHeadless({
    argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log'),
    env: { NO_COLOR: '0' },
  });

  assert.equal(spawnCalls[0].options.env.NO_COLOR, '0');
});

test('launchAgentHeadless: env をプロセス環境にマージして渡す', () => {
  headlessLaunch._setSpawn(fakeSpawn());

  launchAgentHeadless({
    argv: ['codex', 'exec'],
    cwd: tmpDir,
    logPath: path.join(tmpDir, 'w.log'),
    env: { GH_MAESTRO_WORKER: 'issue-151-x', GH_MAESTRO_WORKSPACE: tmpDir },
  });

  const { env } = spawnCalls[0].options;
  assert.equal(env.GH_MAESTRO_WORKER, 'issue-151-x');
  assert.equal(env.GH_MAESTRO_WORKSPACE, tmpDir);
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
});

test('launchAgentHeadless: onExit フックはシェルコマンド側に埋め込まれる（detachedでは親が終了を待てないため）', () => {
  headlessLaunch._setSpawn(fakeSpawn());

  launchAgentHeadless({
    argv: ['codex', 'exec'],
    cwd: tmpDir,
    logPath: path.join(tmpDir, 'w.log'),
    onExit: { command: 'node', args: ['/ws/worker-exit-hook.js', '/ws', ''] },
  });

  const shellArgs = JSON.parse(spawnCalls[0].args[1]);
  const serialized = process.platform === 'win32'
    ? Buffer.from(shellArgs[3], 'base64').toString('utf16le')
    : shellArgs.join(' ');
  assert.match(serialized, /worker-exit-hook\.js/);
});

// ── launchAgentHeadless: ログファイル ────────────────────────────────────────

test('launchAgentHeadless: ログファイルの親ディレクトリを自動作成する', () => {
  headlessLaunch._setSpawn(fakeSpawn());
  const logPath = path.join(tmpDir, 'nested', 'deeper', 'w.log');

  launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath });

  assert.ok(fs.existsSync(path.dirname(logPath)));
  assert.ok(fs.existsSync(logPath));
});

test('launchAgentHeadless: 既存ログを truncate せず追記モードで開く', () => {
  headlessLaunch._setSpawn(fakeSpawn());
  const logPath = path.join(tmpDir, 'w.log');
  fs.writeFileSync(logPath, '前回の実行ログ\n', 'utf8');

  launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath });

  assert.match(fs.readFileSync(logPath, 'utf8'), /前回の実行ログ/);
});

// ── launchAgentHeadless: 戻り値 ──────────────────────────────────────────────

test('launchAgentHeadless: pid・startTime・logPath を返す（PID再利用の誤判定を防ぐため startTime も返す）', () => {
  headlessLaunch._setSpawn(fakeSpawn({ pid: 31337 }));
  const logPath = path.join(tmpDir, 'w.log');

  const result = launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath });

  assert.deepEqual(result, { pid: 31337, startTime: '2026-07-25T00:00:00.000Z', logPath });
});

test('launchAgentHeadless: startTime が取得できなくても null を返して起動自体は成功扱いにする', () => {
  headlessLaunch._setSpawn(fakeSpawn({ pid: 99 }));
  headlessLaunch._setGetProcessStartTime(() => null);

  const result = launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') });

  assert.equal(result.pid, 99);
  assert.equal(result.startTime, null);
});

test('launchAgentHeadless: 呼び出し元をブロックしないよう unref する', () => {
  let child = null;
  headlessLaunch._setSpawn((cmd, args, options) => {
    spawnCalls.push({ cmd, args, options });
    child = { pid: 1234, unrefCalled: false, unref() { this.unrefCalled = true; } };
    return child;
  });

  launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') });

  assert.equal(child.unrefCalled, true);
});

// ── launchAgentHeadless: 異常系 ──────────────────────────────────────────────

test('launchAgentHeadless: spawn が例外を投げたら起動失敗として throw する', () => {
  headlessLaunch._setSpawn(fakeSpawn({ throwError: new Error('ENOENT') }));

  assert.throws(
    () => launchAgentHeadless({ argv: ['nonexistent'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') }),
    /エージェントプロセスの起動に失敗しました.*ENOENT/,
  );
});

test('launchAgentHeadless: PIDが得られなければ throw する（起動成功と誤認しない）', () => {
  headlessLaunch._setSpawn(fakeSpawn({ noPid: true }));

  assert.throws(
    () => launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') }),
    /PIDを取得できませんでした/,
  );
});

test('launchAgentHeadless: ログファイルを準備できなければ throw し、プロセスを起動しない', () => {
  headlessLaunch._setSpawn(fakeSpawn());
  // 親が通常ファイルなので、ログディレクトリの作成・オープンのどちらも成功しない
  const parent = path.join(tmpDir, 'not-a-dir');
  fs.writeFileSync(parent, 'x', 'utf8');

  assert.throws(
    () => launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(parent, 'w.log') }),
    /ログファイルを開けません/,
  );
  // 記録の残らないワーカーを走らせない（本Issueが解消しようとしている状態の再発防止）
  assert.equal(spawnCalls.length, 0, 'ログを準備できない時点でspawnしない');
});

// ── テスト中の実プロセス起動ガード ───────────────────────────────────────────

test('launchAgentHeadless: spawnを注入していなければテスト中は実起動を拒否する', () => {
  // 実障害: 引数バリデーションを検証するだけのテストが worktree 作成とエージェント起動まで
  // 到達し、実際に claude.exe が4本起動してトークンを消費した。ここが最後の砦になる。
  // このテスト自体が node --test 配下なので NODE_TEST_CONTEXT が立っている。
  assert.ok(process.env.NODE_TEST_CONTEXT, '前提: テストランナー配下で実行されている');

  // spawn を実装に戻す（=注入されていない状態）
  headlessLaunch._setSpawn(require('../scripts/child-process').spawn);

  assert.throws(
    () => launchAgentHeadless({ argv: ['codex', 'exec'], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') }),
    /実ワーカーを起動しません/,
  );
});

test('launchAgentHeadless: argv が空なら throw する（agent-exec のバリデーションが効く）', () => {
  headlessLaunch._setSpawn(fakeSpawn());

  assert.throws(
    () => launchAgentHeadless({ argv: [], cwd: tmpDir, logPath: path.join(tmpDir, 'w.log') }),
    /non-empty array/,
  );
  assert.equal(spawnCalls.length, 0);
});

// ── headless-shim: 中継プロセス本体 ──────────────────────────────────────────

test('runShim: 子を非detachedで起動し、stdout/stderrを同一fdへ直接リダイレクトする', () => {
  const logPath = path.join(tmpDir, 'w.log');
  const calls = [];
  const spawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { on() { return this; } };
  };

  runShim({ shellArgs: ['pwsh', '-NoLogo', '-EncodedCommand', 'AAA='], logPath, spawnFn, onExit: () => {} });

  assert.equal(calls.length, 1);
  const { options } = calls[0];
  // detached にしてはならない（そこが本シムの存在理由）
  assert.ok(!options.detached, 'シムの子は detached にしてはならない');
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio[0], 'ignore');
  assert.equal(typeof options.stdio[1], 'number');
  assert.equal(options.stdio[1], options.stdio[2]);
  assert.ok(!options.stdio.includes('pipe'), 'パイプを使ってはならない');
});

test('runShim: 子の終了コードをそのまま引き継ぐ（シムの生死=ワーカーの生死）', () => {
  const logPath = path.join(tmpDir, 'w.log');
  let exitHandler;
  const spawnFn = () => ({
    on(event, fn) { if (event === 'exit') exitHandler = fn; return this; },
  });
  const exits = [];

  runShim({ shellArgs: ['bash', '-lc', 'x'], logPath, spawnFn, onExit: (c) => exits.push(c) });
  exitHandler(3, null);

  assert.deepEqual(exits, [3]);
});

test('runShim: シグナル終了は非ゼロ扱いにする', () => {
  const logPath = path.join(tmpDir, 'w.log');
  let exitHandler;
  const spawnFn = () => ({ on(event, fn) { if (event === 'exit') exitHandler = fn; return this; } });
  const exits = [];

  runShim({ shellArgs: ['bash', '-lc', 'x'], logPath, spawnFn, onExit: (c) => exits.push(c) });
  exitHandler(null, 'SIGKILL');

  assert.deepEqual(exits, [1]);
});

test('runShim: 起動失敗をログへ書き残す（シムは標準出力を持たないため、書かないと追跡不能になる）', () => {
  const logPath = path.join(tmpDir, 'w.log');
  const spawnFn = () => { throw new Error('spawn ENOENT'); };

  assert.throws(
    () => runShim({ shellArgs: ['pwsh'], logPath, spawnFn, onExit: () => {} }),
    /spawn ENOENT/,
  );
  assert.match(fs.readFileSync(logPath, 'utf8'), /ワーカープロセスの起動に失敗しました.*spawn ENOENT/);
});

test('runShim: 子のerrorイベントもログへ書き残し、非ゼロ終了として通知する', () => {
  const logPath = path.join(tmpDir, 'w.log');
  let errorHandler;
  const spawnFn = () => ({
    on(event, fn) { if (event === 'error') errorHandler = fn; return this; },
  });
  const exits = [];

  runShim({ shellArgs: ['pwsh'], logPath, spawnFn, onExit: (c) => exits.push(c) });
  errorHandler(new Error('boom'));

  assert.deepEqual(exits, [1]);
  assert.match(fs.readFileSync(logPath, 'utf8'), /エラーが発生しました.*boom/);
});

test('runShim: 既存ログへ追記する（resumeで同じファイルに繋がる）', () => {
  const logPath = path.join(tmpDir, 'w.log');
  fs.writeFileSync(logPath, '前回分\n', 'utf8');
  const spawnFn = () => ({ on() { return this; } });

  runShim({ shellArgs: ['bash', '-lc', 'x'], logPath, spawnFn, onExit: () => {} });

  assert.match(fs.readFileSync(logPath, 'utf8'), /前回分/);
});
