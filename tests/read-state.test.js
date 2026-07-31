'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rs = require('../scripts/shared/read-state');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-read-state-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRaw(workspace, self, obj) {
  const sp = rs.statePath(workspace, self);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(obj, null, 2), 'utf8');
}

// ── readState の status 判定 ────────────────────────────────────────────────

test('readState: ファイルが無ければ missing', () => {
  withTempDir(workspace => {
    const r = rs.readState(workspace, 'orchestrator');
    assert.equal(r.status, 'missing');
    assert.equal(r.state, null);
  });
});

test('readState: 破損JSONは corrupt', () => {
  withTempDir(workspace => {
    const sp = rs.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, 'not json{{{', 'utf8');
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');
  });
});

test('readState: 非オブジェクト（配列・null）は corrupt', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'orchestrator', [1, 2, 3]);
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');
    writeRaw(workspace, 'orchestrator', null);
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');
  });
});

test('readState: initialized 無しの不明オブジェクトは corrupt（暗黙の空状態扱いをしない）', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'orchestrator', {});
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');
  });
});

test('readState: v1（since/seenIds）は legacy で生パースを返す（呼び出し元が seenIds を引き継げる）', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'orchestrator', { since: { 10: '2026-07-07T00:00:00Z' }, seenIds: [1, 2] });
    const r = rs.readState(workspace, 'orchestrator');
    assert.equal(r.status, 'legacy');
    assert.deepEqual(r.state.seenIds, [1, 2]);
    assert.deepEqual(r.state.since, { 10: '2026-07-07T00:00:00Z' });
  });
});

test('readState: v1（文字列since）も legacy で生パースを返す', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'my-worker', { since: '2026-07-07T00:00:00Z', seenIds: [1] });
    const r = rs.readState(workspace, 'my-worker');
    assert.equal(r.status, 'legacy');
    assert.deepEqual(r.state.seenIds, [1]);
  });
});

test('readState: v2 正常は ok で正規化状態を返す', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'orchestrator', {
      schemaVersion: 2,
      initialized: true,
      generation: 'reset-123',
      readByIssue: { 10: [1, 2, 3] },
      sinceByIssue: { 10: '2026-07-07T00:00:00Z' },
    });
    const r = rs.readState(workspace, 'orchestrator');
    assert.equal(r.status, 'ok');
    assert.equal(r.state.generation, 'reset-123');
    assert.deepEqual(r.state.readByIssue['10'], [1, 2, 3]);
    assert.equal(r.state.sinceByIssue['10'], '2026-07-07T00:00:00Z');
  });
});

test('readState: v2 の readByIssue が破損（非数値ID混入・配列でない値）は corrupt', () => {
  withTempDir(workspace => {
    // 非数値ID混入
    writeRaw(workspace, 'orchestrator', {
      schemaVersion: 2, initialized: true, generation: 'g',
      readByIssue: { 10: [1, 'not-a-number'] },
    });
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');

    // 配列でない値
    writeRaw(workspace, 'orchestrator', {
      schemaVersion: 2, initialized: true, generation: 'g',
      readByIssue: { 10: 'not-an-array' },
    });
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');
  });
});

test('readState: v2 の readByIssue 欠落・非オブジェクトは corrupt（空集合へ黙って正規化しない）', () => {
  withTempDir(workspace => {
    // readByIssue 欠落
    writeRaw(workspace, 'orchestrator', { schemaVersion: 2, initialized: true, generation: 'g' });
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');

    // readByIssue が配列
    writeRaw(workspace, 'orchestrator', {
      schemaVersion: 2, initialized: true, generation: 'g', readByIssue: [1, 2],
    });
    assert.equal(rs.readState(workspace, 'orchestrator').status, 'corrupt');
  });
});

test('readState: v2 正常は ok。sinceByIssue は寛容に正規化される', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'orchestrator', {
      schemaVersion: 2,
      initialized: true,
      generation: 'g',
      readByIssue: { 10: [1, 2, 3] },
      sinceByIssue: { 10: '2026-07-07T00:00:00Z', 11: 12345 }, // 非stringは無視
    });
    const r = rs.readState(workspace, 'orchestrator');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.state.readByIssue['10'], [1, 2, 3]);
    assert.deepEqual(r.state.sinceByIssue, { 10: '2026-07-07T00:00:00Z' });
  });
});

// ── writeState ──────────────────────────────────────────────────────────────

test('writeState → readState ラウンドトリップ（切り捨て無し）', () => {
  withTempDir(workspace => {
    const many = Array.from({ length: 500 }, (_, i) => i + 1);
    const state = rs.emptyState('g');
    state.readByIssue['10'] = many;
    rs.writeState(workspace, 'orchestrator', state);

    const r = rs.readState(workspace, 'orchestrator');
    assert.equal(r.status, 'ok');
    assert.equal(r.state.readByIssue['10'].length, 500, '既読IDは切り捨てない（正本として保持）');
    assert.deepEqual(r.state.readByIssue['10'], many);
  });
});

test('writeState は tmp 書き込み + rename でアトミックに書く（残留ファイルなし）', () => {
  withTempDir(workspace => {
    rs.writeState(workspace, 'orchestrator', rs.emptyState('g'));
    const dir = path.dirname(rs.statePath(workspace, 'orchestrator'));
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'orchestrator.json');
  });
});

// ── markRead ────────────────────────────────────────────────────────────────

test('markRead: 既読IDを追加し冪等（同じIDの再追加は無害）', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { byIssue: { 10: [1, 2] }, generation: 'g' });

    const r1 = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [2, 3] });
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.state.readByIssue['10'], [1, 2, 3]);

    const r2 = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [3, 4] });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.state.readByIssue['10'], [1, 2, 3, 4]);
  });
});

