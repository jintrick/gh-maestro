'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const msgSend = require('../scripts/msg-send');

// msg-send.js は成功時にensureInboxSupervisorRunning()を呼ぶ（best-effort）。
// テストでは実プロセスをspawnしないよう常にモックする（test-process-spawn-safety参照）。
require('../scripts/shared/ensure-inbox-supervisor')._setSpawn(() => {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
});

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 本文は位置引数で渡せない（--body-file / --stdin のいずれか必須）。テストでは
// 実stdinを使わず、readStdinFn/isStdinTTYを注入して --stdin 経路を検証する。
function stdinIO(text) {
  return { readStdinFn: () => text, isStdinTTY: () => false };
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

test('--body-file も --stdin も無いとエラーになる（本文は位置引数で渡せない）', () => {
  const r = msgSend.main(['worker-1']);
  assert.equal(r.code, 1);
  assert.ok(r.errLines.some(l => l.includes('--body-file') && l.includes('--stdin')));
});

test('本文相当のトークンを位置引数で渡すとエラーになる（--stdinと併用しても拒否される）', () => {
  withTempDir(workspace => {
    const r = msgSend.main(['worker-1', 'これは本文のつもり', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('位置引数で渡せません')));
  });
});

test('--body-file と --stdin を両方指定するとエラーになる', () => {
  withTempDir(workspace => {
    const bodyFile = path.join(workspace, 'body.txt');
    fs.writeFileSync(bodyFile, 'from file', 'utf8');
    const r = msgSend.main(['worker-1', '--body-file', bodyFile, '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('from stdin'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('同時に指定できません')));
  });
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

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '99', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 0);
    assert.equal(capturedIssue, '99');
    assert.ok(capturedBody.includes('hello'));
    assert.ok(capturedBody.includes('"v":1'));
    assert.ok(capturedBody.includes('"to":"worker-1"'));
    assert.ok(r.lines[0].includes('github.com'));
  });
});

// ── --skill による送信先解決（〈issue + 役割〉→ workerName 逆引き） ──────────

function writeWorkersForSkill(workspace) {
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(
    path.join(ghDir, 'workers.json'),
    JSON.stringify({
      orchestrator: { paneId: '1' },
      'issue-42-investigate': { paneId: '10', agentId: 'reasonix', issue: 42, skill: 'gh-maestro-investigator' },
      'issue-42-implement': { paneId: '11', agentId: 'claude-ds', issue: 42, skill: 'gh-maestro-coder' },
    }, null, 2),
    'utf8'
  );
}

test('--skill: issue+役割で送信先workerNameを解決しマーカーの to に入れる', () => {
  withTempDir(workspace => {
    writeWorkersForSkill(workspace);
    let capturedBody = null;
    let capturedIssue = null;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedIssue = issue;
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/42#issuecomment-1\n' };
    });

    const r = msgSend.main(['--issue', '42', '--skill', 'gh-maestro-coder', '--workspace', workspace, '--stdin'], null, stdinIO('修正してください'));
    assert.equal(r.code, 0);
    assert.equal(capturedIssue, '42');
    assert.ok(capturedBody.includes('"to":"issue-42-implement"'), '解決された workerName が to に入る');
    assert.ok(capturedBody.includes('修正してください'));
  });
});

test('--skill: 同一issueでも役割で区別して別ワーカーに解決する', () => {
  withTempDir(workspace => {
    writeWorkersForSkill(workspace);
    let capturedBody = null;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/42#issuecomment-1\n' };
    });

    const r = msgSend.main(['--issue', '42', '--skill', 'gh-maestro-investigator', '--workspace', workspace, '--stdin'], null, stdinIO('追加調査を'));
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"to":"issue-42-investigate"'));
  });
});

test('--skill: --issue が無いとエラー', () => {
  withTempDir(workspace => {
    writeWorkersForSkill(workspace);
    const r = msgSend.main(['--skill', 'gh-maestro-coder', '--workspace', workspace, '--stdin'], null, stdinIO('本文'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('--issue が必要')));
  });
});

test('--skill: 該当ワーカーが無いと候補解決エラーで code 1', () => {
  withTempDir(workspace => {
    writeWorkersForSkill(workspace);
    const r = msgSend.main(['--issue', '99', '--skill', 'gh-maestro-coder', '--workspace', workspace, '--stdin'], null, stdinIO('本文'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('見つかりません')));
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

    const r = msgSend.main(['worker-1', '--stdin', '--workspace', workspace], { ISSUE: '42' }, stdinIO('hello'));
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

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '99', '--workspace', workspace], { ISSUE: '42' }, stdinIO('hello'));
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

    const r = msgSend.main(['worker-1', '--stdin', '--workspace', workspace], null, stdinIO('hello'));
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

    const r = msgSend.main(['worker-1', '--stdin', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue番号を解決できません')));
  });
});

test('orchestrator 宛で --issue も env ISSUE も無ければ code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const r = msgSend.main(['orchestrator', '--stdin', '--workspace', workspace], {}, stdinIO('hello'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('Issue番号を解決できません')));
  });
});

// ── from フィールド ─────────────────────────────────────────────────────────

