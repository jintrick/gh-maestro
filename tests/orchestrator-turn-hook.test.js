'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hook = require('../scripts/orchestrator-turn-hook');
const { withTempDir } = require('../scripts/shared/temp-directory');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'orchestrator-turn-hook.js');
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function makeEnv(root) {
  const workspace = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    runtimeRoot,
    deps(extra = {}) {
      return {
        env: { CLAUDE_PROJECT_DIR: workspace },
        resolveWorkspaceFn: (value) => (value ? path.resolve(value) : null),
        runtimeRoot,
        ...extra,
      };
    },
  };
}

function withEnv(fn) {
  return withTempDir('ghm-turn-hook-', (root) => fn(makeEnv(root)));
}

function mark(env, sessionId) {
  const result = hook.runHook('mark', { session_id: sessionId }, env.deps({
    now: () => new Date('2026-10-13T00:00:00.000Z'),
  }));
  assert.equal(result.exitCode, 0);
}

function recordingSpawn(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, fn };
}

test('mark: hook入力の session_id を workspace runtime に記録する', () => {
  withEnv((env) => {
    mark(env, 'session-A');
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    assert.equal(path.basename(file), 'orchestrator-claude-session.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(data, {
      schemaVersion: 1,
      sessionId: 'session-A',
      recordedAt: '2026-10-13T00:00:00.000Z',
    });
  });
});

test('mark: 後の /gh-maestro が記録を上書きし、前のセッションは対象外になる', () => {
  withEnv((env) => {
    mark(env, 'session-A');
    mark(env, 'session-B');
    const spawn = recordingSpawn();
    assert.equal(hook.runHook('stop', { session_id: 'session-A' }, env.deps({ spawnSyncFn: spawn.fn })).exitCode, 0);
    assert.equal(spawn.calls.length, 0);
    assert.equal(hook.runHook('stop', { session_id: 'session-B' }, env.deps({ spawnSyncFn: spawn.fn })).exitCode, 0);
    assert.equal(spawn.calls.length, 1);
  });
});

test('prompt: 記録済みセッションでは規範の要約を additionalContext として返す', () => {
  withEnv((env) => {
    mark(env, 'session-A');
    const result = hook.runHook('prompt', { session_id: 'session-A' }, env.deps());
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = output.hookSpecificOutput.additionalContext;
    // 受け入れ条件の3規範を、要約ファイルとは独立した語で確認する。
    assert.match(context, /番号と呼称の規約/);
    assert.match(context, /工程N-\[n\/m\]/);
    assert.match(context, /人間への質問/);
    assert.match(context, /問いは1つ/);
    assert.match(context, /判断・伝え方の心得/);
    assert.match(context, /GitHub に置き/);
  });
});

test('prompt: 記録と異なるセッション・記録なしでは何も出力しない', () => {
  withEnv((env) => {
    const before = hook.runHook('prompt', { session_id: 'session-A' }, env.deps());
    assert.deepEqual(before, { exitCode: 0 });
    mark(env, 'session-A');
    const other = hook.runHook('prompt', { session_id: 'worker-session' }, env.deps());
    assert.deepEqual(other, { exitCode: 0 });
  });
});

test('stop: 記録済みセッションでは notify-human.js を workspace 付きで実行する', () => {
  withEnv((env) => {
    mark(env, 'session-A');
    const spawn = recordingSpawn();
    const result = hook.runHook('stop', { session_id: 'session-A' }, env.deps({ spawnSyncFn: spawn.fn }));
    assert.equal(result.exitCode, 0);
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].command, process.execPath);
    assert.deepEqual(spawn.calls[0].args, [
      path.join(SCRIPTS_DIR, 'notify-human.js'), '--workspace', env.workspace,
    ]);
  });
});

test('stop: 記録と異なるセッション・記録なしでは通知しない', () => {
  withEnv((env) => {
    const spawn = recordingSpawn();
    assert.deepEqual(hook.runHook('stop', { session_id: 'session-A' }, env.deps({ spawnSyncFn: spawn.fn })), { exitCode: 0 });
    mark(env, 'session-A');
    assert.deepEqual(hook.runHook('stop', { session_id: 'worker-session' }, env.deps({ spawnSyncFn: spawn.fn })), { exitCode: 0 });
    assert.equal(spawn.calls.length, 0);
  });
});

