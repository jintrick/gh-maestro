'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgPoll = require('../scripts/msg-poll');

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
  // fn が async の場合、Promise が解決するまで cleanup を遅らせないと、
  // 呼び出し元の await 中に一時ディレクトリが消え、状態永続化に依存する
  // テストが false negative になる。
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
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

// ── --help / -h ────────────────────────────────────────────────────────────

test('--help が usage を返して code 0', () => {
  const r = msgPoll.main(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-poll.js'));
  assert.equal(r.errLines.length, 0);
  assert.equal(r.scanOnce, null);
});

test('-h が usage を返して code 0', () => {
  const r = msgPoll.main(['-h']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-poll.js'));
  assert.equal(r.errLines.length, 0);
  assert.equal(r.scanOnce, null);
});

// ── 引数エラー ──────────────────────────────────────────────────────────────

test('self なしは code 1', () => {
  const r = msgPoll.main([]);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.join('\n').includes('msg-poll.js'));
  assert.equal(r.scanOnce, null);
});

test('worker モードで --issue なしは code 1', () => {
  const r = msgPoll.main(['my-worker']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--issue')));
  assert.equal(r.scanOnce, null);
});

// ── path-safety 検証 ───────────────────────────────────────────────────────

test('.. を含む self は code 1', () => {
  withTempDir(workspace => {
    const r = msgPoll.main(['../orchestrator', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('親ディレクトリ参照')));
    assert.equal(r.scanOnce, null);
  });
});

test('パス区切り文字を含む self は code 1', () => {
  withTempDir(workspace => {
    const r = msgPoll.main(['a/b', '--issue', '1', '--workspace', workspace, '--once']);
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

// ── カーソル永続化 ─────────────────────────────────────────────────────────

test('readState が存在しない state ファイルにデフォルト値を返す', () => {
  withTempDir(workspace => {
    const state = msgPoll.readState(workspace, 'test-worker');
    assert.equal(state.since, null);
    assert.deepEqual(state.seenIds, []);
  });
});

test('writeState → readState ラウンドトリップ', () => {
  withTempDir(workspace => {
    const original = { since: '2026-07-07T12:00:00Z', seenIds: [1, 2, 3] };
    msgPoll.writeState(workspace, 'test-worker', original);

    const restored = msgPoll.readState(workspace, 'test-worker');
    assert.equal(restored.since, '2026-07-07T12:00:00Z');
    assert.deepEqual(restored.seenIds, [1, 2, 3]);
  });
});

test('readState が壊れた state ファイルにデフォルト値を返す（破損回復）', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, 'not valid json{{{', 'utf8');

    const state = msgPoll.readState(workspace, 'test-worker');
    assert.equal(state.since, null);
    assert.deepEqual(state.seenIds, []);
  });
});

test('readState が since 欠落・seenIds 欠落にデフォルトを返す', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({}), 'utf8');

    const state = msgPoll.readState(workspace, 'test-worker');
    assert.equal(state.since, null);
    assert.deepEqual(state.seenIds, []);
  });
});

test('readState が非nullの since 値をそのまま保持する（型チェックは scanOnce が行う）', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: 123, seenIds: [1] }), 'utf8');

    const state = msgPoll.readState(workspace, 'test-worker');
    // readState は非nullならそのまま返す（数値であっても）
    // 型安全性のチェックは scanOnce 内で行われる（worker モードでは typeof === 'string' を確認）
    assert.equal(state.since, 123);
    assert.deepEqual(state.seenIds, [1]);
  });
});

test('readState が seenIds が配列でない場合にデフォルトを返す', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: '2026-07-07T12:00:00Z', seenIds: 'not-an-array' }), 'utf8');

    const state = msgPoll.readState(workspace, 'test-worker');
    assert.equal(state.since, '2026-07-07T12:00:00Z');
    assert.deepEqual(state.seenIds, []);
  });
});

test('writeState が seenIds を MAX_SEEN_IDS で切り詰める', () => {
  withTempDir(workspace => {
    const manyIds = Array.from({ length: 150 }, (_, i) => i + 1);
    msgPoll.writeState(workspace, 'test-worker', { since: '2026-07-07T12:00:00Z', seenIds: manyIds });

    const restored = msgPoll.readState(workspace, 'test-worker');
    assert.equal(restored.seenIds.length, 100);
    assert.deepEqual(restored.seenIds[0], 51);
    assert.deepEqual(restored.seenIds[99], 150);
  });
});

