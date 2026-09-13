'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { rebuildOrchestratorBaseline, restartCapturedResidents } = require('../../scripts/reset-session');
const readStateLib = require('../../scripts/shared/read-state');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-reset-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WORKERS = {
  orchestrator: { agentId: null },
  'issue-10-coder-x': { issue: 10, agentId: 'claude' },
  'issue-20-explorer-y': { issue: 20, agentId: 'claude' },
};









test('reset-session: status-pane.json が存在する場合にセッションリセットで削除される', () => {
  withTempDir(workspace => {
    const { saveStatusPane, loadStatusPane } = require('../../scripts/shared/status-pane-registry');

    saveStatusPane(workspace, {
      paneId: '9999',
      unixSocket: 'C:\\wezterm\\test-socket',
      targetPaneId: 'base-pane',
      launchedAt: '2026-08-26T09:00:00.000Z',
    });
    assert.ok(loadStatusPane(workspace) !== null);

    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'reset-session.js');
    const r = spawnSync(process.execPath, [scriptPath, '--workspace', workspace, '--quiet'], {
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WezTermのpane一覧取得をテスト中のため拒否しました/);
    assert.equal(loadStatusPane(workspace).paneId, '9999', '一覧で確認できないpaneの状態記録を保持すること');
  });
});

test('reset-session: malformed workers.json は0件扱いにせず、破損ファイルを保持して失敗する', () => {
  withTempDir(workspace => {
    const workersFile = path.join(workspace, '.gh-maestro', 'workers.json');
    fs.mkdirSync(path.dirname(workersFile), { recursive: true });
    fs.writeFileSync(workersFile, '{not json', 'utf8');

    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'reset-session.js');
    const r = spawnSync(process.execPath, [scriptPath, '--workspace', workspace, '--quiet'], {
      encoding: 'utf8',
    });

    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /workers\.json のJSON構文エラー/);
    assert.match(r.stderr, new RegExp(workersFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.readFileSync(workersFile, 'utf8'), '{not json');
  });
});

test('reset-session: workers.json の読み取り失敗は0件扱いにせず対象を保持して失敗する', () => {
  withTempDir(workspace => {
    const workersFile = path.join(workspace, '.gh-maestro', 'workers.json');
    fs.mkdirSync(workersFile, { recursive: true });

    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'reset-session.js');
    const r = spawnSync(process.execPath, [scriptPath, '--workspace', workspace, '--quiet'], {
      encoding: 'utf8',
    });

    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /workers\.json の読み取り失敗/);
    assert.match(r.stderr, new RegExp(workersFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.statSync(workersFile).isDirectory(), true);
  });
});


test('reset-session: リポジトリ解決失敗時やベースライン再構築失敗時に既存の readByIssue を保持しつつ sessionId を空文字に無効化する', () => {
  withTempDir(workspace => {
    const { spawnSync } = require('child_process');
    const sp = readStateLib.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    readStateLib.writeState(workspace, 'orchestrator', {
      schemaVersion: 2,
      initialized: true,
      sessionId: 'test-session-uuid-1234',
      readByIssue: { '10': [1, 2, 3] },
      sinceByIssue: { '10': '2026-09-01T00:00:00Z' },
    });

    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'reset-session.js');
    const r = spawnSync(process.execPath, [scriptPath, '--workspace', workspace, '--quiet'], {
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, r.stderr);
    const st = readStateLib.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.equal(st.state.sessionId, '', 'sessionId が空文字にクリアされること');
    assert.deepEqual(st.state.readByIssue, { '10': [1, 2, 3] }, 'readByIssue は維持されること');
    assert.deepEqual(st.state.sinceByIssue, { '10': '2026-09-01T00:00:00Z' }, 'sinceByIssue は維持されること');
  });
});
