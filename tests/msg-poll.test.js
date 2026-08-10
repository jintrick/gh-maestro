'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgPoll = require('../scripts/msg-poll');
const readStateLib = require('../scripts/shared/read-state');
const { cleanSpawnEnv } = require('./_spawn-env');

// テスト高速化: main() は --session-pid 未指定だと resolveSessionPid が親プロセスツリーを
// 辿る（Windowsでは1回あたり ~2.3秒のPowerShell起動を伴う）。実運用では起動元が必ず
// --session-pid を渡すため、テストでも常に自プロセスPIDを渡してこの探索を省く。
const _realMain = msgPoll.main;
const TEST_SESSION_PID = String(process.pid);

// ワーカー起動コンテキストでは GH_MAESTRO_WORKSPACE が注入され、resolveWorkspace が
// env を優先して --workspace 引数を無視する（実ワークスペースの状態を破壊しうる）。
// テストは必ず --workspace で渡した一時ディレクトリを使うため、main() の間だけ env を外す。
const runMain = (args, opts) => {
  const saved = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return _realMain([...args, '--session-pid', TEST_SESSION_PID], opts);
  } finally {
    if (saved !== undefined) process.env.GH_MAESTRO_WORKSPACE = saved;
  }
};

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
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

// orchestrator の msg-state を v2 initialized 状態に初期化する。
function initOrchestratorState(workspace, { byIssue = {}, generation = 'test-gen' } = {}) {
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const result = readStateLib.initializeState(workspace, 'orchestrator', { byIssue, generation });
  assert.equal(result.ok, true, `orchestrator state 初期化に失敗: ${result.error}`);
}

// workers.json を temp workspace に作る。
function writeWorkers(workspace, workers) {
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify(workers, null, 2), 'utf8');
}

// ── parseArgs（main() と CLI プリフライトが共有する解析ヘルパー） ───────────

