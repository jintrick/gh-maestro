'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const audit = require('../scripts/shared/resident-audit');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-audit-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

test('recordResidentAuditEvent: 1イベント1ファイルをworkspace runtimeへ同期記録する', () => {
  withTempDir(workspace => {
    const file = audit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'inbox-supervisor', detail: { ownerPid: 1 } });
    const event = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.type, 'lock-denied');
    assert.equal(event.role, 'inbox-supervisor');
    assert.equal(event.detail.ownerPid, 1);
    assert.ok(event.createdAt);

    // workspace runtime 配下に置かれる（GH_MAESTRO_RUNTIME_DIR = テスト隔離領域）
    const storageLayout = require('../scripts/shared/storage-layout');
    assert.ok(file.startsWith(path.join(storageLayout.workspaceRuntimeDir(workspace), 'resident-audit')));

    // 同一プロセス内で連続記録してもファイル名が衝突しない
    const file2 = audit.recordResidentAuditEvent({ workspace, type: 'handoff-wait', role: 'msgpoll-orchestrator', detail: { ownerPid: 2 } });
    assert.notEqual(file, file2);
    assert.equal(fs.existsSync(file2), true);
  });
});

test('recordResidentNotification: 本文と送信元を監査イベントへ記録する', () => {
  withTempDir(workspace => {
    const file = audit.recordResidentNotification({
      workspace,
      source: 'inbox-supervisor',
      issue: 42,
      body: '内部エラー\n詳細',
    });
    const event = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(event.type, 'notification');
    assert.equal(event.role, 'inbox-supervisor');
    assert.deepEqual(event.detail, { issue: '42', body: '内部エラー\n詳細' });
  });
});

test('recordResidentNotification: 本文が空なら記録しない', () => {
  withTempDir(workspace => {
    assert.throws(
      () => audit.recordResidentNotification({ workspace, source: 'inbox-supervisor', body: '' }),
      /通知本文が必要/
    );
    assert.deepEqual(audit.listUnprocessedResidentAuditEvents(workspace), []);
  });
});

test('recordResidentAuditEvent: 未知のイベント種別は fail closed で throw する', () => {
  withTempDir(workspace => {
    assert.throws(
      () => audit.recordResidentAuditEvent({ workspace, type: 'mystery', role: 'inbox-supervisor' }),
      /未知のイベント種別/
    );
  });
});

test('recordResidentAuditEvent: workspace がホームディレクトリに解決される場合は throw する（fail closed）', () => {
  // assertValidWorkspace が home 衝突を検知して throw する
  assert.throws(
    () => audit.recordResidentAuditEvent({ workspace: os.homedir(), type: 'lock-denied', role: 'inbox-supervisor' }),
    /assertValidWorkspace/
  );
});

test('listUnprocessedResidentAuditEvents: 生成順（ファイル名順）で一覧を返す', () => {
  withTempDir(workspace => {
    audit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'msgpoll-a', detail: {} });
    audit.recordResidentAuditEvent({ workspace, type: 'handoff-wait', role: 'msgpoll-b', detail: {} });
    const events = audit.listUnprocessedResidentAuditEvents(workspace);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.event.type), ['lock-denied', 'handoff-wait']);
  });
});

test('listUnprocessedResidentAuditEvents: ディレクトリが無ければ空を返す', () => {
  withTempDir(workspace => {
    assert.deepEqual(audit.listUnprocessedResidentAuditEvents(workspace), []);
  });
});

test('listUnprocessedResidentAuditEvents: 破損JSONは読み飛ばし、削除もしない', () => {
  withTempDir(workspace => {
    const dir = audit.auditDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt.json'), 'not json', 'utf8');
    audit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'msgpoll-c', detail: {} });
    const events = audit.listUnprocessedResidentAuditEvents(workspace);
    assert.equal(events.length, 1);
    assert.equal(events[0].event.role, 'msgpoll-c');
    assert.equal(fs.existsSync(path.join(dir, 'corrupt.json')), true);
  });
});

test('removeResidentAuditEvent: 監査ディレクトリ配下のみ削除でき、既に無ければ何もしない', () => {
  withTempDir(workspace => {
    const file = audit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'msgpoll-d', detail: {} });
    audit.removeResidentAuditEvent(workspace, file);
    assert.equal(fs.existsSync(file), false);

    // 二重削除してもエラーにならない
    audit.removeResidentAuditEvent(workspace, file);

    // 監査ディレクトリ外のファイルは削除を拒否する（path traversal 防止）
    const outside = path.join(path.dirname(audit.auditDir(workspace)), 'other.json');
    fs.writeFileSync(outside, '{}', 'utf8');
    assert.throws(
      () => audit.removeResidentAuditEvent(workspace, outside),
      /監査ディレクトリ外/
    );
    assert.equal(fs.existsSync(outside), true);
  });
});
