'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msgSend = require('../scripts/msg-send');

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
  const r = msgSend.main(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-send.js'));
  assert.equal(r.errLines.length, 0);
});

test('-h が usage を返して code 0', () => {
  const r = msgSend.main(['-h']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.join('\n').includes('msg-send.js'));
  assert.equal(r.errLines.length, 0);
});

// ── 引数エラー ──────────────────────────────────────────────────────────────

test('recipient なしは usage を stderr にして code 1', () => {
  const r = msgSend.main([]);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.join('\n').includes('msg-send.js'));
});

test('本文なしは code 1', () => {
  const r = msgSend.main(['worker-1']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('メッセージ本文が必要')));
});

// ── issue 解決 ──────────────────────────────────────────────────────────────

test('--issue で指定した Issue が使われる', () => {
  withTempDir(workspace => {
    let capturedIssue = null;
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedIssue = issue;
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/99#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', 'hello', '--issue', '99', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(capturedIssue, '99');
    assert.ok(capturedBody.includes('hello'));
    assert.ok(capturedBody.includes('"v":1'));
    assert.ok(capturedBody.includes('"to":"worker-1"'));
    assert.ok(r.lines[0].includes('github.com'));
  });
});

test('env ISSUE で Issue が解決される', () => {
  withTempDir(workspace => {
    let capturedIssue = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedIssue = issue;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/42#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', 'hello', '--workspace', workspace], { ISSUE: '42' });
    assert.equal(r.code, 0);
    assert.equal(capturedIssue, '42');
  });
});

test('--issue が env ISSUE より優先される', () => {
  withTempDir(workspace => {
    let capturedIssue = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedIssue = issue;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/99#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', 'hello', '--issue', '99', '--workspace', workspace], { ISSUE: '42' });
    assert.equal(r.code, 0);
    assert.equal(capturedIssue, '99');
  });
});

test('workers.json から issue を解決する', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'worker-1': { issue: 55 } }, null, 2),
      'utf8'
    );

    let capturedIssue = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedIssue = issue;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/55#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', 'hello', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(capturedIssue, '55');
  });
});

test('workers.json に該当 worker が無い場合は code 1（フェイルクローズ）', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'other-worker': { issue: 1 } }, null, 2),
      'utf8'
    );

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const r = msgSend.main(['worker-1', 'hello', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue番号を解決できません')));
  });
});

test('orchestrator 宛で --issue も env ISSUE も無ければ code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const r = msgSend.main(['orchestrator', 'hello', '--workspace', workspace], {});
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue番号を解決できません')));
  });
});

// ── from フィールド ─────────────────────────────────────────────────────────

test('from は GH_MAESTRO_WORKER env が使われる', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(
      ['worker-1', 'hello', '--issue', '1', '--workspace', workspace],
      { GH_MAESTRO_WORKER: 'custom-worker', ISSUE: '1' }
    );
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"from":"custom-worker"'));
  });
});

test('from は GH_MAESTRO_WORKER 未設定時は orchestrator', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', 'hello', '--issue', '1', '--workspace', workspace], {});
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"from":"orchestrator"'));
  });
});

test('--from フラグで from が設定される', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(
      ['worker-1', 'hello', '--from', 'issue-52-worker', '--issue', '1', '--workspace', workspace],
      {}
    );
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"from":"issue-52-worker"'));
  });
});

test('--from フラグが GH_MAESTRO_WORKER env より優先される', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(
      ['worker-1', 'hello', '--from', 'explicit-worker', '--issue', '1', '--workspace', workspace],
      { GH_MAESTRO_WORKER: 'env-worker' }
    );
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"from":"explicit-worker"'));
  });
});

// ── マーカー ────────────────────────────────────────────────────────────────

test('マーカーが正しい形式で本文の前に付与される', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    msgSend.main(['worker-1', 'hello world', '--issue', '1', '--workspace', workspace]);

    const lines = capturedBody.split('\n');
    // 1行目がマーカー
    assert.ok(lines[0].startsWith('<!-- gh-maestro '));
    assert.ok(lines[0].includes('"v":1'));
    assert.ok(lines[0].includes('"to":"worker-1"'));
    assert.ok(lines[0].includes('"from":"orchestrator"'));
    // 人間用ヘッダーと本文（引用形式）が含まれる
    assert.ok(lines[1].includes('From:'));
    assert.ok(lines[3].includes('hello world'));
  });
});

// ── gh エラー ───────────────────────────────────────────────────────────────