test('parseArgs: --help は help:true を返す', () => {
  const r = msgPoll.parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('parseArgs: 値欠落は exitFlagMiss:true を返す', () => {
  const r = msgPoll.parseArgs(['orchestrator', '--workspace']);
  assert.equal(r.exitFlagMiss, true);
});

test('parseArgs: self/onceMode/force/workspaceArg を正しく分離する', () => {
  const r = msgPoll.parseArgs(['my-worker', '--issue', '5', '--workspace', '/ws', '--once', '--force']);
  assert.equal(r.self, 'my-worker');
  assert.equal(r.issueArg, '5');
  assert.equal(r.workspaceArg, '/ws');
  assert.equal(r.onceMode, true);
  assert.equal(r.force, true);
});

test('parseArgs: --once/--force が無ければ false', () => {
  const r = msgPoll.parseArgs(['orchestrator', '--workspace', '/ws']);
  assert.equal(r.onceMode, false);
  assert.equal(r.force, false);
});

test('parseArgs: --wait <sec> を waitArg として返す', () => {
  const r = msgPoll.parseArgs(['my-worker', '--issue', '5', '--workspace', '/ws', '--wait', '10']);
  assert.equal(r.waitArg, '10');
  assert.equal(r.onceMode, false);
});

test('parseArgs: --wait が無ければ waitArg は null', () => {
  const r = msgPoll.parseArgs(['orchestrator', '--workspace', '/ws']);
  assert.equal(r.waitArg, null);
});

test('parseArgs: 余剰な位置引数は unknownArgs を返す', () => {
  const r = msgPoll.parseArgs(['my-worker', '--issue', '5', 'extra']);
  assert.deepEqual(r.unknownArgs, ['extra']);
});

test('parseArgs: 未知のフラグは unknownArgs に含まれる', () => {
  const r = msgPoll.parseArgs(['my-worker', '--issue', '5', '--bogus']);
  assert.deepEqual(r.unknownArgs, ['--bogus']);
});

test('parseArgs: 先頭の未知フラグは self として採用されず unknownArgs に含まれる', () => {
  const r = msgPoll.parseArgs(['--bogus', '--issue', '5', '--once']);
  assert.deepEqual(r.unknownArgs, ['--bogus']);
  assert.equal(r.self, undefined);
});

test('parseArgs: 正常系は unknownArgs が null', () => {
  const r = msgPoll.parseArgs(['my-worker', '--issue', '5', '--workspace', '/ws', '--once', '--force']);
  assert.equal(r.unknownArgs, null);
});

// ── --help / -h ────────────────────────────────────────────────────────────

test('--help が usage を返して code 0', () => {
  const r = runMain(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-poll.js'));
  assert.equal(r.errLines.length, 0);
  assert.equal(r.scanOnce, null);
});

test('-h が usage を返して code 0', () => {
  const r = runMain(['-h']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-poll.js'));
  assert.equal(r.errLines.length, 0);
  assert.equal(r.scanOnce, null);
});

// ── 引数エラー ──────────────────────────────────────────────────────────────

test('self なしは code 1', () => {
  const r = runMain([]);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.join('\n').includes('msg-poll.js'));
  assert.equal(r.scanOnce, null);
});

test('worker モードで --issue なしは code 1', () => {
  const r = runMain(['my-worker']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--issue')));
  assert.equal(r.scanOnce, null);
});

test('余剰な位置引数は code 1（黙って無視しない）', () => {
  const r = runMain(['my-worker', '--issue', '5', 'extra']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('未知の引数')));
  assert.equal(r.scanOnce, null);
});

test('先頭の未知フラグは self として受理されず code 1（gh呼び出し等の副作用に到達しない）', () => {
  withTempDir(workspace => {
    let repoViewCalls = 0;
    msgPoll._setGhRepoView(() => { repoViewCalls++; return { status: 0, stdout: 'test/repo\n' }; });

    const r = runMain(['--bogus', '--issue', '5', '--once', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('未知の引数')));
    assert.equal(r.scanOnce, null);
    assert.equal(repoViewCalls, 0, 'gh repo view は呼ばれない');
  });
});

// ── path-safety 検証 ───────────────────────────────────────────────────────

test('.. を含む self は code 1', () => {
  withTempDir(workspace => {
    const r = runMain(['../orchestrator', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('親ディレクトリ参照')));
    assert.equal(r.scanOnce, null);
  });
});

test('パス区切り文字を含む self は code 1', () => {
  withTempDir(workspace => {
    const r = runMain(['a/b', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('不正な文字')));
    assert.equal(r.scanOnce, null);
  });
});

// ── マーカー解析 ────────────────────────────────────────────────────────────

test('parseMarker が正しいマーカーをパースする', () => {
  const meta = msgPoll.parseMarker('<!-- gh-maestro {"v":1,"to":"worker-1","from":"orchestrator"} -->\nhello world');
  assert.deepEqual(meta, { v: 1, to: 'worker-1', from: 'orchestrator' });
});

test('parseMarker が空白を含むマーカーをパースする', () => {
  const meta = msgPoll.parseMarker('<!--  gh-maestro  {"v":1,"to":"worker-1","from":"orchestrator"}  -->\nbody');
  assert.deepEqual(meta, { v: 1, to: 'worker-1', from: 'orchestrator' });
});

test('parseMarker がマーカーなしの通常コメントに null を返す', () => {
  assert.equal(msgPoll.parseMarker('This is a normal comment'), null);
  assert.equal(msgPoll.parseMarker(''), null);
  assert.equal(msgPoll.parseMarker(null), null);
});

test('parseMarker が壊れた JSON に null を返す', () => {
  assert.equal(msgPoll.parseMarker('<!-- gh-maestro {broken json -->'), null);
});

test('parseMarker が to フィールドのない JSON に null を返す', () => {
  assert.equal(msgPoll.parseMarker('<!-- gh-maestro {"v":1,"from":"x"} -->'), null);
});

test('parseMarker が異なる形式の HTML コメントを無視する', () => {
  assert.equal(msgPoll.parseMarker('<!-- regular comment -->\nbody'), null);
});

test('parseMarker がマーカーが1行目に無い場合は無視する', () => {
  assert.equal(msgPoll.parseMarker('\n<!-- gh-maestro {"v":1,"to":"x","from":"y"} -->\nbody'), null);
});

// ── parseCommentsResponse（gh api --paginate --slurp 応答のフラット化） ────

test('parseCommentsResponse: ページ配列の配列（--paginate --slurp形状）をフラット化する', () => {
  const stdout = JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  assert.deepEqual(msgPoll.parseCommentsResponse(stdout), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('parseCommentsResponse: 単一ページのみでも正しくフラット化する（実測: [[c1,c2]]形状）', () => {
  const stdout = JSON.stringify([[{ id: 1 }, { id: 2 }]]);
  assert.deepEqual(msgPoll.parseCommentsResponse(stdout), [{ id: 1 }, { id: 2 }]);
});

test('parseCommentsResponse: 新着なし（実測: [[]]形状）は空配列を返す', () => {
  assert.deepEqual(msgPoll.parseCommentsResponse('[[]]'), []);
});

test('parseCommentsResponse: フラットなコメント配列（--paginate不使用の旧形状・テストモック）はそのまま返す（後方互換）', () => {
  const stdout = JSON.stringify([{ id: 1 }, { id: 2 }]);
  assert.deepEqual(msgPoll.parseCommentsResponse(stdout), [{ id: 1 }, { id: 2 }]);
});

test('parseCommentsResponse: 空配列・未指定は空配列を返す', () => {
  assert.deepEqual(msgPoll.parseCommentsResponse('[]'), []);
  assert.deepEqual(msgPoll.parseCommentsResponse(undefined), []);
});

test('parseCommentsResponse: 配列でないトップレベルは null を返す', () => {
  assert.equal(msgPoll.parseCommentsResponse(JSON.stringify({ foo: 'bar' })), null);
});

test('parseCommentsResponse: 壊れた JSON は例外を投げる（呼び出し側で catch する契約）', () => {
  assert.throws(() => msgPoll.parseCommentsResponse('{not json'));
});

// ── 既読状態（v2スキーマ。詳細は tests/read-state.test.js） ──────────────

test('readState が存在しない state ファイルに missing を返す', () => {
  withTempDir(workspace => {
    const r = msgPoll.readState(workspace, 'test-worker');
    assert.equal(r.status, 'missing');
  });
});

test('writeState → readState ラウンドトリップ（v2スキーマ）', () => {
  withTempDir(workspace => {
    const state = readStateLib.emptyState('g');
    state.readByIssue['10'] = [1, 2, 3];
    msgPoll.writeState(workspace, 'test-worker', state);

    const restored = msgPoll.readState(workspace, 'test-worker');
    assert.equal(restored.status, 'ok');
    assert.equal(restored.state.generation, 'g');
    assert.deepEqual(restored.state.readByIssue['10'], [1, 2, 3]);
  });
});

test('readState が壊れた state ファイルに corrupt を返す（空状態を暗黙作成しない）', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, 'not valid json{{{', 'utf8');
    assert.equal(msgPoll.readState(workspace, 'test-worker').status, 'corrupt');
  });
});

test('readState が v1（since/seenIds）に legacy を返す', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: '2026-07-07T12:00:00Z', seenIds: [1] }), 'utf8');
    assert.equal(msgPoll.readState(workspace, 'test-worker').status, 'legacy');
  });
});