test('markRead: 未初期化（missing）状態では失敗し空状態を作らない', () => {
  withTempDir(workspace => {
    const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [1] });
    assert.equal(r.ok, false);
    assert.match(r.error, /初期化/);
    assert.equal(fs.existsSync(rs.statePath(workspace, 'orchestrator')), false, '空状態を暗黙生成しない');
  });
});

test('markRead: v1（legacy）状態では失敗する（移行が必要）', () => {
  withTempDir(workspace => {
    writeRaw(workspace, 'orchestrator', { since: { 10: 'x' }, seenIds: [1] });
    const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [2] });
    assert.equal(r.ok, false);
  });
});

test('markReadMany: 複数Issueを一度の更新で追加し sinceByIssue も診断更新できる', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { byIssue: { 10: [1] }, generation: 'g' });
    const r = rs.markReadMany(workspace, 'orchestrator', {
      byIssue: { 10: [2], 20: [100] },
      sinceByIssue: { 10: '2026-07-07T00:00:00Z' },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.readByIssue['10'], [1, 2]);
    assert.deepEqual(r.state.readByIssue['20'], [100]);
    assert.equal(r.state.sinceByIssue['10'], '2026-07-07T00:00:00Z');
  });
});

test('markRead: since（取得最適化カーソル）を設定できる', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { generation: 'g' });
    const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [1], since: '2026-07-07T12:00:00Z' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.readByIssue['10'], [1]);
    assert.equal(r.state.sinceByIssue['10'], '2026-07-07T12:00:00Z');
  });
});

test('markRead: 変更が無い場合（空ID・既読済みのみ）は書き込み不要で成功', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { byIssue: { 10: [1] }, generation: 'g' });
    const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [1] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.readByIssue['10'], [1]);
  });
});

// ── ロック ──────────────────────────────────────────────────────────────────

test('ロック競合: 生存中保持者がいると markRead は失敗する', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { generation: 'g' });
    // テストプロセス自身がロックを保持した状態にする
    assert.equal(rs.acquireStateLock(workspace, 'orchestrator'), true);
    try {
      const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [1] });
      assert.equal(r.ok, false);
      assert.match(r.error, /ロック/);
      // 既読は追加されていない
      const after = rs.readState(workspace, 'orchestrator');
      assert.deepEqual(after.state.readByIssue['10'] || [], []);
    } finally {
      rs.releaseStateLock(workspace, 'orchestrator');
    }
  });
});

test('stale ロック（保持者死亡）は奪取して更新できる', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { generation: 'g' });
    const lp = rs.stateLockPath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    // 確実に死亡しているPID（999999）でロックを残す
    fs.writeFileSync(lp, JSON.stringify({ pid: 999999, startTime: '2020-01-01T00:00:00Z' }), 'utf8');
    const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [1] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.readByIssue['10'], [1]);
  });
});

test('破損ロック（JSONでない）は stale とみなし奪取して更新できる', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { generation: 'g' });
    const lp = rs.stateLockPath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, 'not-json', 'utf8');
    const r = rs.markRead(workspace, 'orchestrator', { issue: 10, ids: [1] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.readByIssue['10'], [1]);
  });
});

// ── initializeState ─────────────────────────────────────────────────────────

test('initializeState: generation・readByIssue 付きで初期化される', () => {
  withTempDir(workspace => {
    const r = rs.initializeState(workspace, 'orchestrator', {
      byIssue: { 10: [1, 2], 20: [3] },
      generation: 'reset-abc',
    });
    assert.equal(r.ok, true);
    assert.equal(r.state.initialized, true);
    assert.equal(r.state.generation, 'reset-abc');
    assert.deepEqual(r.state.readByIssue['10'], [1, 2]);
  });
});

test('initializeState: byIssue が空でも initialized=true（空状態で再開しない）', () => {
  withTempDir(workspace => {
    const r = rs.initializeState(workspace, 'orchestrator', { generation: 'reset-empty' });
    assert.equal(r.ok, true);
    assert.equal(r.state.initialized, true);
    assert.deepEqual(r.state.readByIssue, {});
    const after = rs.readState(workspace, 'orchestrator');
    assert.equal(after.status, 'ok');
  });
});

test('initializeState: sinceByIssue（取得最適化カーソル）付きで初期化される', () => {
  withTempDir(workspace => {
    const r = rs.initializeState(workspace, 'orchestrator', {
      byIssue: { 10: [1] },
      sinceByIssue: { 10: '2026-07-07T12:00:00Z', 20: 12345 }, // 非stringは無視
      generation: 'reset-abc',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.sinceByIssue, { 10: '2026-07-07T12:00:00Z' });
  });
});

// ── requireInitialized ───────────────────────────────────────────────────────

test('requireInitialized: v2 正常時は状態を返す', () => {
  withTempDir(workspace => {
    rs.initializeState(workspace, 'orchestrator', { generation: 'g' });
    const r = rs.requireInitialized(workspace, 'orchestrator');
    assert.equal(r.ok, true);
    assert.equal(r.state.initialized, true);
  });
});

test('requireInitialized: missing / corrupt / legacy は失敗', () => {
  withTempDir(workspace => {
    assert.equal(rs.requireInitialized(workspace, 'orchestrator').ok, false);
    writeRaw(workspace, 'orchestrator', { since: { 10: 'x' }, seenIds: [] });
    assert.equal(rs.requireInitialized(workspace, 'orchestrator').ok, false);
    writeRaw(workspace, 'orchestrator', 'broken{{{');
    assert.equal(rs.requireInitialized(workspace, 'orchestrator').ok, false);
  });
});
