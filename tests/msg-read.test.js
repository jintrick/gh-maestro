'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgRead = require('../scripts/msg-read');
const { PLAN_MARKER } = require('../scripts/shared/plan-comment');

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
  const r = msgRead.main(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-read.js'));
  assert.ok(r.lines.join('\n').includes('--plan'));
  assert.ok(r.lines.join('\n').includes('--issue'));
  assert.equal(r.errLines.length, 0);
});

test('-h が usage を返して code 0', () => {
  const r = msgRead.main(['-h']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-read.js'));
  assert.ok(r.lines.join('\n').includes('--plan'));
  assert.equal(r.errLines.length, 0);
});

// ── 引数エラー（通常モード） ────────────────────────────────────────────────

test('commentId なしは code 1', () => {
  const r = msgRead.main([]);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.join('\n').includes('msg-read.js'));
});

test('余剰な位置引数は code 1（黙って無視しない）', () => {
  const r = msgRead.main(['123', 'extra']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('予期しない位置引数')));
});

test('未知のフラグは code 1（黙って無視しない）', () => {
  const r = msgRead.main(['123', '--bogus']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('未知のフラグ')));
});

test('単独の未知フラグは commentId として受理されず code 1', () => {
  const r = msgRead.main(['--bogus']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('未知のフラグ')));
});

// ── 引数エラー（--plan モード） ─────────────────────────────────────────────

test('--plan 指定時に --issue なしは code 1', () => {
  const r = msgRead.main(['--plan']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--issue <N> が必須です')));
});

test('--plan 指定時に --issue が正の整数でない場合は code 1', () => {
  const r1 = msgRead.main(['--plan', '--issue', '0']);
  assert.equal(r1.code, 1);
  assert.ok(r1.errLines.some(l => l.includes('--issue は正の整数で指定してください')));

  const r2 = msgRead.main(['--plan', '--issue', '-5']);
  assert.equal(r2.code, 1);
  assert.ok(r2.errLines.some(l => l.includes('--issue は正の整数で指定してください')));

  const r3 = msgRead.main(['--plan', '--issue', 'abc']);
  assert.equal(r3.code, 1);
  assert.ok(r3.errLines.some(l => l.includes('--issue は正の整数で指定してください')));
});

test('--plan 指定時に位置引数（commentId）が渡された場合は code 1', () => {
  const r = msgRead.main(['--plan', '--issue', '42', '12345']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--plan 指定時は commentId を指定できません')));
});

// ── stripMarker ─────────────────────────────────────────────────────────────

test('stripMarker がマーカー行を除去する', () => {
  const body = '<!-- gh-maestro {"v":1,"to":"worker","from":"orchestrator"} -->\nHello world';
  assert.equal(msgRead.stripMarker(body), 'Hello world');
});

test('stripMarker がマーカーなしの本文をそのまま返す', () => {
  const body = 'Just a normal message';
  assert.equal(msgRead.stripMarker(body), 'Just a normal message');
});

test('stripMarker が空文字列をそのまま返す', () => {
  assert.equal(msgRead.stripMarker(''), '');
});

test('stripMarker が空白を含むマーカーも除去する', () => {
  const body = '<!--  gh-maestro  {"v":1,"to":"x","from":"y"}  -->\nThe real body';
  assert.equal(msgRead.stripMarker(body), 'The real body');
});

test('stripMarker が通常の HTML コメントは除去しない', () => {
  const body = '<!-- regular comment -->\nbody text';
  assert.equal(msgRead.stripMarker(body), '<!-- regular comment -->\nbody text');
});

// ── メイン（通常モード） ────────────────────────────────────────────────────

test('成功時に本文を出力して code 0', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment(() => ({
      status: 0,
      stdout: '<!-- gh-maestro {"v":1,"to":"worker","from":"orchestrator"} -->\nHello from orchestrator',
    }));

    const r = msgRead.main(['123456789', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'Hello from orchestrator');
  });
});

