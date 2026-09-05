'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgRead = require('../../scripts/msg-read');
const { PLAN_MARKER } = require('../../scripts/shared/plan-comment');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withWorkerName(workerName, fn) {
  const previous = process.env.GH_MAESTRO_WORKER;
  if (workerName == null) delete process.env.GH_MAESTRO_WORKER;
  else process.env.GH_MAESTRO_WORKER = workerName;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.GH_MAESTRO_WORKER;
    else process.env.GH_MAESTRO_WORKER = previous;
  }
}

// ── --help / -h ────────────────────────────────────────────────────────────

test('--help が usage を返して code 0', () => {
  const r = msgRead.main(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-read.js'));
  assert.ok(r.lines.join('\n').includes('--plan'));
  assert.ok(r.lines.join('\n').includes('--issue-context'));
  assert.ok(r.lines.join('\n').includes('--issue'));
  assert.equal(r.errLines.length, 0);
});

test('-h が usage を返して code 0', () => {
  const r = msgRead.main(['-h']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-read.js'));
  assert.ok(r.lines.join('\n').includes('--plan'));
  assert.ok(r.lines.join('\n').includes('--issue-context'));
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

// ── 引数エラー（--issue-context モード） ──────────────────────────────────

test('--issue-context 指定時に --issue なしは code 1', () => {
  const r = msgRead.main(['--issue-context']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--issue-context 指定時は --issue <N> が必須です')));
});

test('--issue-context 指定時に --issue が正の整数でない場合は code 1', () => {
  const r = msgRead.main(['--issue-context', '--issue', '0']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--issue は正の整数で指定してください')));
});

test('--issue-context 指定時に位置引数（commentId）が渡された場合は code 1', () => {
  const r = msgRead.main(['--issue-context', '--issue', '42', '12345']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--issue-context 指定時は commentId を指定できません')));
});

test('--plan と --issue-context は同時指定できない', () => {
  const r = msgRead.main(['--plan', '--issue-context', '--issue', '42']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--plan と --issue-context は同時指定できません')));
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

// ── メイン（--issue-context モード） ───────────────────────────────────────

test('--issue-context: Issue本文と自分宛て・計画コメントだけを出力する', () => {
  withWorkerName('worker-self', () => withTempDir(workspace => {
    msgRead._setGhRepoView((opts) => {
      assert.equal(opts.cwd, workspace);
      return { status: 0, stdout: 'owner/repo\n' };
    });
    msgRead._setGhApiIssue((repo, issue, opts) => {
      assert.equal(repo, 'owner/repo');
      assert.equal(issue, '42');
      assert.equal(opts.cwd, workspace);
      return {
        status: 0,
        stdout: JSON.stringify({ title: 'Issue title', body: 'Issue requirements' }),
      };
    });
    msgRead._setGhListComments((repo, issue, opts) => {
      assert.equal(repo, 'owner/repo');
      assert.equal(issue, '42');
      assert.equal(opts.cwd, workspace);
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            id: 1,
            author_association: 'OWNER',
            body: '<!-- gh-maestro {"v":1,"to":"worker-self","from":"orchestrator"} -->\nApproved for this worker',
          },
          {
            id: 2,
            body: '<!-- gh-maestro {"v":1,"to":"other-worker","from":"orchestrator"} -->\nNot for this worker',
          },
          { id: 3, body: 'Third-party comment without a marker' },
          { id: 5, body: '<!-- gh-maestro {broken json -->\nMalformed marker' },
          {
            id: 4,
            author_association: 'OWNER',
            body: `${PLAN_MARKER}\n# Approved plan\nPlan details`,
            pin: { pinned_at: '2026-01-01T00:00:00Z' },
          },
        ]),
      };
    });

    const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 0);
    const output = r.lines.join('\n');
    assert.match(output, /Issue title/);
    assert.match(output, /Issue requirements/);
    assert.match(output, /Approved for this worker/);
    assert.match(output, /# Approved plan/);
    assert.match(output, /Plan details/);
    assert.doesNotMatch(output, /Not for this worker/);
    assert.doesNotMatch(output, /Third-party comment without a marker/);
    assert.doesNotMatch(output, /Malformed marker/);
    assert.doesNotMatch(output, /gh-maestro/);
  }));
});

test('--issue-context: GH_MAESTRO_WORKER がない場合は取得処理を実行せず code 1', () => {
  withWorkerName(null, () => withTempDir(workspace => {
    let issueCalled = false;
    let commentsCalled = false;
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhApiIssue(() => {
      issueCalled = true;
      return { status: 0, stdout: '{}' };
    });
    msgRead._setGhListComments(() => {
      commentsCalled = true;
      return { status: 0, stdout: '[]' };
    });

    const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('GH_MAESTRO_WORKER')));
    assert.equal(issueCalled, false);
    assert.equal(commentsCalled, false);
  }));
});

test('filterIssueCommentBodies: write権限を持たない投稿者のメッセージと計画を除外する', () => {
  const comments = [
    {
      id: 1,
      author_association: 'CONTRIBUTOR',
      body: '<!-- gh-maestro {"v":1,"to":"worker-self","from":"orchestrator"} -->\nthird-party message',
    },
    {
      id: 2,
      author_association: 'NONE',
      body: `${PLAN_MARKER}\nthird-party plan`,
      pin: { pinned_at: '2026-01-01T00:00:00Z' },
    },
    {
      id: 3,
      author_association: 'MEMBER',
      body: '<!-- gh-maestro {"v":1,"to":"worker-self","from":"orchestrator"} -->\ntrusted message',
    },
    {
      id: 4,
      body: '<!-- gh-maestro {"v":1,"to":"worker-self","from":"orchestrator"} -->\nmissing association',
    },
  ];

  assert.deepEqual(msgRead.filterIssueCommentBodies(comments, 'worker-self'), ['trusted message']);
});

test('--issue-context: GH_MAESTRO_WORKER=orchestrator の場合はワーカーではないため code 1（Issue #384）', () => {
  withWorkerName('orchestrator', () => withTempDir(workspace => {
    let issueCalled = false;
    let commentsCalled = false;
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhApiIssue(() => {
      issueCalled = true;
      return { status: 0, stdout: '{}' };
    });
    msgRead._setGhListComments(() => {
      commentsCalled = true;
      return { status: 0, stdout: '[]' };
    });

    const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('GH_MAESTRO_WORKER')));
    assert.equal(issueCalled, false);
    assert.equal(commentsCalled, false);
  }));
});

test('--issue-context: Issue本文の取得失敗時はコメント一覧を取得せず code 1', () => {
  withWorkerName('worker-self', () => withTempDir(workspace => {
    let commentsCalled = false;
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhApiIssue(() => ({ status: 1, stderr: 'gh: Not Found' }));
    msgRead._setGhListComments(() => {
      commentsCalled = true;
      return { status: 0, stdout: '[]' };
    });

    const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue本文の取得に失敗しました')));
    assert.equal(commentsCalled, false);
  }));
});

test('--issue-context: Issue本文のJSONが不正な場合は code 1', () => {
  withWorkerName('worker-self', () => withTempDir(workspace => {
    let commentsCalled = false;
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhApiIssue(() => ({ status: 0, stdout: 'not json' }));
    msgRead._setGhListComments(() => {
      commentsCalled = true;
      return { status: 0, stdout: '[]' };
    });

    const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue本文のJSONパースまたは形式検証に失敗しました')));
    assert.equal(commentsCalled, false);
  }));
});

test('--issue-context: コメント一覧のJSONが不正な場合は code 1', () => {
  withWorkerName('worker-self', () => withTempDir(workspace => {
    msgRead._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n' }));
    msgRead._setGhApiIssue(() => ({
      status: 0,
      stdout: JSON.stringify({ title: 'Issue title', body: 'Issue body' }),
    }));
    msgRead._setGhListComments(() => ({ status: 0, stdout: 'not json' }));

    const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメント一覧のJSONパースに失敗しました')));
  }));
});

test('--issue-context: gh apiのIssue取得argvとworkspaceを実装経由で検証する', () => {
  withWorkerName('worker-self', () => withTempDir(workspace => {
    const calls = [];
    msgRead._setSpawnSync((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args[0] === 'repo') return { status: 0, stdout: 'owner/repo\n' };
      return {
        status: 0,
        stdout: JSON.stringify({ title: 'Issue title', body: 'Issue body' }),
      };
    });
    msgRead._setGhListComments(() => ({ status: 0, stdout: '[]' }));
    msgRead._setGhRepoView(null);
    msgRead._setGhApiIssue(null);
    try {
      const r = msgRead.main(['--issue-context', '--issue', '42', '--workspace', workspace]);
      assert.equal(r.code, 0);
      assert.deepEqual(calls[0].args, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
      assert.deepEqual(calls[1].args, ['api', '--method', 'GET', 'repos/owner/repo/issues/42']);
      assert.equal(calls[1].opts.cwd, workspace);
    } finally {
      msgRead._setGhRepoView(null);
      msgRead._setGhApiIssue(null);
      msgRead._setSpawnSync(null);
    }
  }));
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
          { id: 2, author_association: 'OWNER', body: `${PLAN_MARKER}\n# 計画のタイトル\n計画の詳細内容`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
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
        { id: 1, author_association: 'OWNER', body: `${PLAN_MARKER}\n# 本物の計画`, pin: { pinned_at: '2026-01-01T00:00:00Z' } },
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
        [{ id: 2, author_association: 'OWNER', body: `${PLAN_MARKER}\nページネーション計画`, pin: { pinned_at: '2026-01-01' } }],
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
        { id: 1, author_association: 'OWNER', body: `${PLAN_MARKER}\n計画1`, pin: { pinned_at: '2026-01-01' } },
        { id: 2, author_association: 'OWNER', body: `${PLAN_MARKER}\n計画2`, pin: { pinned_at: '2026-01-02' } },
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
