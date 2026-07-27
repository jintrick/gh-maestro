'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  workersJsonPath,
  readWorkersRaw,
  updateWorkerProcess,
  resolveWorkerName,
} = require('../scripts/shared/workers-registry');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeWorkers(dir, workers) {
  fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(workersJsonPath(dir), JSON.stringify(workers, null, 2), 'utf8');
}

test('readWorkersRaw: ファイルが無ければnull', () => {
  withTempDir((dir) => {
    assert.equal(readWorkersRaw(dir), null);
  });
});

test('readWorkersRaw: 壊れたJSONはnull', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '{not json', 'utf8');
    assert.equal(readWorkersRaw(dir), null);
  });
});

test('readWorkersRaw: 配列はnull（オブジェクトでない）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '[]', 'utf8');
    assert.equal(readWorkersRaw(dir), null);
  });
});

test('readWorkersRaw: 正常なJSONを返す', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { orchestrator: { paneId: '1' } });
    assert.deepEqual(readWorkersRaw(dir), { orchestrator: { paneId: '1' } });
  });
});

test('updateWorkerProcess: 既存エントリのpid/startTime/logPathを更新する', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      orchestrator: { agentId: null },
      'issue-5-fix': { pid: 100, startTime: 'old', agentId: 'agy', issue: 5, skill: 'gh-maestro-coder' },
    });

    const ok = updateWorkerProcess(dir, 'issue-5-fix', {
      pid: 999, startTime: '2026-07-25T00:00:00.000Z', logPath: 'C:/ws/w.log',
    });
    assert.equal(ok, true);

    const raw = readWorkersRaw(dir);
    assert.equal(raw['issue-5-fix'].pid, 999);
    assert.equal(raw['issue-5-fix'].startTime, '2026-07-25T00:00:00.000Z');
    assert.equal(raw['issue-5-fix'].logPath, 'C:/ws/w.log');
    // 役割・エージェント情報は保たれる
    assert.equal(raw['issue-5-fix'].agentId, 'agy');
    assert.equal(raw['issue-5-fix'].issue, 5);
    assert.equal(raw['issue-5-fix'].skill, 'gh-maestro-coder');
    // 他エントリは変化しない
    assert.deepEqual(raw.orchestrator, { agentId: null });
  });
});

test('updateWorkerProcess: 文字列pidも数値化して保存する', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { pid: 100, agentId: 'agy', issue: 5 } });
    updateWorkerProcess(dir, 'issue-5-fix', { pid: '999', startTime: null, logPath: null });
    const raw = readWorkersRaw(dir);
    assert.equal(raw['issue-5-fix'].pid, 999);
    assert.equal(typeof raw['issue-5-fix'].pid, 'number');
  });
});

test('updateWorkerProcess: logPath 省略時は既存の値を維持する', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { pid: 100, logPath: 'C:/ws/keep.log', agentId: 'agy' } });
    updateWorkerProcess(dir, 'issue-5-fix', { pid: 999, startTime: 'x' });
    assert.equal(readWorkersRaw(dir)['issue-5-fix'].logPath, 'C:/ws/keep.log');
  });
});

test('updateWorkerProcess: レガシーpaneIdは消す（新プロセスが起きた以上、古いペインIDは誤ったkill対象になる）', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { paneId: '10', agentId: 'agy', issue: 5 } });
    updateWorkerProcess(dir, 'issue-5-fix', { pid: 999, startTime: 'x', logPath: 'C:/ws/w.log' });
    assert.equal(readWorkersRaw(dir)['issue-5-fix'].paneId, null);
  });
});

test('updateWorkerProcess: 存在しないworkerNameはfalseを返し何も書き換えない', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { pid: 100 } });
    const ok = updateWorkerProcess(dir, 'issue-999-nope', { pid: 999 });
    assert.equal(ok, false);
    // 書き込みが行われていないため、raw のファイル内容がそのまま残っている
    assert.deepEqual(readWorkersRaw(dir)['issue-5-fix'], { pid: 100 });
  });
});

test('updateWorkerProcess: workers.jsonが無い場合はfalse', () => {
  withTempDir((dir) => {
    assert.equal(updateWorkerProcess(dir, 'issue-5-fix', { pid: 999 }), false);
  });
});

// ── resolveWorkerName（〈issue + skill〉からの逆引き） ────────────────────────

test('resolveWorkerName: issue+skill が一意に決まれば workerName を返す', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      orchestrator: { agentId: null },
      'issue-42-investigate': { pid: 10, agentId: 'reasonix', issue: 42, skill: 'gh-maestro-investigator' },
      'issue-42-implement': { pid: 11, agentId: 'claude-ds', issue: 42, skill: 'gh-maestro-coder' },
    });
    assert.equal(resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-coder' }), 'issue-42-implement');
    assert.equal(resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-investigator' }), 'issue-42-investigate');
  });
});

test('resolveWorkerName: issue が文字列で渡されても数値比較で解決する', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      'issue-42-implement': { paneId: '11', agentId: 'claude-ds', issue: 42, skill: 'gh-maestro-coder' },
    });
    assert.equal(resolveWorkerName(dir, { issue: '42', skill: 'gh-maestro-coder' }), 'issue-42-implement');
  });
});

test('resolveWorkerName: 該当0件はエラー', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      'issue-42-implement': { paneId: '11', agentId: 'claude-ds', issue: 42, skill: 'gh-maestro-coder' },
    });
    assert.throws(
      () => resolveWorkerName(dir, { issue: 99, skill: 'gh-maestro-coder' }),
      /該当するワーカーが見つかりません/
    );
  });
});

test('resolveWorkerName: 同一issue+同一skillで複数該当なら候補付きでエラー', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      'issue-12-fix-components': { paneId: '10', agentId: 'claude-ds', issue: 12, skill: 'gh-maestro-coder' },
      'issue-12-fix-utils': { paneId: '11', agentId: 'claude-ds', issue: 12, skill: 'gh-maestro-coder' },
    });
    assert.throws(
      () => resolveWorkerName(dir, { issue: 12, skill: 'gh-maestro-coder' }),
      /複数のワーカーが該当.*issue-12-fix-components.*issue-12-fix-utils|複数のワーカーが該当.*issue-12-fix-utils.*issue-12-fix-components/
    );
  });
});

test('resolveWorkerName: orchestratorエントリは対象外', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      orchestrator: { paneId: '1', issue: 42, skill: 'gh-maestro-coder' },
      'issue-42-implement': { paneId: '11', agentId: 'claude-ds', issue: 42, skill: 'gh-maestro-coder' },
    });
    // orchestrator が偶然同じ issue/skill を持っていても解決対象に含めない
    assert.equal(resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-coder' }), 'issue-42-implement');
  });
});

test('resolveWorkerName: workers.jsonが無ければエラー', () => {
  withTempDir((dir) => {
    assert.throws(() => resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-coder' }), /読み込めません/);
  });
});

test('resolveWorkerName: issue/skill 欠落はエラー', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-42-implement': { paneId: '11', issue: 42, skill: 'gh-maestro-coder' } });
    assert.throws(() => resolveWorkerName(dir, { skill: 'gh-maestro-coder' }), /issue が必要です/);
    assert.throws(() => resolveWorkerName(dir, { issue: 42 }), /skill が必要です/);
  });
});