test('readState が initialized 無しの不明オブジェクトに corrupt を返す', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({}), 'utf8');
    assert.equal(msgPoll.readState(workspace, 'test-worker').status, 'corrupt');
  });
});

// ── worker モード --once ────────────────────────────────────────────────────

test('worker モード --once: 新着を検出して NEW_MESSAGE を出力', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          id: 123456789,
          body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nHello worker!',
          created_at: '2026-07-07T12:00:00Z',
        },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:123456789'), `Expected NEW_MESSAGE:123456789 in: ${r.lines.join('|')}`);
  });
});

test('worker モード --once: to フィルタが働き他宛ては無視される', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          id: 111,
          body: '<!-- gh-maestro {"v":1,"to":"other-worker","from":"orchestrator"} -->\nNot for me',
          created_at: '2026-07-07T12:00:00Z',
        },
        {
          id: 222,
          body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nFor me!',
          created_at: '2026-07-07T12:00:01Z',
        },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(!r.lines.some(l => l.includes('111')), `other-worker message should be filtered out: ${r.lines.join('|')}`);
    assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:222'), `Expected NEW_MESSAGE:222 in: ${r.lines.join('|')}`);
  });
});

test('worker モード --once: マーカーなしコメントは無視される', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 333, body: 'Just a normal comment', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

test('worker モード --once: JSON parse エラーのマーカーは無視される', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 444, body: '<!-- gh-maestro {broken json -->\nbody', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

// ── 既読の永続化（--once の2回実行で二重通知しない） ─────────────────────

test('--once 2回実行で2回目は通知されない（既読IDの永続化）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          id: 999,
          body: '<!-- gh-maestro {"v":1,"to":"worker-2","from":"orchestrator"} -->\nHello again',
          created_at: '2026-07-07T12:00:00Z',
        },
      ]),
    }));

    // 1回目: 新着あり
    const r1 = runMain(['worker-2', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r1.code, 0);
    r1.scanOnce();
    assert.ok(r1.lines.some(l => l === 'NEW_MESSAGE:999'), `1回目: ${r1.lines.join('|')}`);

    // 2回目: 同じコメントは readByIssue に含まれるので通知されない
    const r2 = runMain(['worker-2', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r2.code, 0);
    r2.scanOnce();
    assert.ok(!r2.lines.some(l => l.includes('999')), `2回目は通知されないべき: ${r2.lines.join('|')}`);
  });
});

test('worker モード: 通知しなかったコメント（他宛て・マーカーなし）も既読として記録される', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 100, body: '<!-- gh-maestro {"v":1,"to":"other","from":"x"} -->\nnope', created_at: '2026-07-07T12:00:00Z' },
        { id: 101, body: 'plain comment', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = runMain(['worker-3', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
    const st = msgPoll.readState(workspace, 'worker-3');
    assert.equal(st.status, 'ok');
    assert.deepEqual(st.state.readByIssue['1'], [100, 101], '他宛て・マーカーなしコメントも既読記録される');
  });
});

// ── gh エラー耐性 ──────────────────────────────────────────────────────────

test('gh api 失敗時にスキップして code 0（エラーは errLines に）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 1,
      stderr: 'gh: rate limit exceeded',
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.errLines.some(l => l.includes('gh api エラー')), `Expected error in errLines: ${r.errLines.join('|')}`);
    assert.equal(r.lines.length, 0);
  });
});

test('gh api の JSON が壊れている場合にスキップ', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: 'not json at all',
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.errLines.some(l => l.includes('JSON parse エラー')));
    assert.equal(r.lines.length, 0);
  });
});

// ── 書き込み失敗耐性（Issue #250） ─────────────────────────────────────────
// markReadMany（既読の永続化）が他プロセスに msg-state を掴まれている等で EPERM を
// throw しても、常駐プロセスをクラッシュさせず次サイクルで再試行する。NEW_MESSAGE は
// 出力済みなので「重複通知」側に倒れる（握り潰しはしない）。

