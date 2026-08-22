'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const msgSend = require('../scripts/msg-send');
const workerLiveness = require('../scripts/shared/worker-liveness');
const processLifecycle = require('../scripts/process-lifecycle');
const closedPrGuard = require('../scripts/shared/closed-pr-guard');

// 稼働中ワーカーへの拒否ガード（Issue #263）のテストは worker-liveness を直接モックする。
// msg-send.js は inbox-supervisor.js のような独自の注入ポイントを持たず、実体（シングルトン
// モジュール）を直接呼ぶため、実体側のセッターで差し替える（tests/worker-liveness.test.js と
// 同じパターン）。実プロセスには一切触れない（.claude/rules/test-process-spawn-safety.md）。
afterEach(() => {
  workerLiveness._setIsProcessAlive(processLifecycle.isProcessAlive);
  workerLiveness._setVerifyProcessIdentity(processLifecycle.verifyProcessIdentity);
  closedPrGuard._setListFn(() => ({ status: 0, stdout: '[]', stderr: '' }));
});

// msg-send.js は成功時にensureInboxSupervisorRunning()を呼ぶ（best-effort）。
// テストでは実プロセスをspawnせず外部照会も行わないようモックする（test-process-spawn-safety参照）。
const ensureInboxSupervisor = require('../scripts/shared/ensure-inbox-supervisor');
ensureInboxSupervisor._setSpawn(() => {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
});
ensureInboxSupervisor._setFindRunningInstance(() => null);
ensureInboxSupervisor._setIsResidentLeaseLive(() => false);
ensureInboxSupervisor._setFindSessionRootPid(() => 12345);
closedPrGuard._setListFn(() => ({ status: 0, stdout: '[]', stderr: '' }));


