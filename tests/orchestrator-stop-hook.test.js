'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hook = require('../scripts/orchestrator-stop-hook');
const { withTempDir } = require('../scripts/shared/temp-directory');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'orchestrator-stop-hook.js');
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const QUESTION = '工程7-[4/5]\n\n変更点は次のとおりです。\n\n**PR #612 をマージしますか？**';

function withEnv(fn) {
  return withTempDir('ghm-stop-hook-', (root) => {
    const workspace = path.join(root, 'workspace');
    const runtimeRoot = path.join(root, 'runtime');
    fs.mkdirSync(workspace, { recursive: true });
    return fn({
      workspace,
      runtimeRoot,
      mark(sessionId) {
        hook.markOrchestratorSession(workspace, sessionId, {
          runtimeRoot, now: () => new Date('2026-10-13T00:00:00.000Z'),
        });
      },
      deps(extra = {}) {
        return {
          env: { CLAUDE_PROJECT_DIR: workspace },
          resolveWorkspaceFn: (value) => (value ? path.resolve(value) : null),
          runtimeRoot,
          // 既定では待たない。待つあいだの出来事は各テストが sleepFn で起こす。
          sleepFn: () => {},
          ...extra,
        };
      },
    });
  });
}

function recordingSpawn(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  return { calls, fn: (command, args, options) => { calls.push({ command, args, options }); return result; } };
}

test('markOrchestratorSession: session_id を workspace runtime に記録し、後の記録で上書きする', () => {
  withEnv((env) => {
    env.mark('session-A');
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    assert.equal(path.basename(file), 'orchestrator-claude-session.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      schemaVersion: 1, sessionId: 'session-A', recordedAt: '2026-10-13T00:00:00.000Z',
    });
    env.mark('session-B');
    assert.equal(hook.readMarkedSessionId(file), 'session-B');
    assert.throws(() => hook.markOrchestratorSession(env.workspace, '', { runtimeRoot: env.runtimeRoot }));
  });
});

test('stop: 記録済みセッションの応答なら notify-human.js を workspace 付きで実行する', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    const result = hook.runNotificationHook(
      { session_id: 'session-A', last_assistant_message: QUESTION },
      env.deps({ spawnSyncFn: spawn.fn }),
    );
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].command, process.execPath);
    assert.deepEqual(spawn.calls[0].args, [path.join(SCRIPTS_DIR, 'notify-human.js'), '--workspace', env.workspace]);
  });
});

test('stop: 記録済みセッションなら、問いで終わらない応答・空の応答・応答なしでも通知する', () => {
  for (const message of ['PR #614 をマージしました。', 'よいですか？\n\n報告を待っています。', '', undefined]) {
    withEnv((env) => {
      env.mark('session-A');
      const spawn = recordingSpawn();
      const input = { session_id: 'session-A' };
      if (message !== undefined) input.last_assistant_message = message;
      const result = hook.runNotificationHook(input, env.deps({ spawnSyncFn: spawn.fn }));
      assert.deepEqual(result, { exitCode: 0 }, String(message));
      assert.equal(spawn.calls.length, 1, String(message));
      assert.deepEqual(spawn.calls[0].args, [path.join(SCRIPTS_DIR, 'notify-human.js'), '--workspace', env.workspace]);
    });
  }
});

test('stop: 通知を予約して既定の30秒を待ち、予約が残っていれば1回通知して予約を消す', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    const waits = [];
    const file = hook.pendingPath(env.workspace, env.runtimeRoot);
    const result = hook.runNotificationHook({ session_id: 'session-A' }, env.deps({
      spawnSyncFn: spawn.fn,
      randomUUIDFn: () => 'token-1',
      sleepFn: (ms) => {
        waits.push(ms);
        assert.equal(hook.readPendingToken(file), 'token-1');
        assert.equal(spawn.calls.length, 0, '待つ前に通知しない');
      },
      delayMs: undefined,
    }));
    assert.deepEqual(result, { exitCode: 0 });
    assert.deepEqual(waits, [30000]);
    assert.equal(spawn.calls.length, 1);
    assert.equal(fs.existsSync(file), false);
  });
});