test('markReadMany が EPERM で throw しても scanOnce はクラッシュせず NEW_MESSAGE を出力済みのまま終わる', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 555, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nHello', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));
    // 警告は本物の msg-send.js を spawn させないようスタブする
    msgPoll._setNotifyOrchestrator(() => ({ status: 0, stdout: '', stderr: '' }));

    const originalMarkReadMany = readStateLib.markReadMany;
    readStateLib.markReadMany = () => {
      const err = new Error('simulated rename EPERM (Issue #250)');
      err.code = 'EPERM';
      throw err;
    };
    try {
      const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
      assert.equal(r.code, 0);
      // throw しても scanOnce は例外を外に漏らさない（常駐プロセスが落ちない）
      assert.doesNotThrow(() => r.scanOnce());
      // NEW_MESSAGE は出力済み（出力→記録の順、重複側に倒れる）
      assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:555'), `Expected NEW_MESSAGE:555 in: ${r.lines.join('|')}`);
      // 失敗は stderr に記録される
      assert.ok(r.errLines.some(l => l.includes('既読状態の更新で例外')), `Expected write failure log in: ${r.errLines.join('|')}`);
    } finally {
      readStateLib.markReadMany = originalMarkReadMany;
    }
  });
});

// ── orchestrator モード ────────────────────────────────────────────────────

test('orchestrator モード: 複数 issue をスキャンする', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, { 'worker-1': { issue: 10 }, 'worker-2': { issue: 20 } });

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const seenIssues = [];
    msgPoll._setGhApiComments((repo, issue, since) => {
      seenIssues.push(issue);
      assert.equal(since, null, 'since は使わず全件取得する（ID正本）');
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.deepEqual(seenIssues.sort(), ['10', '20']);
  });
});

test('orchestrator モード: workers.json が無い場合もエラーにならず継続', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    let called = false;
    msgPoll._setGhApiComments(() => {
      called = true;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(called, false, 'workers.json が無いので gh api は呼ばれない');
    assert.equal(r.lines.length, 0);
  });
});

test('orchestrator モード: 未処理の lock-denied/handoff-wait 監査イベントを出力して処理済み化する（Issue #240）', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const residentAudit = require('../scripts/shared/resident-audit');
    residentAudit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'inbox-supervisor', detail: { ownerPid: 111 } });
    residentAudit.recordResidentAuditEvent({ workspace, type: 'handoff-wait', role: 'msgpoll-orchestrator', detail: { ownerPid: 222 } });

    // 監査キューを消費できるのは role lease 保持モードのみ（--once は lease を取得せず、
    // 共有キューを読み取ると他プロセスと重複出力しうる。Issue #240 レビュー指摘）。
    const r = runMain(['orchestrator', '--workspace', workspace, '--wait', '30']);
    assert.equal(r.code, 0);
    r.scanOnce();

    assert.ok(r.lines.includes('LOCK_DENIED:inbox-supervisor:111'), `lines: ${JSON.stringify(r.lines)}`);
    assert.ok(r.lines.includes('HANDOFF_WAIT:msgpoll-orchestrator:222'), `lines: ${JSON.stringify(r.lines)}`);
    // 処理済み化（削除）されている
    assert.deepEqual(residentAudit.listUnprocessedResidentAuditEvents(workspace), []);
  });
});

test('orchestrator モード: 監査イベントは ownerPid が無ければ role のみ出力する', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const residentAudit = require('../scripts/shared/resident-audit');
    residentAudit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'inbox-supervisor', detail: {} });

    const r = runMain(['orchestrator', '--workspace', workspace, '--wait', '30']);
    assert.equal(r.code, 0);
    r.scanOnce();

    assert.ok(r.lines.includes('LOCK_DENIED:inbox-supervisor'), `lines: ${JSON.stringify(r.lines)}`);
  });
});

test('orchestrator モード: --wait の singleMessage 走査では監査行を出力しない', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const residentAudit = require('../scripts/shared/resident-audit');
    residentAudit.recordResidentAuditEvent({ workspace, type: 'lock-denied', role: 'inbox-supervisor', detail: { ownerPid: 111 } });

    // --wait モードは監査行の出力を「新着検出」と誤判定しないよう出力しない
    const r = runMain(['orchestrator', '--workspace', workspace, '--wait', '30']);
    msgPoll._setSleep(async () => {});
    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, [], `lines: ${JSON.stringify(r.lines)}`);
    // イベントは残る（次回の !singleMessage 走査で処理される）
    assert.equal(residentAudit.listUnprocessedResidentAuditEvents(workspace).length, 1);
  });
});

test('orchestrator モード: 重複 issue は排除される', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, {
      'worker-1': { issue: 10 },
      'worker-2': { issue: 10 },
      'worker-3': { issue: 20 },
    });

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const seenIssues = [];
    msgPoll._setGhApiComments((repo, issue) => {
      seenIssues.push(issue);
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.deepEqual(seenIssues.sort(), ['10', '20']);
  });
});

