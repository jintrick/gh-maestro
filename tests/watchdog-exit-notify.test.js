'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const helper = require('../scripts/shared/watchdog-exit-notify');
const residentAudit = require('../scripts/shared/resident-audit');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-watchdog-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withExitCode(code, fn) {
  const saved = process.exitCode;
  process.exitCode = code;
  try {
    return fn();
  } finally {
    process.exitCode = saved;
  }
}

function captureStdout(fn) {
  const original = process.stdout.write;
  const lines = [];
  process.stdout.write = (value) => { lines.push(String(value)); return true; };
  try {
    return { result: fn(), output: lines.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('正常終了（exitCode 0）では何も通知しない', () => {
  withExitCode(0, () => withTempDir(workspace => {
    assert.equal(helper.notifyWatchdogExit({ workspace, scriptName: 'poll-pr.js', issue: '5' }), false);
    assert.deepEqual(residentAudit.listUnprocessedResidentAuditEvents(workspace), []);
  }));
});

test('poll-pr.js の異常終了はIssueコメントではなく監査イベントへ記録する', () => {
  withExitCode(7, () => withTempDir(workspace => {
    const posted = helper.notifyWatchdogExit({ workspace, scriptName: 'poll-pr.js', issue: '5' });
    assert.equal(posted, true);
    const events = residentAudit.listUnprocessedResidentAuditEvents(workspace);
    assert.equal(events.length, 1);
    assert.equal(events[0].event.type, 'notification');
    assert.equal(events[0].event.role, 'poll-pr.js');
    assert.equal(events[0].event.detail.issue, '5');
    assert.match(events[0].event.detail.body, /exit code 7/);
  }));
});

test('msg-poll.js 自身の異常終了はstdoutへ直接通知する', () => {
  withExitCode(1, () => withTempDir(workspace => {
    const captured = captureStdout(() => helper.notifyWatchdogExit({
      workspace, scriptName: 'msg-poll.js', isOrchestrator: true,
    }));
    assert.equal(captured.result, true);
    assert.match(captured.output, /^RESIDENT_NOTIFICATION:/);
    assert.match(captured.output, /msg-poll\.js/);
    assert.match(captured.output, /exit code 1/);
    assert.deepEqual(residentAudit.listUnprocessedResidentAuditEvents(workspace), []);
  }));
});

test('workerモードのmsg-poll異常終了は監査イベントへ記録する', () => {
  withExitCode(1, () => withTempDir(workspace => {
    assert.equal(helper.notifyWatchdogExit({ workspace, scriptName: 'msg-poll.js', issue: '5' }), true);
    const events = residentAudit.listUnprocessedResidentAuditEvents(workspace);
    assert.equal(events.length, 1);
    assert.equal(events[0].event.role, 'msg-poll.js');
    assert.match(events[0].event.detail.body, /exit code 1/);
  }));
});

test('issue 未指定なら workers.json の先頭ワーカーのIssueを監査イベントに保持する', () => {
  withExitCode(1, () => withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify({ w1: { issue: 42 } }), 'utf8');
    assert.equal(helper.notifyWatchdogExit({ workspace, scriptName: 'poll-reviews.js' }), true);
    const events = residentAudit.listUnprocessedResidentAuditEvents(workspace);
    assert.equal(events[0].event.detail.issue, '42');
  }));
});

test('送信先Issueが無い場合は通知せずstderrへ理由を出す', () => {
  withExitCode(1, () => withTempDir(workspace => {
    const originalWrite = process.stderr.write;
    const errors = [];
    process.stderr.write = (value) => { errors.push(String(value)); return true; };
    try {
      assert.equal(helper.notifyWatchdogExit({ workspace, scriptName: 'poll-pr.js' }), false);
      assert.ok(errors.some(line => line.includes('送信先Issueがありません')));
      assert.deepEqual(residentAudit.listUnprocessedResidentAuditEvents(workspace), []);
    } finally {
      process.stderr.write = originalWrite;
    }
  }));
});

test('exit code 3（親セッション消滅）はmsg-poll stdout通知に専用本文を使う', () => {
  withExitCode(3, () => withTempDir(workspace => {
    const captured = captureStdout(() => helper.notifyWatchdogExit({
      workspace, scriptName: 'msg-poll.js', isOrchestrator: true,
    }));
    assert.equal(captured.result, true);
    assert.match(captured.output, /親セッションの消滅を検出して自動終了しました/);
    assert.doesNotMatch(captured.output, /異常終了しました/);
  }));
});

test('PARENT_DEATH_EXIT_CODE は3としてexportされる', () => {
  assert.equal(helper.PARENT_DEATH_EXIT_CODE, 3);
});
