'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// watchdog-exit-notify.js はプロセス終了時に非ゼロ終了を orchestrator へ通知する共有ヘルパー。
// child-process.js の spawnSync をモックし、実プロセスを0個 spawn する
// （.claude/rules/test-process-spawn-safety.md 準拠）。本文は実 msg-send.js には渡さず、
// spawnSync の input 引数として検証する。

const helperPath = require.resolve('../scripts/shared/watchdog-exit-notify');

/**
 * child-process.js の spawnSync をモックした状態で watchdog-exit-notify.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts) => result
 */
function loadHelper(spawnSyncImpl) {
  const calls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0, stdout: '', stderr: '' };
  };
  const childProcessPath = require.resolve('../scripts/shared/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: { spawnSync: fakeSpawnSync },
  };
  delete require.cache[helperPath];
  const mod = require(helperPath);
  delete require.cache[childProcessPath];
  return { mod, calls };
}

test('正常終了（exitCode 0）では何も投稿しない', () => {
  const saved = process.exitCode;
  process.exitCode = 0;
  const { mod, calls } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  try {
    const posted = mod.notifyWatchdogExit({ workspace: '/ws', scriptName: 'poll-pr.js', issue: '5' });
    assert.equal(posted, false);
    assert.equal(calls.length, 0);
  } finally {
    process.exitCode = saved;
  }
});

test('非ゼロ終了では orchestrator 宛てに msg-send.js へ投稿する', () => {
  const saved = process.exitCode;
  process.exitCode = 7;
  const { mod, calls } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  try {
    const posted = mod.notifyWatchdogExit({ workspace: '/ws', scriptName: 'poll-pr.js', issue: '5' });
    assert.equal(posted, true);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.cmd, process.execPath);
    assert.ok(call.args.some(a => a.endsWith('msg-send.js')));
    // 非ワーカーコンテキストの msg-send.js は宛先を位置引数で受け取る（PR #251）
    assert.ok(call.args.includes('orchestrator'));
    // 成りすまし防止のため --from にスクリプト名を明示
    assert.ok(call.args.includes('--from'));
    assert.ok(call.args.includes('poll-pr.js'));
    assert.ok(call.args.includes('--issue'));
    assert.ok(call.args.includes('5'));
    // 本文は位置引数ではなく stdin 経由（msg-send.js のガード準拠）
    assert.match(call.opts.input, /poll-pr.js/);
    assert.match(call.opts.input, /exit code 7/);
  } finally {
    process.exitCode = saved;
  }
});

test('msg-send の投稿が失敗しても throw せず false を返す（best-effort）', () => {
  const saved = process.exitCode;
  process.exitCode = 1;
  const { mod, calls } = loadHelper(() => ({ status: 1, stderr: 'boom' }));
  try {
    let posted;
    assert.doesNotThrow(() => {
      posted = mod.notifyWatchdogExit({ workspace: '/ws', scriptName: 'msg-poll.js', issue: '5' });
    });
    assert.equal(posted, false);
    assert.equal(calls.length, 1); // 試行は1回だけ
  } finally {
    process.exitCode = saved;
  }
});

test('issue 未指定なら workers.json の先頭ワーカーの Issue を解決する', () => {
  const saved = process.exitCode;
  process.exitCode = 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-watchdog-test-'));
  const ghDir = path.join(dir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({ w1: { issue: 42 } }), 'utf8');
  const { mod, calls } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  try {
    mod.notifyWatchdogExit({ workspace: dir, scriptName: 'poll-pr.js' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('42'));
  } finally {
    process.exitCode = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('送信先Issueが無い場合は投稿せず false（送信元を stderr に出して黙殺しない）', () => {
  const saved = process.exitCode;
  process.exitCode = 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-watchdog-test-'));
  const { mod, calls } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  const originalWrite = process.stderr.write;
  const errs = [];
  process.stderr.write = (s) => { errs.push(s); return true; };
  try {
    const posted = mod.notifyWatchdogExit({ workspace: dir, scriptName: 'poll-pr.js' });
    assert.equal(posted, false);
    assert.equal(calls.length, 0);
    assert.ok(errs.some(e => e.includes('送信先Issueがありません')), `stderr: ${errs.join('|')}`);
  } finally {
    process.exitCode = saved;
    process.stderr.write = originalWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 親セッション消滅（exit code 3）の専用通知（Issue #301） ──────────────

test('exit code 3（親セッション消滅）では専用本文で投稿する', () => {
  const saved = process.exitCode;
  process.exitCode = 3;
  const { mod, calls } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  try {
    const posted = mod.notifyWatchdogExit({ workspace: '/ws', scriptName: 'msg-poll.js', issue: '5' });
    assert.equal(posted, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].opts.input, /msg-poll\.js/);
    assert.match(calls[0].opts.input, /親セッションの消滅を検出して自動終了しました/);
    assert.doesNotMatch(calls[0].opts.input, /異常終了しました/);
  } finally {
    process.exitCode = saved;
  }
});

test('exit code 1 は従来どおり異常終了本文で投稿する', () => {
  const saved = process.exitCode;
  process.exitCode = 1;
  const { mod, calls } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  try {
    const posted = mod.notifyWatchdogExit({ workspace: '/ws', scriptName: 'poll-pr.js', issue: '5' });
    assert.equal(posted, true);
    assert.match(calls[0].opts.input, /⚠️ 監視プロセス poll-pr\.js が異常終了しました/);
    assert.doesNotMatch(calls[0].opts.input, /親セッションの消滅/);
  } finally {
    process.exitCode = saved;
  }
});

test('PARENT_DEATH_EXIT_CODE は 3 として export される', () => {
  const { mod } = loadHelper(() => ({ status: 0, stdout: '', stderr: '' }));
  assert.equal(mod.PARENT_DEATH_EXIT_CODE, 3);
});