test('orchestrator モード: 出力形式が NEW_MESSAGE:<issue>:<commentId>', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace, { byIssue: { 10: [111] } });
    writeWorkers(workspace, { 'worker-1': { issue: 10 } });

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 111, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"w"} -->\nalready read', created_at: '2026-07-07T12:00:00Z' },
        { id: 777, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"worker-1"} -->\nReport!', created_at: '2026-07-07T12:00:01Z' },
      ]),
    }));

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:10:777'), `Expected NEW_MESSAGE:10:777 in: ${r.lines.join('|')}`);
    assert.ok(!r.lines.some(l => l.includes('111')), '既読IDは通知されない');
  });
});

test('orchestrator モード: 通知後は readByIssue に既読記録される', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, { 'worker-1': { issue: 10 } });

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 777, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"worker-1"} -->\nReport!', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:10:777'));

    const st = msgPoll.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.ok(st.state.readByIssue['10'].includes(777), '通知したIDが既読記録される');
  });
});

test('orchestrator モード: not-for-me / マーカーなしコメントも既読記録される', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, { 'worker-1': { issue: 10 } });

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 200, body: '<!-- gh-maestro {"v":1,"to":"worker-1","from":"orchestrator"} -->\nfor worker', created_at: '2026-07-07T12:00:00Z' },
        { id: 201, body: 'just a note', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(r.lines.length, 0, '自分宛て以外は通知しない');

    const st = msgPoll.readState(workspace, 'orchestrator');
    assert.equal(st.status, 'ok');
    assert.deepEqual(st.state.readByIssue['10'], [200, 201], '他宛て・マーカーなしコメントも既読記録される');
  });
});

test('orchestrator モード: 取得最適化カーソルが設定され、2回目以降はウォーターマークの1秒前から差分取得する', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, { 'w': { issue: 10 } });
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const allComments = [
      { id: 1, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"w"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
    ];
    let callCount = 0;
    msgPoll._setGhApiComments((repo, issue, since) => {
      callCount++;
      if (callCount === 1) {
        assert.equal(since, null, '初回は全件取得（カーソル未設定）');
      } else {
        assert.equal(since, '2026-07-07T11:59:59Z', '2回目はウォーターマークの1秒前から取得（取りこぼし防止）');
      }
      return { status: 0, stdout: JSON.stringify(allComments) };
    });

    const r1 = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r1.scanOnce();
    assert.ok(r1.lines.some(l => l === 'NEW_MESSAGE:10:1'));

    // ウォーターマーク（sinceByIssue）が max created_at まで進んでいる
    const st = msgPoll.readState(workspace, 'orchestrator');
    assert.equal(st.state.sinceByIssue['10'], '2026-07-07T12:00:00Z');

    // 2回目: 差分取得（1秒前から）。既読IDなので通知されない
    const r2 = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r2.scanOnce();
    assert.equal(callCount, 2);
    assert.equal(r2.lines.length, 0, '既読IDは再通知しない');
  });
});

test('orchestrator モード: singleMessage で持ち越し候補がある間はウォーターマークを進めない', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, { 'w': { issue: 10 } });
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const allComments = [
      { id: 1, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"w"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
      { id: 2, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"w"} -->\nB', created_at: '2026-07-07T12:01:00Z' },
    ];
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify(allComments) }));

    const r = runMain(['orchestrator', '--workspace', workspace, '--wait', '30']);
    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, ['NEW_MESSAGE:10:1']);

    // 持ち越し（2）がある間はウォーターマークを進めない
    const st = msgPoll.readState(workspace, 'orchestrator');
    assert.equal(st.state.sinceByIssue['10'] || null, null, '持ち越しがある間はウォーターマークを進めない');

    // 2回目: 持ち越しを出力
    r.lines.length = 0;
    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, ['NEW_MESSAGE:10:2']);
  });
});

test('orchestrator モード: --issue 指定も受け付ける（orchestrator の場合は必須でない）', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const r = runMain(['orchestrator', '--issue', '5', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
  });
});

// ── orchestrator: 未初期化・旧形式 state では走査停止（Issue #207） ────

test('orchestrator モード: state 欠落時は走査を停止し空状態を暗黙作成しない', () => {
  withTempDir(workspace => {
    writeWorkers(workspace, { 'w': { issue: 100 } });
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false, 'state 未初期化では gh api を呼ばない');
    assert.equal(r.lines.length, 0);
    assert.ok(r.errLines.some(l => l.includes('未初期化')), `未初期化報告: ${r.errLines.join('|')}`);
    assert.equal(fs.existsSync(msgPoll.statePath(workspace, 'orchestrator')), false, '空状態を暗黙作成しない');
  });
});

test('orchestrator モード: state 破損時は走査を停止して報告する', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, 'broken{{{', 'utf8');
    writeWorkers(workspace, { 'w': { issue: 100 } });
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false);
    assert.ok(r.errLines.some(l => l.includes('未初期化')));
  });
});

test('orchestrator モード: v1（旧形式since/seenIds）は停止し移行を案内する', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: { 10: '2026-07-07T00:00:00Z' }, seenIds: [1] }), 'utf8');
    writeWorkers(workspace, { 'w': { issue: 10 } });
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false);
    assert.ok(r.errLines.some(l => l.includes('旧形式')), `移行案内: ${r.errLines.join('|')}`);
  });
});