test('writeState が tmp 書き込み + rename でアトミックに書き込む', () => {
  withTempDir(workspace => {
    msgPoll.writeState(workspace, 'test-worker', { since: '2026-07-07T12:00:00Z', seenIds: [1] });

    const sp = msgPoll.statePath(workspace, 'test-worker');
    const raw = fs.readFileSync(sp, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.since, '2026-07-07T12:00:00Z');
    assert.deepEqual(parsed.seenIds, [1]);
    const dir = path.dirname(sp);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'test-worker.json');
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

// ── カーソル永続化（--once の2回実行で二重通知しない） ─────────────────────

test('--once 2回実行で2回目は通知されない（カーソル永続化）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    let callCount = 0;
    msgPoll._setGhApiComments(() => {
      callCount++;
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            id: 999,
            body: '<!-- gh-maestro {"v":1,"to":"worker-2","from":"orchestrator"} -->\nHello again',
            created_at: '2026-07-07T12:00:00Z',
          },
        ]),
      };
    });

    // 1回目: 新着あり
    const r1 = msgPoll.main(['worker-2', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r1.code, 0);
    r1.scanOnce();
    assert.ok(r1.lines.some(l => l === 'NEW_MESSAGE:999'), `1回目: ${r1.lines.join('|')}`);

    // 2回目: 同じコメントは seenIds に含まれているので通知されない
    const r2 = msgPoll.main(['worker-2', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r2.code, 0);
    r2.scanOnce();
    assert.ok(!r2.lines.some(l => l.includes('999')), `2回目は通知されないべき: ${r2.lines.join('|')}`);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.errLines.some(l => l.includes('JSON parse エラー')));
    assert.equal(r.lines.length, 0);
  });
});

// ── orchestrator モード ────────────────────────────────────────────────────

test('orchestrator モード: 複数 issue をスキャンする', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({
        'worker-1': { issue: 10 },
        'worker-2': { issue: 20 },
      }, null, 2),
      'utf8'
    );

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const seenIssues = [];
    msgPoll._setGhApiComments((repo, issue) => {
      seenIssues.push(issue);
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.deepEqual(seenIssues.sort(), ['10', '20']);
  });
});

test('orchestrator モード: workers.json が無い場合もエラーにならず継続', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    let called = false;
    msgPoll._setGhApiComments(() => {
      called = true;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(called, false, 'workers.json が無いので gh api は呼ばれない');
    assert.equal(r.lines.length, 0);
  });
});

test('orchestrator モード: 重複 issue は排除される', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({
        'worker-1': { issue: 10 },
        'worker-2': { issue: 10 },
        'worker-3': { issue: 20 },
      }, null, 2),
      'utf8'
    );

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const seenIssues = [];
    msgPoll._setGhApiComments((repo, issue) => {
      seenIssues.push(issue);
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.deepEqual(seenIssues.sort(), ['10', '20']);
  });
});

test('orchestrator モード: 出力形式が NEW_MESSAGE:<issue>:<commentId>', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'worker-1': { issue: 10 } }, null, 2),
      'utf8'
    );

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          id: 777,
          body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"worker-1"} -->\nReport!',
          created_at: '2026-07-07T12:00:00Z',
        },
      ]),
    }));

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.lines.some(l => l === 'NEW_MESSAGE:10:777'), `Expected NEW_MESSAGE:10:777 in: ${r.lines.join('|')}`);
  });
});

test('orchestrator モード --issue 指定も受け付ける（orchestrator の場合は必須でない）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([]),
    }));

    const r = msgPoll.main(['orchestrator', '--issue', '5', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
  });
});

// ── 空レスポンス ───────────────────────────────────────────────────────────

test('gh api が空配列を返した場合に空出力で exit 0', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([]),
    }));

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

// ── orchestrator モード per-issue since ────────────────────────────────────