test('gh repo view 失敗時に code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 1, stderr: 'gh: command not found' }));

    const r = msgSend.main(['worker-1', 'hello', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('リポジトリを解決できません')));
  });
});

test('gh issue comment 失敗時に code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment(() => ({ status: 1, stderr: 'gh: rate limit' }));

    const r = msgSend.main(['worker-1', 'hello', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメント投稿に失敗')));
  });
});

test('gh issue comment が空URLを返した場合 code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment(() => ({ status: 0, stdout: '' }));

    const r = msgSend.main(['worker-1', 'hello', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('URLが取得できません')));
  });
});

test('--raw は本文をそのまま投稿し、投稿成功時だけ実行を完了にする', () => {
  withTempDir(workspace => {
    const executions = require('../scripts/shared/execution-registry');
    executions.startExecution(workspace, { executionId: 'architect-1', issue: 1, workerName: 'worker-1', skill: 'gh-maestro-architect' });
    let capturedBody = null;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', '# Plan\n\nKeep this Markdown', '--raw', '--execution-id', 'architect-1', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(capturedBody, '# Plan\n\nKeep this Markdown');
    assert.equal(executions.readRegistry(workspace)['architect-1'].status, 'completed');
  });
});

test('完了済み execution-id の再試行は Issue コメントを重複投稿しない', () => {
  withTempDir(workspace => {
    const executions = require('../scripts/shared/execution-registry');
    executions.startExecution(workspace, { executionId: 'architect-1', issue: 1, workerName: 'worker-1', skill: 'gh-maestro-architect' });
    executions.markCommentResult(workspace, 'architect-1', { commentUrl: 'https://example.test/existing-comment' });
    let calls = 0;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment(() => { calls++; return { status: 0, stdout: 'unexpected\n' }; });

    const r = msgSend.main(['worker-1', 'same plan', '--raw', '--execution-id', 'architect-1', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'https://example.test/existing-comment');
    assert.equal(calls, 0);
  });
});

// ── --body-file ──────────────────────────────────────────────────────────

test('--body-file で指定したファイルの内容が本文として使われる', () => {
  withTempDir(workspace => {
    const bodyFile = path.join(workspace, 'body.txt');
    fs.writeFileSync(bodyFile, 'hello from file', 'utf8');

    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', '--body-file', bodyFile, '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('hello from file'));
  });
});

test('--body-file と位置引数の本文が両方指定された場合、--body-file が優先される', () => {
  withTempDir(workspace => {
    const bodyFile = path.join(workspace, 'body.txt');
    fs.writeFileSync(bodyFile, 'body-file content', 'utf8');

    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', '--body-file', bodyFile, 'positional body', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('body-file content'));
    assert.ok(!capturedBody.includes('positional body'));
  });
});

test('--body-file のファイルが存在しない場合にエラーになる', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const r = msgSend.main(['worker-1', '--body-file', '/nonexistent/path.txt', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('--body-file の読み込みに失敗')));
  });
});

test('改行・クォート・バックスラッシュを含む本文が --body-file 経由で正しく渡る', () => {
  withTempDir(workspace => {
    const specialBody = "line1\nline2\nit's \"quoted\"\npath\\to\\file";
    const bodyFile = path.join(workspace, 'body.txt');
    fs.writeFileSync(bodyFile, specialBody, 'utf8');

    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', '--body-file', bodyFile, '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 0);
    // 改行が > 引用形式に変換された全文が正しく渡っている
    const transformedBody = "line1\n> line2\n> it's \"quoted\"\n> path\\to\\file";
    assert.ok(capturedBody.includes(transformedBody));
  });
});

test('--body-file に空ファイルを指定した場合は本文なしエラーになる', () => {
  withTempDir(workspace => {
    const bodyFile = path.join(workspace, 'empty.txt');
    fs.writeFileSync(bodyFile, '', 'utf8');

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const r = msgSend.main(['worker-1', '--body-file', bodyFile, '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('メッセージ本文が必要')));
  });
});

// ── 戻り値の注入リセット（後続テストのため） ───────────────────────────────

test('injected gh functions can be reset', () => {
  // デフォルトの実装に戻す（副作用: spawnSync が使われるが、CLIモード実行なしなら問題なし）
  msgSend._setGhRepoView(() => ({ status: 0, stdout: 'reset/repo\n' }));
  msgSend._setGhIssueComment(() => ({ status: 0, stdout: 'reset-url\n' }));

  withTempDir(workspace => {
    const r = msgSend.main(['worker-1', 'hello', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'reset-url');
  });
});