// ── worker モードの旧形式（v1）state は seenIds を引き継ぐ ─────────────

test('worker モード: v1 state の seenIds を既読として引き継ぎ再通知しない', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'my-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: '2026-07-07T12:00:00Z', seenIds: [999] }), 'utf8');

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 999, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nalready notified', created_at: '2026-07-07T12:00:00Z' },
        { id: 1000, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nnew one', created_at: '2026-07-07T12:00:01Z' },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:1000'], '既通知IDは再通知せず新着のみ');
  });
});

// ── 空レスポンス ───────────────────────────────────────────────────────────

test('gh api が空配列を返した場合に空出力で exit 0', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

// ── workers.json 安全性 ────────────────────────────────────────────────────

test('workers.json が配列の場合にクラッシュしない', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, [1, 2, 3]);

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false, '配列の workers.json は無視される');
  });
});

test('workers.json のエントリが null の場合にクラッシュしない', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, { 'w1': null, 'w2': { issue: 10 } });

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    const seenIssues = [];
    msgPoll._setGhApiComments((repo, issue) => {
      seenIssues.push(issue);
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(seenIssues, ['10'], 'null エントリはスキップされ w2 だけ処理される');
  });
});

test('workers.json が null にパースされる場合にクラッシュしない', () => {
  withTempDir(workspace => {
    initOrchestratorState(workspace);
    writeWorkers(workspace, null);

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = runMain(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false);
  });
});

// ── gh api 応答安全 ────────────────────────────────────────────────────────

test('gh api が配列でない JSON を返した場合にクラッシュしない', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify({ error: 'something went wrong' }) }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.errLines.some(l => l.includes('配列ではありません')));
    assert.equal(r.lines.length, 0);
  });
});

test('gh api が null を返した場合にクラッシュしない', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: 'null' }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

// ── 継続モードの多重起動検知（サブプロセス経由） ────────────────────────────
// scanOnce() を呼ばないため gh 呼び出しは発生しない。重複検知で即 exit(1) するため
// interval ループには入らず、実ポーリングプロセスは生成されない
// （.claude/rules/test-process-spawn-safety.md 準拠）。
// GH_MAESTRO_WORKSPACE を外した env で起動し、必ず --workspace の一時dirを使う。

test('継続モード: 同じ self を監視中の生存プロセスがいれば exit 1 して起動しない', (t) => {
  const { spawnSync } = require('child_process');
  const { getProcessStartTime } = require('../scripts/process-lifecycle');

  const startTimeProbe = getProcessStartTime(process.pid);
  if (!startTimeProbe) {
    t.skip('この環境では getProcessStartTime が機能しないため、実プロセスでの同一性確認を検証できません');
    return;
  }

  withTempDir(workspace => {
    // 排他の正本は role lease（Issue #240）。registry エントリでなく
    // <workspace>/.gh-maestro/leases/resident-role-msgpoll-orchestrator.json を用意する。
    // pid はテストランナー自身ではなく ppid を指定する（--force 無しなので kill は走らないが、
    // 念のためテスト環境のプロセスを対象にしない）。
    const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    const otherPid = process.ppid;
    const startTime = getProcessStartTime(otherPid);
    fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
      pid: otherPid, startTime, workerName: 'msgpoll-orchestrator', phase: 'active',
    }));

    const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', workspace],
      { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /重複起動/);
  });
});

test('継続モード: --force は重複レース判定を無効化せず、既存所有者を停止させて引き継ぐ', () => {
  const { spawnSync, spawn } = require('child_process');
  const { getProcessStartTime } = require('../scripts/process-lifecycle');
  withTempDir(workspace => {
    // 既存所有者として使い捨ての実子プロセスを立てる。--force の引き継ぎは
    // killProcessTree で所有者を終了させるため、process.ppid 等のテスト実行環境の
    // プロセスを owner に指定してはならない（テストランナーの親を kill してしまう）。
    const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
      env: cleanSpawnEnv(),
    });
    let leakedOwner = true;
    try {
      const otherPid = owner.pid;
      // 起動直後の子の startTime は WMI にまだ見えないことがあるため、取れるまで待つ
      // （startTime が無いと isLeaseLive が同一性確認をスキップし、生きただけのPIDで
      // 誤判定しうる）。取れない場合は startTime なしでも排他判定は成立するため許容。
      let startTime = getProcessStartTime(otherPid);
      for (let i = 0; !startTime && i < 20; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        startTime = getProcessStartTime(otherPid);
      }
      const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
      fs.mkdirSync(leasesDir, { recursive: true });
      fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
        pid: otherPid, startTime, workerName: 'msgpoll-orchestrator', phase: 'active',
      }));

      const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
      const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', workspace, '--force'],
        { encoding: 'utf8', timeout: 15000, env: cleanSpawnEnv() });

      assert.doesNotMatch(r.stderr, /重複起動/);
      // 引き継ぎは lease を再取得して本稼働へ進む（本テストでは gh 解決に失敗して
      // exit 1 になるが、重複起動の拒否ではない）。owner は停止されている。
      if (owner.exitCode === null && owner.signalCode === null) {
        leakedOwner = false;
      }
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        try { owner.kill(); } catch {}
      }
      assert.equal(leakedOwner, false, '--force の引き継ぎで既存所有者プロセスが停止されること');
    }
  });
});