test('orchestrator モード: Issue ごとの個別 since が永続化される', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({
        'worker-1': { issue: 10 },
        'worker-2': { issue: 20 },
      }, null, 2),
      'utf8'
    );

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    // issue 10 は T2、issue 20 は T1（より古い）コメントを返す
    let callCount = 0;
    msgPoll._setGhApiComments((repo, issue, since) => {
      callCount++;
      if (issue === '10') {
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: 10, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"w1"} -->\nmsg10',
              created_at: '2026-07-07T12:00:02Z' },
          ]),
        };
      }
      if (issue === '20') {
        // since が渡されていない（初回）ことを確認
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: 20, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"w2"} -->\nmsg20',
              created_at: '2026-07-07T12:00:01Z' },
          ]),
        };
      }
      return { status: 0, stdout: JSON.stringify([]) };
    });

    // 1回目のスキャン
    const r1 = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    assert.equal(r1.code, 0);
    r1.scanOnce();

    // 永続化された state を確認
    const state = msgPoll.readState(workspace, 'orchestrator');
    assert.ok(state.since && typeof state.since === 'object',
      `since should be object for orchestrator, got: ${JSON.stringify(state.since)}`);
    assert.equal(state.since['10'], '2026-07-07T12:00:02Z');
    assert.equal(state.since['20'], '2026-07-07T12:00:01Z');
  });
});

test('orchestrator モード: 古い state 形式（文字列 since）からの移行', () => {
  withTempDir(workspace => {
    // 事前に古い形式（文字列since）の state ファイルを作成
    const sp = msgPoll.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({
      since: '2026-07-07T11:00:00Z',
      seenIds: [1],
    }), 'utf8');

    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'w': { issue: 10 } }, null, 2),
      'utf8'
    );

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let capturedSince = null;
    msgPoll._setGhApiComments((repo, issue, since) => {
      capturedSince = since;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    // 文字列sinceは無視され、新形式 {} に移行するため since パラメータは null
    assert.equal(capturedSince, null);
  });
});

// ── workers.json 安全性 ────────────────────────────────────────────────────

test('workers.json が配列の場合にクラッシュしない', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), JSON.stringify([1, 2, 3]), 'utf8');

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false, '配列の workers.json は無視される');
  });
});

test('workers.json のエントリが null の場合にクラッシュしない', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'w1': null, 'w2': { issue: 10 } }, null, 2),
      'utf8'
    );

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    const seenIssues = [];
    msgPoll._setGhApiComments((repo, issue) => {
      seenIssues.push(issue);
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(seenIssues, ['10'], 'null エントリはスキップされ w2 だけ処理される');
  });
});

test('workers.json が null にパースされる場合にクラッシュしない', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'workers.json'), 'null', 'utf8');

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let called = false;
    msgPoll._setGhApiComments(() => { called = true; return { status: 0, stdout: JSON.stringify([]) }; });

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(called, false);
  });
});

// ── gh api 応答安全 ────────────────────────────────────────────────────────

test('gh api が配列でない JSON を返した場合にクラッシュしない', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify({ error: 'something went wrong' }),
    }));

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    assert.equal(r.code, 0);
    r.scanOnce();
    assert.ok(r.errLines.some(l => l.includes('配列ではありません')));
    assert.equal(r.lines.length, 0);
  });
});

test('gh api が null を返した場合にクラッシュしない', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: 'null',
    }));

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.equal(r.lines.length, 0);
  });
});

// ── worker モード since 型安全 ─────────────────────────────────────────────