test('ワーカーコンテキスト: 本文だけで from=ワーカー名 / to=orchestrator / issueはワーカー名から導出', () => {
  withTempDir(workspace => {
    let capturedBody = null;
    let capturedIssue = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedIssue = issue;
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    // ゼロノブ: 本文だけ渡す。identity/宛先/Issueは環境から確定される。
    const r = msgSend.main(
      ['--stdin', '--workspace', workspace],
      { GH_MAESTRO_WORKER: 'issue-1-fix' },
      stdinIO('hello'),
    );
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"from":"issue-1-fix"'));
    assert.ok(capturedBody.includes('"to":"orchestrator"'));
    assert.equal(String(capturedIssue), '1');
    assert.ok(capturedBody.includes('> hello'));
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

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], {}, stdinIO('hello'));
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
      ['worker-1', '--stdin', '--from', 'issue-52-worker', '--issue', '1', '--workspace', workspace],
      {},
      stdinIO('hello'),
    );
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('"from":"issue-52-worker"'));
  });
});

test('ワーカーコンテキスト: --from を渡しても無視され from はワーカー識別に固定される（成りすまし防止）', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(
      ['--stdin', '--from', 'orchestrator', '--issue', '1', '--workspace', workspace],
      { GH_MAESTRO_WORKER: 'issue-1-worker' },
      stdinIO('hello'),
    );
    assert.equal(r.code, 0);
    // --from orchestrator を渡しても、ワーカーは orchestrator に化けられない
    assert.ok(capturedBody.includes('"from":"issue-1-worker"'));
    assert.ok(!capturedBody.includes('"from":"orchestrator"'));
  });
});

test('ワーカーコンテキスト: --skill（orchestrator専用）はエラーで拒否される', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    const r = msgSend.main(
      ['--skill', 'gh-maestro-investigator', '--issue', '1', '--workspace', workspace, '--stdin'],
      { GH_MAESTRO_WORKER: 'issue-1-investigate' },
      stdinIO('報告本文'),
    );
    assert.equal(r.code, 1);
    assert.ok(r.errLines.join('\n').includes('--skill は orchestrator 専用'));
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

    msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('hello world'));

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

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('リポジトリを解決できません')));
  });
});

test('gh issue comment 失敗時に code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment(() => ({ status: 1, stderr: 'gh: rate limit' }));

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('コメント投稿に失敗')));
  });
});

test('gh issue comment が空URLを返した場合 code 1', () => {
  withTempDir(workspace => {
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment(() => ({ status: 0, stdout: '' }));

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('hello'));
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

    const r = msgSend.main(
      ['worker-1', '--raw', '--stdin', '--execution-id', 'architect-1', '--issue', '1', '--workspace', workspace],
      null,
      stdinIO('# Plan\n\nKeep this Markdown'),
    );
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

    const r = msgSend.main(
      ['worker-1', '--raw', '--stdin', '--execution-id', 'architect-1', '--issue', '1', '--workspace', workspace],
      null,
      stdinIO('same plan'),
    );
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

test('--body-file と本文相当の位置引数を両方指定するとエラーになる', () => {
  withTempDir(workspace => {
    const bodyFile = path.join(workspace, 'body.txt');
    fs.writeFileSync(bodyFile, 'body-file content', 'utf8');

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));

    const r = msgSend.main(['worker-1', '--body-file', bodyFile, 'positional body', '--issue', '1', '--workspace', workspace]);
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('位置引数で渡せません')));
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

// ── --stdin（本件バグ修正の核）────────────────────────────────────────────

test('--stdin から読み込んだ内容が本文として使われる', () => {
  withTempDir(workspace => {
    let capturedBody = null;

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('from stdin'));
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('from stdin'));
  });
});

test('--stdin指定時、標準入力がTTYだとエラーで即終了する（ハング防止）', () => {
  withTempDir(workspace => {
    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, {
      readStdinFn: () => { throw new Error('readStdinFn should not be called when stdin is a TTY'); },
      isStdinTTY: () => true,
    });
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('TTY')));
  });
});

test('--stdin経由ならバッククォート・ドル記号を含む本文もそのまま投稿できる（本件インシデントの再現防止）', () => {
  withTempDir(workspace => {
    let capturedBody = null;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/1#issuecomment-1\n' };
    });

    const dangerousBody = '`AUTHORITY_TO_COLUMN` を参照し、$ISSUE を使う';
    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO(dangerousBody));
    assert.equal(r.code, 0);
    assert.ok(capturedBody.includes('`AUTHORITY_TO_COLUMN`'));
    assert.ok(capturedBody.includes('$ISSUE'));
  });
});

// ── 戻り値の注入リセット（後続テストのため） ───────────────────────────────

test('injected gh functions can be reset', () => {
  // デフォルトの実装に戻す（副作用: spawnSync が使われるが、CLIモード実行なしなら問題なし）
  msgSend._setGhRepoView(() => ({ status: 0, stdout: 'reset/repo\n' }));
  msgSend._setGhIssueComment(() => ({ status: 0, stdout: 'reset-url\n' }));

  withTempDir(workspace => {
    const r = msgSend.main(['worker-1', '--stdin', '--issue', '1', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'reset-url');
  });
});