test('非plan時に --issue を渡すと _ghApiComment に issue が渡される', () => {
  withTempDir(workspace => {
    let receivedIssue = null;
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment((repo, commentId, issue) => {
      receivedIssue = issue;
      return {
        status: 0,
        stdout: 'comment with fallback issue',
      };
    });

    const r = msgRead.main(['123456789', '--issue', '99', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(receivedIssue, '99');
    assert.equal(r.lines[0], 'comment with fallback issue');
  });
});

test('マーカーなし本文はそのまま出力される', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment(() => ({
      status: 0,
      stdout: 'Plain comment without marker',
    }));

    const r = msgRead.main(['123456789', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'Plain comment without marker');
  });
});

test('gh api 失敗時に code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgRead._setGhApiComment(() => ({
      status: 1,
      stderr: 'gh: Not Found',
    }));

    const r = msgRead.main(['999999999', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメントの読み出しに失敗')));
  });
});

test('repo 解決失敗時に code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 1, stderr: 'gh: command not found' }));

    const r = msgRead.main(['123456789', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('リポジトリを解決できません')));
  });
});

// ── メイン（--plan モード） ─────────────────────────────────────────────────

test('--plan: 計画コメントが1件存在するとき本文をマーカー除去して出力し code 0', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments((repo, issue) => {
      assert.equal(repo, 'owner/repo');
      assert.equal(issue, '42');
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: 1, body: '通常コメント', pin: null },
          { id: 2, body: `${PLAN_MARKER}\n# 計画のタイトル\n計画の詳細内容`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
          { id: 3, body: '他目的pin', pin: { pinned_at: '2026-01-01T00:00:00Z' } },
        ]),
      };
    });

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], '# 計画のタイトル\n計画の詳細内容');
  });
});

test('--plan: 1行目にマーカーがある計画と、2行目以降にマーカーがある引用コメントが混在しても正しく1件の計画を認識する', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: `${PLAN_MARKER}\n# 本物の計画`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
        { id: 2, body: `> ${PLAN_MARKER}\n> 計画を引用したコメント`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
        { id: 3, body: `前置テキスト ${PLAN_MARKER}\n途中にマーカーがあるコメント`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
      ]),
    }));

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], '# 本物の計画');
  });
});

test('--plan: マーカーが2行目や行途中にあるコメントのみの場合は計画なしで code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: `> ${PLAN_MARKER}\n引用のみ`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
        { id: 2, body: `prefix ${PLAN_MARKER}`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
      ]),
    }));

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue #42 に計画コメントが見つかりません')));
  });
});

test('--plan: --paginate --slurp 形式のコメント一覧でも正しく計画を取得できる', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        [{ id: 1, body: 'コメント1', pin: null }],
        [{ id: 2, body: `${PLAN_MARKER}\nページネーション計画`, pin: { pinned_at: '2026-01-01' } }],
      ]),
    }));

    const r = msgRead.main(['--plan', '--issue', '10', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'ページネーション計画');
  });
});

test('--plan: 計画コメントが0件のときはエラーメッセージを出力して code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: '通常コメント', pin: null },
        { id: 2, body: '他目的pin', pin: { pinned_at: '2026-01-01T00:00:00Z' } },
      ]),
    }));

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue #42 に計画コメントが見つかりません')));
  });
});

test('--plan: 計画コメントが複数（2件以上）存在するときはエラーメッセージを出力して code 1（フェイルクローズ）', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        { id: 1, body: `${PLAN_MARKER}\n計画1`, pin: { pinned_at: '2026-01-01' } },
        { id: 2, body: `${PLAN_MARKER}\n計画2`, pin: { pinned_at: '2026-01-02' } },
      ]),
    }));

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue #42 に計画コメントが複数存在します（2件）')));
  });
});

test('--plan: コメント一覧取得失敗時は code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 1,
      stderr: 'gh: Not Found',
    }));

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメント一覧の取得に失敗しました')));
  });
});

test('--plan: コメント一覧のJSONパース失敗時は code 1', () => {
  withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhListComments(() => ({
      status: 0,
      stdout: 'not json',
    }));

    const r = msgRead.main(['--plan', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメント一覧のJSONパースに失敗しました')));
  });
});