test('worker モード: state.since が文字列でない場合は null 扱い', () => {
  withTempDir(workspace => {
    // 数値 since の state ファイルを作成（破損想定）
    const sp = msgPoll.statePath(workspace, 'my-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: 999, seenIds: [] }), 'utf8');

    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let capturedSince = undefined;
    msgPoll._setGhApiComments((repo, issue, since) => {
      capturedSince = since;
      return { status: 0, stdout: JSON.stringify([]) };
    });

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    // 数値 since は型チェックで弾かれ null として扱われる
    assert.equal(capturedSince, null);
  });
});

// ── 継続モードの多重起動検知（サブプロセス経由） ────────────────────────────
// scanOnce() を呼ばないため gh 呼び出しは発生しない。重複検知で即 exit(1) するため
// interval ループには入らず、実ポーリングプロセスは生成されない
// （.claude/rules/test-process-spawn-safety.md 準拠）。

test('継続モード: 同じ self を監視中の生存プロセスがいれば exit 1 して起動しない', (t) => {
  const { spawnSync } = require('child_process');
  const { getProcessStartTime } = require('../scripts/process-lifecycle');

  // findRunningInstance は verifyProcessIdentity（WMI/procfs 経由の起動時刻取得）に
  // 依存する。サンドボックス環境ではWMI呼び出しが機能しないことがあり、その場合
  // 実プロセスでの同一性確認そのものが常にfalseになり本テストの前提が成立しない
  // （ロジック自体は tests/process-lifecycle.test.js のモック済みユニットテストでカバー済み）。
  const startTimeProbe = getProcessStartTime(process.pid);
  if (!startTimeProbe) {
    t.skip('この環境では getProcessStartTime が機能しないため、実プロセスでの同一性確認を検証できません');
    return;
  }

  withTempDir(workspace => {
    const pidsDir = path.join(workspace, '.gh-maestro', 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    // process.ppid はテストランナーの親プロセス（生存中）を借りて「既存の監視プロセス」を模擬する。
    // 子プロセス側の verifyProcessIdentity が同一性確認するため、実際のstartTimeを
    // 事前に取得してエントリに書き込む（決定的に一致させる）。
    const otherPid = process.ppid;
    const startTime = getProcessStartTime(otherPid);
    fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
      pid: otherPid, script: 'msg-poll.js', workerName: null, workspace, startTime,
    }));

    const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', workspace], { encoding: 'utf8', timeout: 10000 });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /重複起動/);
  });
});

test('継続モード: --force を指定すると重複があっても起動を試みる（重複チェックをスキップする）', () => {
  const { spawnSync } = require('child_process');
  withTempDir(workspace => {
    const pidsDir = path.join(workspace, '.gh-maestro', 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    const otherPid = process.ppid;
    fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
      pid: otherPid, script: 'msg-poll.js', workerName: null, workspace,
    }));

    const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
    // --force により重複チェックを素通りし、実ポーリング（gh呼び出し）に進む。
    // gh 未モック環境のため repo 解決に失敗して別経路で exit する想定だが、
    // 少なくとも「重複起動」エラーでは止まらないことを確認する。
    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', workspace, '--force'], { encoding: 'utf8', timeout: 10000 });

    assert.doesNotMatch(r.stderr, /重複起動/);
  });
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
    const pidsDir = path.join(workspace, '.gh-maestro', 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    const otherPid = process.ppid;
    const startTime = getProcessStartTime(otherPid);
    fs.writeFileSync(path.join(pidsDir, `${otherPid}.json`), JSON.stringify({
      pid: otherPid, script: 'msg-poll.js', workerName: null, workspace, startTime,
    }));

    const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
    const r = spawnSync(process.execPath, [script, 'orchestrator', '--workspace', workspace], { encoding: 'utf8', timeout: 10000 });

    assert.equal(r.status, 1);
    // 「重複か生存確認済みの残骸か」をエージェントに判断させず、そのまま使えるコマンドを提示する
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
  // テストランナー自身のPID（このテストの実行中は確実に生存）を監視対象にする。
  // 短いタイムアウトで強制終了させ、その間に出力が無いことを確認する。
  const r = spawnSync(process.execPath, [script, '--watch-pid', String(process.pid), '--interval', '1'],
    { encoding: 'utf8', timeout: 2500 });
  // タイムアウトでkillされる想定（生存中は自発的に終了しない）
  assert.equal(r.stdout.trim(), '');
});

test('--watch-pid: 監視対象PIDが死んでいれば即座にPID_DIEDを出力してexit 0', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
  // 実行中のプロセスとほぼ確実に衝突しない、既に終了済みの子プロセスのPIDを使う
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  const deadPid = dead.pid;

  const r = spawnSync(process.execPath, [script, '--watch-pid', String(deadPid), '--interval', '1'],
    { encoding: 'utf8', timeout: 5000 });

  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `PID_DIED:${deadPid}`);
});