test('stop: 待つあいだに次の Stop が発火したら、前の予約は通知せず、後の予約だけが1回通知する', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    let n = 0;
    const deps = env.deps({
      spawnSyncFn: spawn.fn,
      randomUUIDFn: () => `token-${++n}`,
      sleepFn: () => {
        if (n === 1) hook.runNotificationHook({ session_id: 'session-A' }, deps);
      },
    });
    const first = hook.runNotificationHook({ session_id: 'session-A', last_assistant_message: QUESTION }, deps);
    assert.deepEqual(first, { exitCode: 0 });
    assert.equal(spawn.calls.length, 1);
    assert.equal(fs.existsSync(hook.pendingPath(env.workspace, env.runtimeRoot)), false);
  });
});

test('cancel: 待つあいだに人間が入力したら（--cancel）、通知しない', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    const result = hook.runNotificationHook({ session_id: 'session-A' }, env.deps({
      spawnSyncFn: spawn.fn,
      sleepFn: () => assert.deepEqual(hook.runCancelHook({ session_id: 'session-A' }, env.deps()), { exitCode: 0 }),
    }));
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(spawn.calls.length, 0);
  });
});

test('monitor task-notification の UserPromptSubmit 後に — で Stop しても先の予約を通知する', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    const file = hook.pendingPath(env.workspace, env.runtimeRoot);
    const events = [];
    const monitorPrompt = '<task-notification>\n<event>MONITOR_PROBE</event>\n</task-notification>';
    const firstStop = hook.runNotificationHook({
      session_id: 'session-A', hook_event_name: 'Stop', last_assistant_message: QUESTION,
    }, env.deps({
      spawnSyncFn: spawn.fn,
      randomUUIDFn: () => 'original-reservation',
      delayMs: 0,
      sleepFn: () => {
        events.push('Stop');
        assert.equal(hook.readPendingToken(file), 'original-reservation');
        assert.deepEqual(hook.runCancelHook({
          session_id: 'session-A', hook_event_name: 'UserPromptSubmit', prompt: monitorPrompt,
        }, env.deps()), { exitCode: 0 });
        events.push('UserPromptSubmit:monitor');
        assert.equal(hook.readPendingToken(file), 'original-reservation');
        assert.deepEqual(hook.runNotificationHook({
          session_id: 'session-A', hook_event_name: 'Stop', last_assistant_message: '—',
        }, env.deps({ spawnSyncFn: spawn.fn })), { exitCode: 0 });
        events.push('Stop:dash');
        assert.equal(hook.readPendingToken(file), 'original-reservation');
      },
    }));

    assert.deepEqual(events, ['Stop', 'UserPromptSubmit:monitor', 'Stop:dash']);
    assert.deepEqual(firstStop, { exitCode: 0 });
    assert.equal(spawn.calls.length, 1);
    assert.equal(fs.existsSync(file), false);
  });
});

test('permission request: AskUserQuestion の回答後の PostToolUse 取消で、継続中に通知しない', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    const input = { session_id: 'session-A', tool_name: 'AskUserQuestion' };
    const result = hook.runNotificationHook(input, env.deps({
      spawnSyncFn: spawn.fn,
      sleepFn: () => {
        assert.deepEqual(hook.runCancelHook(input, env.deps()), { exitCode: 0 });
      },
    }));
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(spawn.calls.length, 0);
    assert.equal(fs.existsSync(hook.pendingPath(env.workspace, env.runtimeRoot)), false);
  });
});

test('拒否・中断: 後続入力がなければ予約を維持し、通知を1回送る', () => {
  withEnv((env) => {
    env.mark('session-A');
    const spawn = recordingSpawn();
    const result = hook.runNotificationHook(
      { session_id: 'session-A', tool_name: 'AskUserQuestion' },
      env.deps({ spawnSyncFn: spawn.fn, randomUUIDFn: () => 'permission-pending' }),
    );
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(spawn.calls.length, 1);
    assert.equal(fs.existsSync(hook.pendingPath(env.workspace, env.runtimeRoot)), false);
  });
});

test('Stop: 末尾が — なら予約せず、既存予約も変更しない', () => {
  for (const message of ['—', '  — \n', '処理が完了しました—', '処理が完了しました—  \n']) {
    withEnv((env) => {
      env.mark('session-A');
      const spawn = recordingSpawn();
      const file = hook.pendingPath(env.workspace, env.runtimeRoot);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existing = JSON.stringify({ schemaVersion: 1, token: 'question-reservation', hookEventName: 'Stop' });
      fs.writeFileSync(file, existing, 'utf8');
      const result = hook.runNotificationHook({
        session_id: 'session-A', hook_event_name: 'Stop', last_assistant_message: message,
      }, env.deps({ spawnSyncFn: spawn.fn, randomUUIDFn: () => 'must-not-replace' }));
      assert.deepEqual(result, { exitCode: 0 });
      assert.equal(fs.readFileSync(file, 'utf8'), existing);
      assert.equal(spawn.calls.length, 0);
    });
  }
});