test('継続モード: --workspace がホームディレクトリと衝突する場合、生の例外ではなくワークスペース解決エラーで exit 1 する（Issue #214）', () => {
  // resolveWorkspace() が workspace の home 衝突を検知して null を返すため、
  // registerProcess/role lease 等の assertValidWorkspace throw が
  // 子プロセスの生スタックトレースとして漏れ出ることなく、通常のエラーメッセージ
  // + exit 1 に倒れることを実プロセス起動で確認する。
  const { spawnSync } = require('child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-fakehome-'));
  try {
    const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
    const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const env = { ...cleanSpawnEnv(), [envKey]: fakeHome };

    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', fakeHome],
      { encoding: 'utf8', timeout: 10000, env });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /ワークスペースを解決できません/);
    assert.doesNotMatch(r.stderr, /assertValidWorkspace/, `生の例外スタックトレースが漏れてはならない: ${r.stderr}`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('継続モード: 重複起動検出時のエラーに、判断不要でそのまま使えるwatch-pidコマンドが含まれる', (t) => {
  const { spawnSync } = require('child_process');
  const { getProcessStartTime } = require('../scripts/process-lifecycle');

  const startTimeProbe = getProcessStartTime(process.pid);
  if (!startTimeProbe) {
    t.skip('この環境では getProcessStartTime が機能しないため、実プロセスでの同一性確認を検証できません');
    return;
  }

  withTempDir(workspace => {
    const leasesDir = path.join(workspace, '.gh-maestro', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    const otherPid = process.ppid;
    const startTime = getProcessStartTime(otherPid);
    fs.writeFileSync(path.join(leasesDir, 'resident-role-msgpoll-orchestrator.json'), JSON.stringify({
      pid: otherPid, startTime, workerName: 'msgpoll-orchestrator', phase: 'active',
    }));

    const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', workspace],
      { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });

    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`--watch-pid ${otherPid}\\b`));
    assert.match(r.stderr, /PID_DIED/);
  });
});

// ── buildWatchPidCommand ─────────────────────────────────────────────────────

test('buildWatchPidCommand: pidを含むコマンド文字列を組み立てる', () => {
  const cmd = msgPoll.buildWatchPidCommand(12345);
  assert.match(cmd, /--watch-pid 12345/);
  assert.doesNotMatch(cmd, /--interval/);
});

test('buildWatchPidCommand: intervalSec指定時は--intervalを含む', () => {
  const cmd = msgPoll.buildWatchPidCommand(12345, '5');
  assert.match(cmd, /--interval 5/);
});

// ── --watch-pid モード（実プロセス起動） ─────────────────────────────────────

test('--watch-pid: 監視対象PIDが生きている間は何も出力しない', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
  const r = spawnSync(process.execPath, [script, '--watch-pid', String(process.pid), '--interval', '1'],
    { encoding: 'utf8', timeout: 2500, env: cleanSpawnEnv() });
  assert.equal(r.stdout.trim(), '');
});

test('--watch-pid: 監視対象PIDが死んでいれば即座にPID_DIEDを出力してexit 0', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  const deadPid = dead.pid;

  const r = spawnSync(process.execPath, [script, '--watch-pid', String(deadPid), '--interval', '1'],
    { encoding: 'utf8', timeout: 5000, env: cleanSpawnEnv() });

  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `PID_DIED:${deadPid}`);
});

test('--watch-pid: 不正なpid指定はexit 1', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
  const r = spawnSync(process.execPath, [script, '--watch-pid', 'not-a-number'], { encoding: 'utf8', timeout: 5000, env: cleanSpawnEnv() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /正の整数のPID/);
});

test('--watch-pid: 余剰な位置引数・未知フラグはエラー終了する（黙って無視しない）', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
  const r = spawnSync(process.execPath, [script, '--watch-pid', String(process.pid), 'extra'],
    { encoding: 'utf8', timeout: 5000, env: cleanSpawnEnv() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知の引数/);
});

// ── --wait モード ───────────────────────────────────────────────────────────

test('--once と --wait の同時指定は code 1', () => {
  withTempDir(workspace => {
    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once', '--wait', '5']);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('--once') && l.includes('--wait')));
    assert.equal(r.scanOnce, null);
  });
});

test('--wait に不正な値（0以下・非数値）を渡すと code 1', () => {
  withTempDir(workspace => {
    const r1 = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '0']);
    assert.equal(r1.code, 1);
    assert.equal(r1.scanOnce, null);

    const r2 = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', 'abc']);
    assert.equal(r2.code, 1);
    assert.equal(r2.scanOnce, null);
  });
});

test('--wait は main() の結果に waitMode:true と waitMs を設定する', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '10', '--interval', '3']);
    assert.equal(r.code, 0);
    assert.equal(r.waitMode, true);
    assert.equal(r.waitMs, 10000);
    assert.equal(r.intervalMs, 3000);
    assert.equal(r.onceMode, false);
  });
});