test('--watch-pid: 不正なpid指定はexit 1', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'msg-poll.js');
  const r = spawnSync(process.execPath, [script, '--watch-pid', 'not-a-number'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /正の整数のPID/);
});

// ── --wait モード ───────────────────────────────────────────────────────────

test('--once と --wait の同時指定は code 1', () => {
  withTempDir(workspace => {
    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once', '--wait', '5']);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('--once') && l.includes('--wait')));
    assert.equal(r.scanOnce, null);
  });
});

test('--wait に不正な値（0以下・非数値）を渡すと code 1', () => {
  withTempDir(workspace => {
    const r1 = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '0']);
    assert.equal(r1.code, 1);
    assert.equal(r1.scanOnce, null);

    const r2 = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', 'abc']);
    assert.equal(r2.code, 1);
    assert.equal(r2.scanOnce, null);
  });
});

test('--wait は main() の結果に waitMode:true と waitMs を設定する', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '10', '--interval', '3']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
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
    // 実待機はごく短く（busy-loop でCPUを浪費しないように）、かつ複数回リトライさせる
    msgPoll._setSleep(async (ms) => { sleepCalls++; await new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))); });

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '1', '--interval', '1']);
    const found = await msgPoll.runWaitMode(r);
    assert.equal(found, false);
    assert.equal(r.lines.length, 0);
    // sleep をモックしているので実待機は発生しないが、少なくとも1回はリトライを試みる
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
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
    // 実際の gh api の since フィルタを模擬する（created_at >= since のみ返す）
    msgPoll._setGhApiComments((repo, issue, since) => {
      const filtered = since ? allComments.filter(c => c.created_at >= since) : allComments;
      return { status: 0, stdout: JSON.stringify(filtered) };
    });

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);

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
    msgPoll._setGhApiComments((repo, issue, since) => {
      const filtered = since ? allComments.filter(c => c.created_at >= since) : allComments;
      return { status: 0, stdout: JSON.stringify(filtered) };
    });
    msgPoll._setSleep(async () => {});

    const r1 = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
    const found1 = await msgPoll.runWaitMode(r1);
    assert.equal(found1, true);
    assert.deepEqual(r1.lines, ['NEW_MESSAGE:10']);

    // 次回の --wait 呼び出し（新しい main() 実行）で残りの1件が返る
    const r2 = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--wait', '30']);
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

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:1', 'NEW_MESSAGE:2']);
  });
});

test('scanOnce: state.since が非文字列（破損したstate由来）でもカーソルが固着せず進む（worker モード）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const statePath = msgPoll.statePath(workspace, 'my-worker');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // 旧バージョン由来などで since が文字列でない（例: 空オブジェクト）壊れた state を模擬する
    fs.writeFileSync(statePath, JSON.stringify({ since: {}, seenIds: [] }), 'utf8');

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:1']);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.since, '2026-07-07T12:00:00Z');
  });
});

test('scanOnce: state.since[issue] が非文字列でもカーソルが固着せず進む（orchestrator モード）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"my-worker"} -->\nA', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.gh-maestro', 'workers.json'),
      JSON.stringify({ 'my-worker': { issue: '1' } }),
      'utf8'
    );

    const statePath = msgPoll.statePath(workspace, 'orchestrator');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ since: { 1: 12345 }, seenIds: [] }), 'utf8');

    const r = msgPoll.main(['orchestrator', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:1:1']);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.since['1'], '2026-07-07T12:00:00Z');
  });
});

test('scanOnce: created_at が欠落したコメントは新着候補から除外される（クラッシュ・不正ソート防止）', () => {
  withTempDir(workspace => {
    msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgPoll._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nA', created_at: undefined },
        { id: 2, body: '<!-- gh-maestro {"v":1,"to":"my-worker","from":"orchestrator"} -->\nB', created_at: '2026-07-07T12:00:00Z' },
      ]),
    }));

    const r = msgPoll.main(['my-worker', '--issue', '1', '--workspace', workspace, '--once']);
    r.scanOnce();
    assert.deepEqual(r.lines, ['NEW_MESSAGE:2']);
  });
});

// ── reset mocks ─────────────────────────────────────────────────────────────

msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));