test('Stop: 末尾が — でない応答は予約し、PermissionRequest の — も予約する', () => {
  for (const [event, message] of [
    ['Stop', '文中に—がある'], ['Stop', '最後は-'], ['Stop', '最後は–'], ['Stop', '最後は―'],
    ['PermissionRequest', '—'],
  ]) {
    withEnv((env) => {
      env.mark('session-A');
      const spawn = recordingSpawn();
      hook.runNotificationHook({ session_id: 'session-A', hook_event_name: event, last_assistant_message: message },
        env.deps({ spawnSyncFn: spawn.fn }));
      assert.equal(spawn.calls.length, 1, `${event}: ${message}`);
    });
  }
});

test('PostToolUse と PostToolUseFailure は PermissionRequest 由来だけを取り消し、UserPromptSubmit はすべて取り消す', () => {
  for (const [source, cancelEvent, shouldCancel] of [
    ['Stop', 'PostToolUse', false], ['StopFailure', 'PostToolUseFailure', false],
    ['PermissionRequest', 'PostToolUse', true], ['PermissionRequest', 'PostToolUseFailure', true],
    ['Stop', 'UserPromptSubmit', true], ['PermissionRequest', 'UserPromptSubmit', true],
  ]) {
    withEnv((env) => {
      env.mark('session-A');
      const file = hook.pendingPath(env.workspace, env.runtimeRoot);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, token: 'pending', hookEventName: source }), 'utf8');
      hook.runCancelHook({ session_id: 'session-A', hook_event_name: cancelEvent }, env.deps());
      assert.equal(fs.existsSync(file), !shouldCancel, `${cancelEvent} / ${source}`);
    });
  }
});

test('cancel: 記録と異なるセッション・記録なしの入力では予約を取り消さない', () => {
  withEnv((env) => {
    const spawn = recordingSpawn();
    const other = () => {
      assert.deepEqual(hook.runCancelHook({ session_id: 'worker-session' }, env.deps()), { exitCode: 0 });
    };
    env.mark('session-A');
    hook.runNotificationHook({ session_id: 'session-A' }, env.deps({ spawnSyncFn: spawn.fn, sleepFn: other }));
    assert.equal(spawn.calls.length, 1);
  });
  withEnv((env) => {
    assert.deepEqual(hook.runCancelHook({ session_id: 'session-A' }, env.deps()), { exitCode: 0 });
    assert.equal(fs.existsSync(hook.pendingPath(env.workspace, env.runtimeRoot)), false);
  });
});

test('壊れた予約: 待ち終えたときの予約が壊れていれば、修復も通知もせずエラーにする', () => {
  for (const content of ['{not json', '{"schemaVersion":1,"token":42}']) {
    withEnv((env) => {
      env.mark('session-A');
      const spawn = recordingSpawn();
      const file = hook.pendingPath(env.workspace, env.runtimeRoot);
      assert.throws(() => hook.runNotificationHook({ session_id: 'session-A' }, env.deps({
        spawnSyncFn: spawn.fn,
        sleepFn: () => fs.writeFileSync(file, content, 'utf8'),
      })), content.startsWith('{"') ? /通知の予約が不正です/ : undefined);
      assert.equal(spawn.calls.length, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    });
  }
});

test('stop: 記録と異なるセッション（ワーカー・前のセッション）・記録なしでは通知しない', () => {
  withEnv((env) => {
    const spawn = recordingSpawn();
    const input = (id) => ({ session_id: id, last_assistant_message: QUESTION });
    assert.deepEqual(hook.runNotificationHook(input('session-A'), env.deps({ spawnSyncFn: spawn.fn })), { exitCode: 0 });
    env.mark('session-A');
    env.mark('session-B');
    assert.deepEqual(hook.runNotificationHook(input('session-A'), env.deps({ spawnSyncFn: spawn.fn })), { exitCode: 0 });
    assert.deepEqual(hook.runNotificationHook(input('worker-session'), env.deps({ spawnSyncFn: spawn.fn })), { exitCode: 0 });
    assert.equal(spawn.calls.length, 0);
  });
});

test('stop: workspace を解決できないプロジェクトでは何もしない', () => {
  withEnv((env) => {
    const spawn = recordingSpawn();
    const result = hook.runNotificationHook(
      { session_id: 'x', last_assistant_message: QUESTION },
      env.deps({ resolveWorkspaceFn: () => null, spawnSyncFn: spawn.fn }),
    );
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(spawn.calls.length, 0);
  });
});

test('stop: 通知の失敗は終了コード1で返し、ブロックの終了コード2を使わない', () => {
  withEnv((env) => {
    env.mark('session-A');
    const input = { session_id: 'session-A', last_assistant_message: QUESTION };
    const failed = hook.runNotificationHook(input, env.deps({
      spawnSyncFn: recordingSpawn({ status: 7, stdout: '', stderr: 'curl failed' }).fn,
    }));
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stderr, /通知に失敗しました: curl failed/);
    const errored = hook.runNotificationHook(input, env.deps({
      spawnSyncFn: recordingSpawn({ status: null, error: new Error('ENOENT node') }).fn,
    }));
    assert.equal(errored.exitCode, 1);
    assert.match(errored.stderr, /ENOENT node/);
  });
});