// ワーカー起動コンテキストでは GH_MAESTRO_WORKER / GH_MAESTRO_WORKSPACE が注入され、
// msg-send.js が「ワーカー扱い」になったり resolveWorkspace が --workspace 引数を
// 無視したりして、テストが明示的に渡した一時dirと期待を踏み外す。テストは実ワークスペースの
// 状態を触らない前提のため、この2変数を退避して外す（終了時に復元）。
const SAVED_MAESTRO_ENV = {};
for (const k of ['GH_MAESTRO_WORKER', 'GH_MAESTRO_WORKSPACE']) {
  if (process.env[k] !== undefined) SAVED_MAESTRO_ENV[k] = process.env[k];
  delete process.env[k];
}
process.on('exit', () => {
  for (const [k, v] of Object.entries(SAVED_MAESTRO_ENV)) process.env[k] = v;
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

test('クローズ済みPRのブランチ宛て送信はコメント投稿前に拒否する', () => {
  withTempDir(workspace => {
    let postCalls = 0;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    closedPrGuard._setListFn((repo, branch) => {
      assert.equal(repo, 'test/repo');
      assert.equal(branch, 'issue-42-coder-fix');
      return { status: 0, stdout: JSON.stringify([{ number: 376, state: 'CLOSED' }]) };
    });
    msgSend._setGhIssueComment(() => { postCalls++; return { status: 0, stdout: 'unexpected' }; });

    const r = msgSend.main(
      ['issue-42-coder-fix', '--stdin', '--issue', '42', '--workspace', workspace],
      null,
      stdinIO('追加指示'),
    );
    assert.equal(r.code, 1);
    assert.equal(postCalls, 0);
    assert.match(r.errLines.join('\n'), /issue-42-coder-fix/);
    assert.match(r.errLines.join('\n'), /#376/);
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
      'issue-42-investigate': { paneId: '10', agentId: 'reasonix', issue: 42, skill: 'gh-maestro-diagnostician' },
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

    const r = msgSend.main(['--issue', '42', '--skill', 'gh-maestro-diagnostician', '--workspace', workspace, '--stdin'], null, stdinIO('追加調査を'));
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

test('--skill と recipient位置引数の併用は本文ではなく宛先のエラーになる', () => {
  withTempDir(workspace => {
    writeWorkersForSkill(workspace);
    const r = msgSend.main(
      ['issue-42-implement', '--issue', '42', '--skill', 'gh-maestro-coder', '--workspace', workspace, '--stdin'],
      null,
      stdinIO('本文'),
    );
    assert.equal(r.code, 1);
    const error = r.errLines.join('\n');
    assert.match(error, /宛先/);
    assert.match(error, /併用できません/);
    assert.doesNotMatch(error, /本文は位置引数で渡せません/);
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
      ['--skill', 'gh-maestro-diagnostician', '--issue', '1', '--workspace', workspace, '--stdin'],
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

// ── 稼働中で未報告のワーカーへの送信拒否（Issue #263） ────────────────────────

function writeBusyWorker(workspace, { workerName = 'issue-9-fix', issue = 9, pid = 42424 } = {}) {
  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(
    path.join(ghDir, 'workers.json'),
    JSON.stringify({
      [workerName]: { pid, startTime: '2026-01-01T00:00:00.000Z', agentId: 'agy', issue },
    }, null, 2),
    'utf8'
  );
}

function mockCommentsResponse(comments) {
  return () => ({ status: 0, stdout: JSON.stringify(comments), stderr: '' });
}

test('稼働中で未報告のワーカー宛て送信は投稿前に拒否され、GitHubに何も投稿されない（本文は退避され迂回路も明示される）', () => {
  withTempDir(workspace => {
    writeBusyWorker(workspace);
    workerLiveness._setIsProcessAlive(() => true);
    workerLiveness._setVerifyProcessIdentity(() => ({ match: true }));

    let postCalls = 0;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhListComments(mockCommentsResponse([])); // まだ何も報告していない
    msgSend._setGhIssueComment(() => { postCalls++; return { status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-1\n' }; });

    const r = msgSend.main(['issue-9-fix', '--stdin', '--issue', '9', '--workspace', workspace], null, stdinIO('追加で直して'));
    // write-draft.js は実OSの一時ディレクトリへ書き込むため、workspace の withTempDir とは
    // 別に後始末する（draftPath を特定できた場合のみ削除）。
    let draftPath = null;
    try {
      assert.equal(r.code, 1);
      assert.equal(postCalls, 0, 'GitHubへの投稿が一切発生しないこと');
      const joined = r.errLines.join('\n');
      assert.ok(joined.includes('issue-9-fix'), 'ワーカー名が含まれること');
      assert.ok(joined.includes('報告'), '未報告である旨が含まれること');
      // (a) 迂回路を名指しで塞ぐ
      assert.ok(joined.includes('gh issue comment'), 'gh issue comment 迂回の禁止が含まれること');
      assert.ok(joined.includes('終了させて'), 'ワーカー終了による迂回の禁止が含まれること');
      // (b) 送ろうとした本文を退避先パスとともに残す
      const pathMatch = /本文は (\S+\.md) に退避しました/.exec(joined);
      assert.ok(pathMatch, `退避先パスが含まれること: ${joined}`);
      draftPath = pathMatch[1];
      assert.equal(fs.readFileSync(draftPath, 'utf8'), '追加で直して', '退避ファイルに元の本文がそのまま書かれていること');
      // (c) 統合して一度に送るよう促す（「送り直せ」だけで終わらせない）
      assert.ok(joined.includes('統合'), '報告と統合して一度に送る旨が含まれること');
      assert.ok(joined.includes('Issue #9'), 'ワーカーの報告先Issueが示されること');
    } finally {
      if (draftPath) fs.rmSync(draftPath, { force: true });
    }
  });
});

test('判定不能（起動時刻を特定できない）なら拒否せず通常どおり配送される', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workers.json'),
      JSON.stringify({ 'issue-9-fix': { pid: 42424, startTime: null, agentId: 'agy', issue: 9 } }, null, 2),
      'utf8'
    );
    workerLiveness._setIsProcessAlive(() => true);
    workerLiveness._setVerifyProcessIdentity(() => ({ match: true }));

    let listCommentsCalled = false;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhListComments(() => { listCommentsCalled = true; return { status: 0, stdout: '[]' }; });
    let capturedBody = null;
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-5\n' };
    });

    const r = msgSend.main(['issue-9-fix', '--stdin', '--issue', '9', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 0, `判定不能は拒否しないこと: ${r.errLines.join('\n')}`);
    assert.equal(listCommentsCalled, false, '起動時刻が無ければ報告確認自体を行わない');
    assert.ok(capturedBody && capturedBody.includes('hello'));
  });
});

test('判定不能（GitHub APIの取得に失敗）なら拒否せず通常どおり配送される', () => {
  withTempDir(workspace => {
    writeBusyWorker(workspace);
    workerLiveness._setIsProcessAlive(() => true);
    workerLiveness._setVerifyProcessIdentity(() => ({ match: true }));

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhListComments(() => ({ status: 1, stdout: '', stderr: 'gh: rate limit' }));
    let capturedBody = null;
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-6\n' };
    });

    const r = msgSend.main(['issue-9-fix', '--stdin', '--issue', '9', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 0, `判定不能は拒否しないこと: ${r.errLines.join('\n')}`);
    assert.ok(capturedBody && capturedBody.includes('hello'));
  });
});

test('判定不能（workers.json が解析不能）でも拒否せず通常どおり配送される（フェイルオープン維持）', () => {
  withTempDir(workspace => {
    const ghDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    // workers.json を解析不能にする。readWorkersRaw は throw し、checkWorkerBusyRejection の
    // catch が null に落として通す（Issue #275 項目1）。判定不能時のフェイルオープンは
    // 上記 docstring のとおり、拒否した場合の方が損害が大きい（指示が一切届かなくなる）。
    fs.writeFileSync(path.join(ghDir, 'workers.json'), '{ broken json');

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    let capturedBody = null;
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-8\n' };
    });

    const r = msgSend.main(['issue-9-fix', '--stdin', '--issue', '9', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 0, `解析不能は拒否しないこと: ${r.errLines.join('\n')}`);
    assert.ok(capturedBody && capturedBody.includes('hello'));
  });
});

test('稼働中でも既に報告済みのワーカー宛て送信は拒否されない', () => {
  withTempDir(workspace => {
    writeBusyWorker(workspace);
    workerLiveness._setIsProcessAlive(() => true);
    workerLiveness._setVerifyProcessIdentity(() => ({ match: true }));

    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    // 起動時刻(2026-01-01T00:00:00.000Z)より後にワーカー自身が報告済み
    msgSend._setGhListComments(mockCommentsResponse([
      {
        id: 1, created_at: '2026-01-01T00:05:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"issue-9-fix"} -->\n> 完了しました',
      },
    ]));
    let capturedBody = null;
    msgSend._setGhIssueComment((issue, body) => {
      capturedBody = body;
      return { status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-2\n' };
    });

    const r = msgSend.main(['issue-9-fix', '--stdin', '--issue', '9', '--workspace', workspace], null, stdinIO('次の指示'));
    assert.equal(r.code, 0, `居座りは拒否されないこと: ${r.errLines.join('\n')}`);
    assert.ok(capturedBody && capturedBody.includes('次の指示'));
  });
});

test('休止中（非生存）のワーカー宛て送信は影響を受けず通常どおり配送される', () => {
  withTempDir(workspace => {
    writeBusyWorker(workspace);
    workerLiveness._setIsProcessAlive(() => false); // 休止中

    let listCommentsCalled = false;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhListComments(() => { listCommentsCalled = true; return { status: 0, stdout: '[]' }; });
    msgSend._setGhIssueComment(() => ({ status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-3\n' }));

    const r = msgSend.main(['issue-9-fix', '--stdin', '--issue', '9', '--workspace', workspace], null, stdinIO('hello'));
    assert.equal(r.code, 0);
    assert.equal(listCommentsCalled, false, '休止中は報告確認自体を行わない（既存動作に影響しない）');
  });
});

test('ワーカーからorchestrator宛の報告はこのガードの対象外（常に許可される）', () => {
  withTempDir(workspace => {
    writeBusyWorker(workspace, { workerName: 'issue-9-fix' });
    // ワーカー自身が稼働中（自プロセス）でも、報告送信そのものは拒否されない
    workerLiveness._setIsProcessAlive(() => true);
    workerLiveness._setVerifyProcessIdentity(() => ({ match: true }));

    let postCalls = 0;
    msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
    msgSend._setGhListComments(() => { throw new Error('worker→orchestrator の報告では報告確認を呼んではならない'); });
    msgSend._setGhIssueComment(() => { postCalls++; return { status: 0, stdout: 'https://github.com/test/repo/issues/9#issuecomment-4\n' }; });

    const r = msgSend.main(['--stdin', '--workspace', workspace], { GH_MAESTRO_WORKER: 'issue-9-fix' }, stdinIO('完了しました'));
    assert.equal(r.code, 0);
    assert.equal(postCalls, 1);
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

// ── テスト実行中の実投稿防止ガード（Issue #202） ─────────────────────────────
// 実障害: worker-exit-hook.js の実spawnテストがワーカー文脈の環境変数を子へ継承し、
// msg-send.js が実ワークスペース・実Issueへ偽の異常終了通知を投稿した。テスト側の
// envクリーン漏れに依存しない多層防御として、実 _ghIssueComment が NODE_TEST_CONTEXT
// 検出時に gh を一切呼ばずに投稿を拒否することを検証する。

test('testContextPostBlockReason: NODE_TEST_CONTEXT 有無で null / 理由文字列を返す', () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(msgSend.testContextPostBlockReason(), null);
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    assert.match(msgSend.testContextPostBlockReason(), /NODE_TEST_CONTEXT/);
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('NODE_TEST_CONTEXT 下では実投稿を拒否する（構造的ガード）', () => {
  // このテスト自体は node --test 配下で走るため NODE_TEST_CONTEXT が立っているが、
  // ランナーに依存せず明示的に設定する（後で復元）。
  const saved = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    withTempDir(workspace => {
      msgSend._setGhRepoView(() => ({ status: 0, stdout: 'test/repo\n' }));
      // モックを外して実実装（ガード入り）を使う。ガードが発火するため gh は呼ばれず、
      // main() は拒否メッセージ付きで code 1 になる（= 実投稿へ到達しない）。
      msgSend._resetGhIssueComment();
      const r = msgSend.main(['orchestrator', '--stdin', '--issue', '5', '--workspace', workspace], null, stdinIO('hello'));
      assert.equal(r.code, 1);
      assert.ok(r.errLines.some(l => l.includes('拒否')), `拒否メッセージが必要: ${r.errLines.join('\n')}`);
    });
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
    // 後続テストへ実装を安全なモックへ戻す（ガード入りの実実装を残さない）
    msgSend._setGhIssueComment(() => ({ status: 1, stdout: '', stderr: 'reset' }));
  }
});
