'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgPoll = require('../scripts/msg-poll');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

test('readState が since が文字列でない場合にデフォルトを返す', () => {
  withTempDir(workspace => {
    const sp = msgPoll.statePath(workspace, 'test-worker');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ since: 123, seenIds: [1] }), 'utf8');

    const state = msgPoll.readState(workspace, 'test-worker');
    assert.equal(state.since, null);
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

// ── reset mocks ─────────────────────────────────────────────────────────────

msgPoll._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
msgPoll._setGhApiComments(() => ({ status: 0, stdout: JSON.stringify([]) }));
