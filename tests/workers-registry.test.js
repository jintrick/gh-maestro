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

test('readWorkersRaw: 壊れたJSONはthrow（全リトライ後も解析不能）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '{not json', 'utf8');
    assert.throws(() => readWorkersRaw(dir), /workers\.json を解析できません/);
  });
});

test('readWorkersRaw: 配列は型不正でthrow（オブジェクトでない）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '[]', 'utf8');
    assert.throws(() => readWorkersRaw(dir), /workers\.json の形式が不正です/);
  });
});

test('readWorkersRaw: 正常なJSONを返す', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { orchestrator: { paneId: '1' } });
    assert.deepEqual(readWorkersRaw(dir), { orchestrator: { paneId: '1' } });
  });
});

test('readWorkersRaw: 書き込み中の破損JSONでもリトライ後に正常内容を読める（Issue #248 項目12）', () => {
  withTempDir((dir) => {
    const valid = JSON.stringify({ 'issue-1-coder': { pid: 1 } }, null, 2);
    // 最初の1回は書き込み途中の破損内容を返し、2回目以降は正常内容を返す
    // （readFileFn を注入するため実ファイルは書かない。ファイル不在の ENOENT は null に
    // 倒れるが、注入 readFileFn は実ファイルを読まないため本テストには無関係）。
    let calls = 0;
    const readFileFn = () => {
      calls++;
      return calls === 1 ? '{not json' : valid;
    };
    const result = readWorkersRaw(dir, { readFileFn, sleepFn: () => {}, maxAttempts: 5, delayMs: 0 });
    assert.deepEqual(result, { 'issue-1-coder': { pid: 1 } });
    assert.ok(calls >= 2, `should have retried, called ${calls} times`);
  });
});

test('readWorkersRaw: 全試行でparse失敗ならthrow（リトライ消費後に解析不能を伝える）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '{not json', 'utf8');
    let sleeps = 0;
    assert.throws(
      () => readWorkersRaw(dir, { sleepFn: () => { sleeps++; }, maxAttempts: 3, delayMs: 0 }),
      /workers\.json を解析できません/
    );
    assert.equal(sleeps, 2); // 3試行・間のスリープは2回
  });
});

test('readWorkersRaw: 読み取り時のENOENTのみnull（注入readFileFn）', () => {
  withTempDir((dir) => {
    const err = new Error('no such file');
    err.code = 'ENOENT';
    const readFileFn = () => { throw err; };
    assert.equal(readWorkersRaw(dir, { readFileFn }), null);
  });
});

test('readWorkersRaw: ENOENT以外の読み取りエラー（権限等）はthrow', () => {
  withTempDir((dir) => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    const readFileFn = () => { throw err; };
    assert.throws(() => readWorkersRaw(dir, { readFileFn }), /EACCES/);
  });
});

test('readWorkersRaw: JSONのnullリテラルは型不正でthrow', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), 'null', 'utf8');
    assert.throws(() => readWorkersRaw(dir), /workers\.json の形式が不正です/);
  });
});

test('updateWorkerProcess: 破損workers.jsonはthrow（falseはエントリ不在専用に保つ）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '{not json', 'utf8');
    // 破損を false に潰すと呼び出し側（worker-supervisor）が「エントリ不在」と誤報告するため、
    // 破損は例外として伝播させる（Issue #275 項目1）。false はエントリ不在の専用に残す。
    assert.throws(() => updateWorkerProcess(dir, 'issue-5-fix', { pid: 999 }), /workers\.json を解析できません/);
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

test('updateWorkerProcess: ホワイトリスト外の未知フィールドは書き戻し後も保持する（Issue #278）', () => {
  withTempDir((dir) => {
    // baseBranch 導入時に起こった「新フィールドが resume 書き戻しで黙って消える」事故の回帰テスト。
    // normalizeWorkerEntry のホワイトリストに載っていないフィールド（将来追加されるフィールドを
    // 模す someFutureField / ネストした nested）が書き戻し後も残ることを固定する。
    // 書き戻しをホワイトリスト再構築（normalizeWorkerEntry 単独）に戻すと本テストは落ちる。
    writeWorkers(dir, {
      'issue-5-fix': {
        pid: 100, startTime: 'old', agentId: 'agy', issue: 5, skill: 'gh-maestro-coder',
        someFutureField: 'keep-me',
        nested: { a: 1 },
      },
    });

    const ok = updateWorkerProcess(dir, 'issue-5-fix', {
      pid: 999, startTime: '2026-07-25T00:00:00.000Z', logPath: 'C:/ws/w.log',
    });
    assert.equal(ok, true);

    const raw = readWorkersRaw(dir);
    // 未知フィールドが保持される
    assert.equal(raw['issue-5-fix'].someFutureField, 'keep-me');
    assert.deepEqual(raw['issue-5-fix'].nested, { a: 1 });
    // 既知フィールドは従来どおり更新・保持される
    assert.equal(raw['issue-5-fix'].pid, 999);
    assert.equal(raw['issue-5-fix'].startTime, '2026-07-25T00:00:00.000Z');
    assert.equal(raw['issue-5-fix'].logPath, 'C:/ws/w.log');
    assert.equal(raw['issue-5-fix'].agentId, 'agy');
    assert.equal(raw['issue-5-fix'].issue, 5);
    assert.equal(raw['issue-5-fix'].skill, 'gh-maestro-coder');
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
      'issue-42-investigate': { pid: 10, agentId: 'reasonix', issue: 42, skill: 'gh-maestro-diagnostician' },
      'issue-42-implement': { pid: 11, agentId: 'claude-ds', issue: 42, skill: 'gh-maestro-coder' },
    });
    assert.equal(resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-coder' }), 'issue-42-implement');
    assert.equal(resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-diagnostician' }), 'issue-42-investigate');
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

test('resolveWorkerName: workers.jsonが無ければ「読み込めません」エラー（不在のみ）', () => {
  withTempDir((dir) => {
    assert.throws(
      () => resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-coder' }),
      (err) => {
        assert.match(err.message, /読み込めません/);
        // 不在は破損ではない。破損固有のメッセージ（解析できません）と取り違えてはならない
        // （Issue #275 項目1）。
        assert.doesNotMatch(err.message, /解析できません/);
        return true;
      }
    );
  });
});

test('resolveWorkerName: 破損workers.jsonは「解析できません」エラー（不在と区別）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '{not json', 'utf8');
    assert.throws(
      () => resolveWorkerName(dir, { issue: 42, skill: 'gh-maestro-coder' }),
      (err) => {
        // readWorkersRaw の契約どおり破損は throw を伝播させる。不在専用の「読み込めません」に
        // 潰すと「まだ1件も起動していない正常な空状態」と「ファイルが壊れている」を区別できない
        // （Issue #275 項目1）。
        assert.match(err.message, /解析できません/);
        assert.doesNotMatch(err.message, /読み込めません/);
        return true;
      }
    );
  });
});

test('resolveWorkerName: issue/skill 欠落はエラー', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-42-implement': { paneId: '11', issue: 42, skill: 'gh-maestro-coder' } });
    assert.throws(() => resolveWorkerName(dir, { skill: 'gh-maestro-coder' }), /issue が必要です/);
    assert.throws(() => resolveWorkerName(dir, { issue: 42 }), /skill が必要です/);
  });
});