test('runWaitMode: 新着を即座に検出すればリトライせず true を返す', async () => {
  await withTempDir(async workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          id: 42,
          body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nHi',
          created_at: '2026-07-07T12:00:00Z',
        },
      ]),
    }));

    let sleepCalls = 0;
    msgPoll._setSleep(async () => { sleepCalls++; });

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
    const found = await msgPoll.runWaitMode(r);
    assert.equal(found, true);
    assert.equal(sleepCalls, 0);
    assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:42'));

    msgPoll._setSleep(async (ms) => {});
  });
});

test('runWaitMode: 新着が無ければ waitMs 経過後に false を返す（リトライを重ねる）', async () => {
  await withTempDir(async workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    let sleepCalls = 0;
    msgPoll._setSleep(async (ms) => { sleepCalls++; await new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))); });

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '1', '--interval', '1']);
    const found = await msgPoll.runWaitMode(r);
    assert.equal(found, false);
    assert.equal(r.lines.length, 0);
    assert.ok(sleepCalls > 0, `sleepCalls should be > 0, got ${sleepCalls}`);

    msgPoll._setSleep(async (ms) => {});
  });
});

test('scanOnce: maxGhTimeoutMs を渡すと gh 呼び出しの timeout オプションが残り時間に絞り込まれる', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let capturedOpts = null;
    msgPoll._setGhApiComments((repo, issue, since, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
    r.scanOnce({ maxGhTimeoutMs: 2000 });
    assert.equal(capturedOpts.timeout, 2000);
  });
});

test('scanOnce: maxGhTimeoutMs が小さすぎても最低1000msは確保される', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let capturedOpts = null;
    msgPoll._setGhApiComments((repo, issue, since, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
    r.scanOnce({ maxGhTimeoutMs: 10 });
    assert.equal(capturedOpts.timeout, 1000);
  });
});

test('scanOnce: maxGhTimeoutMs 未指定時は既定の GH_TIMEOUT_MS 相当（timeoutキーなし）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let capturedOpts = null;
    msgPoll._setGhApiComments((repo, issue, since, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(capturedOpts.timeout, undefined);
    assert.equal(capturedOpts.cwd, workspace);
  });
});

// ── --wait モード: 1回1件返却の契約（Issue #99） ────────────────────────────

test('scanOnce({singleMessage:true}): 新着が複数件あっても最も古い1件のみ出力・既読化する', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    const allComments = [
      { id: 1, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
      { id: 2, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nB', created_at: '2026-07-07T12:01:00Z' },
      { id: 3, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nC', created_at: '2026-07-07T12:02:00Z' },
    ];
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify(allComments) }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);

    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, ['NEW_MESSAGE:1']);

    r.lines.length = 0;
    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, ['NEW_MESSAGE:2']);

    r.lines.length = 0;
    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, ['NEW_MESSAGE:3']);

    r.lines.length = 0;
    r.scanOnce({ singleMessage: true });
    assert.deepEqual(r.lines, []);
  });
});

test('runWaitMode: 複数件の新着があっても1回の呼び出しでは1件しか返らない', async () => {
  await withTempDir(async workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    const allComments = [
      { id: 10, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
      { id: 11, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nB', created_at: '2026-07-07T12:01:00Z' },
    ];
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify(allComments) }));
    msgPoll._setSleep(async () => {});

    const r1 = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
    const found1 = await msgPoll.runWaitMode(r1);
    assert.equal(found1, true);
    assert.deepEqual(r1.lines, ['NEW_MESSAGE:10']);
    // --wait モードは role lease を保持したまま main() が返るため、同一 workspace で
    // 2回連続起動するには前回の lease を解放しておく（重複起動は正当に拒否される）。
    r1.residentLease.release();

    const r2 = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
    const found2 = await msgPoll.runWaitMode(r2);
    assert.equal(found2, true);
    assert.deepEqual(r2.lines, ['NEW_MESSAGE:11']);

    msgPoll._setSleep(async () => {});
  });
});

test('scanOnce({singleMessage:false}): --once/継続モードは従来どおり複数件をまとめて返す', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
        { id: 2, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nB', created_at: '2026-07-07T12:01:00Z' },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:1', 'NEW_MESSAGE:2']);
  });
});

test('scanOnce: 破損した state（v1由来のseenIds配列が不正）でも worker モードは動作する', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const sp = msgPoll.statePath(workspace, 'my-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: '2026-07-07T12:00:00Z', seenIds: [1] }), 'utf8');

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, []);
  });
});

test('scanOnce: created_at が欠落したコメントは新着候補から除外され既読記録される', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: undefined },
        { id: 2, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nB', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = runMain(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:2']);

    const st = msgPoll.readState(workspace, 'my-worker');
    assert.equal(st.status, 'ok');
    assert.ok(st.state.readByIssue['1'].includes(1), 'created_at 欠落コメントも既読記録される');
  });
});

// ── reset mocks ─────────────────────────────────────────────────────────────

msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));