test('壊れた記録: JSON構文エラーは修復せずエラーにする', () => {
  withEnv((env) => {
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json', 'utf8');
    const spawn = recordingSpawn();
    assert.throws(() => hook.runNotificationHook(
      { session_id: 's', last_assistant_message: QUESTION },
      env.deps({ spawnSyncFn: spawn.fn }),
    ));
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
      () => hook.runNotificationHook({ session_id: 's', last_assistant_message: QUESTION }, env.deps()),
      /orchestratorセッション記録が不正です/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion":1,"sessionId":42}');
  });
});

test('main: 壊れた記録・不正なhook入力は終了コード1', () => {
  withEnv((env) => {
    const file = hook.markerPath(env.workspace, env.runtimeRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]', 'utf8');
    const err = [];
    const options = {
      ...env.deps(),
      writeStdoutFn: () => {},
      writeStderrFn: (v) => err.push(v),
      isStdinTTY: () => false,
    };
    assert.equal(hook.main([], { ...options, readStdinFn: () => '{"session_id":"s"}' }), 1);
    assert.equal(hook.main([], { ...options, readStdinFn: () => '{"cwd":"x"}' }), 1);
    assert.equal(hook.main([], { ...options, readStdinFn: () => 'not json' }), 1);
    assert.equal(err.length, 3);
  });
});

test('main: TTYの標準入力は拒否する', () => {
  const err = [];
  const code = hook.main([], { writeStdoutFn: () => {}, writeStderrFn: (v) => err.push(v), isStdinTTY: () => true });
  assert.equal(code, 1);
  assert.match(err.join(''), /標準入力がTTYです/);
});

test('CLI: --help は終了コード0、余分な位置引数は非0', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /Stop \/ StopFailure \/ PermissionRequest/);
  assert.match(help.stdout, /PostToolUse \/ PostToolUseFailure \/ UserPromptSubmit/);
  const extra = spawnSync(process.execPath, [SCRIPT, 'stop'], { encoding: 'utf8', input: '{"session_id":"s"}' });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /orchestrator-stop-hook: /);
});

test('CLI: 実プロセスの --cancel は予約を消し、標準出力に何も書かず終了コード0', () => {
  withEnv((env) => {
    env.mark('session-A');
    const file = hook.pendingPath(env.workspace, env.runtimeRoot);
    fs.writeFileSync(file, '{"schemaVersion":1,"token":"t"}', 'utf8');
    const run = (sessionId) => spawnSync(process.execPath, [SCRIPT, '--cancel'], {
      encoding: 'utf8',
      env: { ...process.env, GH_MAESTRO_RUNTIME_DIR: env.runtimeRoot, CLAUDE_PROJECT_DIR: env.workspace },
      input: JSON.stringify({ session_id: sessionId, prompt: 'はい' }),
    });
    const other = run('worker-session');
    assert.equal(other.status, 0, other.stderr);
    assert.equal(fs.existsSync(file), true);
    const own = run('session-A');
    assert.equal(own.status, 0, own.stderr);
    assert.equal(own.stdout, '');
    assert.equal(own.stderr, '');
    assert.equal(fs.existsSync(file), false);
  });
});

test('CLI: 実プロセスで、記録と異なるセッションの応答には通知せず終了コード0', () => {
  withEnv((env) => {
    env.mark('session-A');
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GH_MAESTRO_RUNTIME_DIR: env.runtimeRoot, CLAUDE_PROJECT_DIR: env.workspace },
      input: JSON.stringify({ session_id: 'worker-session', last_assistant_message: QUESTION }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});