test('stop: 通知の失敗は終了コード1で返し、ブロックの終了コード2を使わない', () => {
  withEnv((env) => {
    mark(env, 'session-A');
    const failed = recordingSpawn({ status: 7, stdout: '', stderr: 'curl failed' });
    const result = hook.runHook('stop', { session_id: 'session-A' }, env.deps({ spawnSyncFn: failed.fn }));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /通知に失敗しました: curl failed/);

    const spawnError = recordingSpawn({ status: null, error: new Error('ENOENT node') });
    const errored = hook.runHook('stop', { session_id: 'session-A' }, env.deps({ spawnSyncFn: spawnError.fn }));
    assert.equal(errored.exitCode, 1);
    assert.match(errored.stderr, /ENOENT node/);
  });
});

test('prompt/stop: workspace を解決できないプロジェクトでは何もしない', () => {
  withEnv((env) => {
    const spawn = recordingSpawn();
    const deps = env.deps({ resolveWorkspaceFn: () => null, spawnSyncFn: spawn.fn });
    assert.deepEqual(hook.runHook('prompt', { session_id: 'x' }, deps), { exitCode: 0 });
    assert.deepEqual(hook.runHook('stop', { session_id: 'x' }, deps), { exitCode: 0 });
    assert.equal(spawn.calls.length, 0);
    assert.equal(hook.runHook('mark', { session_id: 'x' }, deps).exitCode, 1);
  });
});

test('壊れた記録: JSON構文エラーは修復せずエラーにする', () => {
  withEnv((env) => {
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json', 'utf8');
    const spawn = recordingSpawn();
    assert.throws(() => hook.runHook('stop', { session_id: 'session-A' }, env.deps({ spawnSyncFn: spawn.fn })));
    assert.equal(spawn.calls.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  });
});

test('壊れた記録: sessionId の型不正は修復せずエラーにする', () => {
  withEnv((env) => {
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"schemaVersion":1,"sessionId":42}', 'utf8');
    assert.throws(
      () => hook.runHook('prompt', { session_id: 'session-A' }, env.deps()),
      /orchestratorセッション記録が不正です/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion":1,"sessionId":42}');
  });
});

test('main: 壊れた記録・不正なhook入力は終了コード1で、標準出力を出さない', () => {
  withEnv((env) => {
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]', 'utf8');
    const out = [];
    const err = [];
    const options = {
      ...env.deps(),
      writeStdoutFn: (v) => out.push(v),
      writeStderrFn: (v) => err.push(v),
      isStdinTTY: () => false,
    };
    assert.equal(hook.main(['prompt'], { ...options, readStdinFn: () => '{"session_id":"s"}' }), 1);
    assert.equal(hook.main(['prompt'], { ...options, readStdinFn: () => '{"cwd":"x"}' }), 1);
    assert.equal(hook.main(['prompt'], { ...options, readStdinFn: () => 'not json' }), 1);
    assert.deepEqual(out, []);
    assert.equal(err.length, 3);
  });
});

test('main: 引数検証とTTY拒否', () => {
  const err = [];
  const out = [];
  const options = { writeStdoutFn: (v) => out.push(v), writeStderrFn: (v) => err.push(v) };
  assert.equal(hook.main(['unknown'], { ...options, isStdinTTY: () => false, readStdinFn: () => '{}' }), 1);
  assert.equal(hook.main([], options), 1);
  assert.equal(hook.main(['stop', 'extra'], options), 1);
  assert.equal(hook.main(['stop'], { ...options, isStdinTTY: () => true }), 1);
  assert.match(err.join(''), /標準入力がTTYです/);
});

test('CLI: --help は終了コード0でUsageを出す', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /mark\|prompt\|stop/);
});

test('CLI: 実プロセスで mark → prompt が規範を返し、別セッションには返さない', () => {
  withEnv((env) => {
    const childEnv = { ...process.env, GH_MAESTRO_RUNTIME_DIR: env.runtimeRoot, CLAUDE_PROJECT_DIR: env.workspace };
    const run = (mode, input) => spawnSync(process.execPath, [SCRIPT, mode], {
      encoding: 'utf8', env: childEnv, input: JSON.stringify(input),
    });
    assert.equal(run('mark', { session_id: 'session-A' }).status, 0);
    const own = run('prompt', { session_id: 'session-A' });
    assert.equal(own.status, 0, own.stderr);
    assert.match(JSON.parse(own.stdout).hookSpecificOutput.additionalContext, /問いは1つ/);
    const other = run('prompt', { session_id: 'session-B' });
    assert.equal(other.status, 0, other.stderr);
    assert.equal(other.stdout, '');
  });
});

test('CLI: モード欠落・未知のモード・余分な位置引数は非0で終了する', () => {
  for (const args of [[], ['unknown'], ['stop', 'extra']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input: '{"session_id":"s"}' });
    assert.equal(result.status, 1, `args=${args.join(' ')}`);
    assert.match(result.stderr, /orchestrator-turn-hook: /);
    assert.equal(result.stdout, '');
  }
});
