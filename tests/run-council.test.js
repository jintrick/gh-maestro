'use strict';
// run-council.test.js — run-council.js（council の決定論的フェーズ機械）のテスト
//
// 方針: テストは実プロセスを 0 個 spawn する（test-process-spawn-safety ルール）。
//   - child-process.js を require.cache でモック（spawn は throw / spawnSync はディスパッチャ）
//   - resolve-config.js をモック（グループ定義・参加者を注入）
//   - run-council-jobs.js をモック（runPhaseJobs を executor 注入。計画: 終了コードは
//     executor 注入でテスト）
//   - graphql-client.js の _setGraphqlExec で GraphQL 実行を注入
// 実モジュール（council-worktree.js / discussion-graphql.js / finalize-council.js /
// run-council.js 本体）はそのまま使い、フェーズ機械の遷移・state 永続化・終了コードを
// 検証する。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// セッション排他ロックのテストで worker-lease の生存確認・同一性確認を注入する
// （実プロセスに触れない。test-process-spawn-safety ルール準拠）。
const workerLease = require('../scripts/shared/worker-lease');
const processLifecycle = require('../scripts/process-lifecycle');
workerLease._setGetProcessStartTime(() => '2026-07-25T00:00:00.000Z');

const SHA = 'a'.repeat(40);
const AGENDA = '# 議題\n\nRAG構成の採用可否について';

// --title "Test Council" から自動生成されるセッションID。
// slugifyTitle はタイトル全体のハッシュ接尾辞を常に付与する（review指摘 #2）ため、
// ハードコードせず実モジュールから算出する（自動生成セッションを期待するテスト用）。
const { slugifyTitle } = require('../scripts/shared/council-worktree');
const AUTO_SESSION = slugifyTitle('Test Council');

// ── モック部品 ────────────────────────────────────────────────────────────────

function fakeAgent(id) {
  return {
    id,
    command: 'claude',
    promptDelivery: 'flag',
    promptFlag: '-p',
    execArgs: ['-p'],
    extraArgs: [],
    nonInteractiveTokens: [],
  };
}

// spawnSync ディスパッチャ: gh repo view / git rev-parse / git worktree add|remove を模倣。
// git worktree add は実ディレクトリと .git ファイルを作り、remove は削除する
// （ensureCouncilWorktree / removeCouncilWorktree の存在判定を満たすため）。
function makeSpawnSync(opts = {}) {
  const calls = [];
  const impl = (cmd, args, spawnOpts) => {
    calls.push({ cmd, args, spawnOpts });
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      if (opts.repoFail) return { status: 1, stdout: '', stderr: 'not a repository' };
      return { status: 0, stdout: `${opts.repo || 'owner/repo'}\n`, stderr: '' };
    }
    if (cmd === 'git') {
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        if (opts.gitRevParseFail) return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
        return { status: 0, stdout: `${opts.sha || SHA}\n`, stderr: '' };
      }
      if (args.includes('worktree')) {
        if (args.includes('add')) {
          if (opts.worktreeAddFail) return { status: 128, stdout: '', stderr: 'fatal: cannot add worktree' };
          const dir = args[args.indexOf('--detach') + 1];
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /fake\n', 'utf8');
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args.includes('remove')) {
          if (opts.worktreeRemoveFail) return { status: 128, stdout: '', stderr: 'fatal: cannot remove worktree' };
          const dir = args[args.length - 1];
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          return { status: 0, stdout: '', stderr: '' };
        }
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { impl, calls };
}

// GraphQL 実行ディスパッチャ（_setGraphqlExec で注入する実体）。query 文字列で分岐し、
// discussion-graphql.js が期待する応答形状を返す。
function makeGraphqlExec(opts = {}) {
  const {
    discussionsEnabled = true,
    categories = [{ id: 'cat1', name: 'General' }],
    createFail = false,
    commentFail = false,
  } = opts;
  const calls = [];
  let commentSeq = 0;
  const exec = (args, execOpts = {}) => {
    calls.push({ args, execOpts });
    const q = (args.find((a) => a.startsWith('query=')) || '').slice(6);
    const failure = () => ({ status: 0, stdout: JSON.stringify({ errors: [{ message: 'mock boom' }] }), stderr: '' });
    if (q.includes('hasDiscussionsEnabled')) {
      return { status: 0, stdout: JSON.stringify({ data: { repository: { hasDiscussionsEnabled: discussionsEnabled } } }), stderr: '' };
    }
    if (q.includes('discussionCategories')) {
      const nodes = categories.map((c) => ({ id: c.id, name: c.name }));
      return { status: 0, stdout: JSON.stringify({ data: { repository: { discussionCategories: { nodes } } } }), stderr: '' };
    }
    // createDiscussion の事前クエリ: repository{id}
    if (q.includes('{id}')) {
      return { status: 0, stdout: JSON.stringify({ data: { repository: { id: 'repo1' } } }), stderr: '' };
    }
    if (q.includes('createDiscussion')) {
      if (createFail) return failure();
      const title = (args.find((a) => a.startsWith('title=')) || '').slice(6);
      return {
        status: 0,
        stdout: JSON.stringify({
          data: { createDiscussion: { discussion: { id: 'disc1', number: 42, url: 'https://github.com/owner/repo/discussions/42', title } } },
        }),
        stderr: '',
      };
    }
    if (q.includes('addDiscussionComment')) {
      if (commentFail) return failure();
      commentSeq += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          data: { addDiscussionComment: { comment: { id: `c${commentSeq}`, url: `https://github.com/owner/repo/discussions/42#comment-${commentSeq}` } } },
        }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };
  return { exec, calls };
}

// resolve-config.js のモック。グループ・参加者・トークン検証を注入する。
function makeResolveConfig({ agents = ['agent-a', 'agent-b'], groupCategory, groups } = {}) {
  const g = { agents };
  if (groupCategory) g.category = groupCategory;
  const groupsObj = groups || { default: g };
  return {
    resolveCouncilConfig: () => ({ groups: groupsObj, investigationAgent: null }),
    resolveAgentConfig: (id) => fakeAgent(id),
    validateNonInteractiveTokens: () => ({ valid: true, missing: [] }),
  };
}

// run-council-jobs.js の executor 注入。フェーズマニフェストから参加者ごとの結果を生成する。
// attemptOf（参加者ごとの今回の試行回数。resume 時の再試行上限引継ぎで使う）も handler へ
// 素通しする（runPhaseWithRetry が attemptOf を正しく渡すかをテストで検証できるように）。
function makePhaseJobs(handler) {
  const calls = [];
  const runPhaseJobs = async ({ manifest, workspace, attemptOf }) => {
    calls.push({ manifest, workspace, attemptOf });
    return { ok: true, timedOut: false, results: await handler({ manifest, workspace, attemptOf }) };
  };
  return { runPhaseJobs, calls };
}

// 参加者ごとの結果列（'success' | 'fail'）でフェーズ実行を駆動するシナリオ。
// 試行ごとに attempt が進み、列を超える試行は最後の値に張り付く
// （例: ['fail', 'fail'] は2回の再試行まで失敗し続ける → 欠席扱い）。
// 投票の choice はマニフェスト opinions の先頭参加者を指す（スキーマ準拠）。
function scenario(plan) {
  const attemptCounters = {};
  return async ({ manifest }) => {
    const phase = manifest.phase;
    return manifest.participants.map((p) => {
      const key = `${phase}:${p.participant_id}`;
      attemptCounters[key] = (attemptCounters[key] || 0) + 1;
      const entry = (plan[phase] || []).find((e) => e.pid === p.participant_id);
      const outcomes = entry && entry.outcomes ? entry.outcomes : ['success'];
      const attempt = attemptCounters[key];
      const outcome = outcomes[Math.min(attempt - 1, outcomes.length - 1)];
      if (outcome === 'fail') {
        return { participant_id: p.participant_id, status: 'failed', attempt, error: `mock failure for ${p.participant_id}` };
      }
      if (phase === 'vote') {
        const first = manifest.opinions && manifest.opinions[0] ? manifest.opinions[0].participant_id : p.participant_id;
        return {
          participant_id: p.participant_id,
          status: 'success',
          attempt,
          output: { participant_id: p.participant_id, choice: first, rationale: `vote rationale of ${p.participant_id}` },
        };
      }
      return {
        participant_id: p.participant_id,
        status: 'success',
        attempt,
        output: { participant_id: p.participant_id, opinion: `opinion of ${p.participant_id}`, stance: 'AGREE' },
      };
    });
  };
}

// run-council.js を依存込みでモック環境に再requireする。戻り値はモジュール本体と各呼び出し記録。
// spawn は makeSpawnSync() の戻り値 { impl, calls } を受け取る（calls を検査に使うため）。
//
// モジュールロード時に `const { spawnSync } = require('./child-process')` で spawnSync を
// 捕獲する実モジュール（council-worktree.js / git-worktree.js）は、require.cache ごと
// 再ロードしないと前回のテストのモックが残り、per-test の spawn モックが効かない。
// graphql-client.js は外す（discussion-graphql.js がロード時に graphqlExec を捕獲して
// おり、差し替えると呼び出しが古い _graphqlExec を見て壊れる。GraphQL は _setGraphqlExec
// 注入で毎回上書きするため spawnSync 捕獲は問題にならない）。
function loadModule({ spawn, resolveConfig, phaseJobs, graphqlOpts = {} }) {
  const spawnMock = spawn || makeSpawnSync();
  const exportMocks = [
    {
      mod: '../scripts/shared/child-process',
      exports: {
        spawn: () => { throw new Error('spawn must not be called in tests'); },
        spawnSync: spawnMock.impl,
        execSync: () => '',
      },
    },
    { mod: '../scripts/shared/resolve-config', exports: resolveConfig },
    { mod: '../scripts/shared/run-council-jobs', exports: { runPhaseJobs: phaseJobs.runPhaseJobs } },
  ];
  for (const { mod, exports } of exportMocks) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }

  for (const mod of ['../scripts/shared/git-worktree', '../scripts/shared/council-worktree', '../scripts/shared/git-head']) {
    delete require.cache[require.resolve(mod)];
  }

  const gql = makeGraphqlExec(graphqlOpts);
  require('../scripts/shared/graphql-client')._setGraphqlExec(gql.exec);

  const modPath = require.resolve('../scripts/run-council');
  delete require.cache[modPath];
  return { mod: require(modPath), gqlCalls: gql.calls, phaseCalls: phaseJobs.calls, spawnCalls: spawnMock.calls };
}

// 一時ワークスペースを作り、workspaceフォールバックが実workspaceへ向かわないよう
// GH_MAESTRO_WORKSPACE を消して実行する（各呼び出しは --workspace を明示する）。
// fn の完了を await してから workspace を削除する（try{return fn(...)}finally{rmSync} だと
// finally が fn の Promise 完了前に走り、ワークスペースが消えてしまう）。
async function withCouncilEnv(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'council-run-test-'));
  const savedEnv = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  const agenda = path.join(workspace, 'agenda.md');
  fs.writeFileSync(agenda, AGENDA, 'utf8');
  try {
    await fn({ workspace, agenda });
  } finally {
    if (savedEnv === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
    else process.env.GH_MAESTRO_WORKSPACE = savedEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// stdout / stderr を捕捉して実行する。
async function runAndCapture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const code = await fn();
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// CLI argv を組み立てる（--title/--body-file/--workspace は必須。overrides で上書き・追加）。
function args(workspace, overrides = {}) {
  const argv = ['--title', overrides.title || 'Test Council'];
  if (overrides.session) argv.push('--session', overrides.session);
  if (overrides.group) argv.push('--group', overrides.group);
  argv.push('--body-file', overrides.bodyFile || path.join(workspace, 'agenda.md'));
  if (overrides.contextFile) argv.push('--context-file', overrides.contextFile);
  argv.push('--workspace', workspace);
  if (overrides.resume) argv.push('--resume');
  return argv;
}

function stateFile(workspace, session) {
  return path.join(workspace, '.gh-maestro', `council-${session}.json`);
}

// ── parseArgs（usage 検証） ────────────────────────────────────────────────────

function moduleFor(mocks = {}) {
  return loadModule({
    spawn: mocks.spawn || makeSpawnSync(),
    resolveConfig: mocks.resolveConfig || makeResolveConfig(),
    phaseJobs: mocks.phaseJobs || makePhaseJobs(async () => []),
    graphqlOpts: mocks.graphqlOpts || {},
  });
}

test('parseArgs: --help は code 0', () => {
  const { mod } = moduleFor();
  assert.equal(mod.parseArgs(['--help']).code, 0);
  assert.equal(mod.parseArgs(['-h']).code, 0);
});

test('parseArgs: 必須欠落・--resume 無 --session・余分引数は code 1', () => {
  const { mod } = moduleFor();
  assert.equal(mod.parseArgs(['--body-file', 'x.md']).code, 1);                                  // --title 欠落
  assert.equal(mod.parseArgs(['--title', 'T']).code, 1);                                         // --body-file 欠落
  assert.equal(mod.parseArgs(['--title', 'T', '--body-file', 'x', '--resume']).code, 1);         // --resume 無 --session
  assert.equal(mod.parseArgs(['--title', 'T', '--body-file', 'x', 'extra']).code, 1);            // 余分な位置引数
});

test('parseArgs: 正常系で opts を組み立てる', () => {
  const { mod } = moduleFor();
  const r = mod.parseArgs(['--title', 'T', '--body-file', 'x.md', '--session', 's1', '--group', 'g', '--workspace', 'w', '--context-file', 'c.md', '--resume']);
  assert.equal(r.code, undefined);
  assert.deepEqual(r.opts, {
    session: 's1', group: 'g', title: 'T', bodyFile: 'x.md', contextFile: 'c.md', workspace: 'w', resume: true,
  });
});

test('runCouncil: usage エラーは exit 1（help とは区別）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const { mod } = moduleFor();
    const r = await runAndCapture(() => mod.runCouncil(['--body-file', 'x.md', '--workspace', workspace]));
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('--title is required'), 'usage を stderr に出す');

    const r2 = await runAndCapture(() => mod.runCouncil(args(workspace, { resume: true })));
    assert.equal(r2.code, 1);
    assert.ok(r2.err.includes('--resume requires --session'));
  });
});

// ── fail-closed（exit 2。GitHub 書き込みなしで停止） ───────────────────────────

test('fail-closed: council config 未解決・グループ未定義・参加者空は exit 2', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const rcNull = makeResolveConfig();
    rcNull.resolveCouncilConfig = () => null;
    const r1 = await runAndCapture(() => moduleFor({ resolveConfig: rcNull }).mod.runCouncil(args(workspace)));
    assert.equal(r1.code, 2);
    assert.ok(r1.err.includes('council config could not be resolved'));

    const rcGroup = makeResolveConfig({ groups: { other: { agents: ['agent-a'] } } });
    const r2 = await runAndCapture(() => moduleFor({ resolveConfig: rcGroup }).mod.runCouncil(args(workspace)));
    assert.equal(r2.code, 2);
    assert.ok(r2.err.includes('not defined'));

    const rcEmpty = makeResolveConfig({ agents: [] });
    const r3 = await runAndCapture(() => moduleFor({ resolveConfig: rcEmpty }).mod.runCouncil(args(workspace)));
    assert.equal(r3.code, 2);
  });
});

test('fail-closed: リポジトリ解決失敗・body-file 読めず・Discussions 無効は exit 2', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const r1 = await runAndCapture(() => moduleFor({ spawn: makeSpawnSync({ repoFail: true }) }).mod.runCouncil(args(workspace)));
    assert.equal(r1.code, 2);
    assert.ok(r1.err.includes('repository could not be resolved'));

    const r2 = await runAndCapture(() => moduleFor().mod.runCouncil(args(workspace, { bodyFile: path.join(workspace, 'nope.md') })));
    assert.equal(r2.code, 2);
    assert.ok(r2.err.includes('cannot read --body-file'));

    const r3 = await runAndCapture(() => moduleFor({ graphqlOpts: { discussionsEnabled: false } }).mod.runCouncil(args(workspace)));
    assert.equal(r3.code, 2);
    assert.ok(r3.err.includes('Discussions are not enabled'));
  });
});

test('fail-closed: カテゴリなし・グループ指定カテゴリ不在・Discussion 作成失敗・worktree 失敗は exit 2', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const r1 = await runAndCapture(() => moduleFor({ graphqlOpts: { categories: [] } }).mod.runCouncil(args(workspace)));
    assert.equal(r1.code, 2);
    assert.ok(r1.err.includes('no discussion categories'));

    const rcCat = makeResolveConfig({ groupCategory: 'Nope' });
    const r2 = await runAndCapture(() => moduleFor({ resolveConfig: rcCat }).mod.runCouncil(args(workspace)));
    assert.equal(r2.code, 2);
    assert.ok(r2.err.includes('not available'));

    const r3 = await runAndCapture(() => moduleFor({ graphqlOpts: { createFail: true } }).mod.runCouncil(args(workspace)));
    assert.equal(r3.code, 2);
    assert.ok(r3.err.includes('createDiscussion failed'));

    // 新しいセッションを使う（r3 が同セッションの worktree を作成済みのため、worktree add を発行させる）
    const r4 = await runAndCapture(() => moduleFor({ spawn: makeSpawnSync({ worktreeAddFail: true }) }).mod.runCouncil(args(workspace, { session: 'wt-fail' })));
    assert.equal(r4.code, 2);
    assert.ok(r4.err.includes('worktree setup failed'));
  });
});

test('fail-closed: 未完 state なのに --resume 無し・--resume なのに state 無しは exit 2', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    // 全滅停止 state を作る
    const stopJobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['fail', 'fail'] },
        { pid: 'agent-b', outcomes: ['fail', 'fail'] },
      ],
    }));
    const r0 = await runAndCapture(() => moduleFor({ phaseJobs: stopJobs }).mod.runCouncil(args(workspace)));
    assert.equal(r0.code, 3, '前段: 全滅停止で state を作成');

    // 同じ --session を --resume 無しで再実行 → exit 2
    const r1 = await runAndCapture(() => moduleFor().mod.runCouncil(args(workspace, { session: AUTO_SESSION })));
    assert.equal(r1.code, 2);
    assert.ok(r1.err.includes('already has incomplete state'));

    // 存在しない session を --resume → exit 2
    const r2 = await runAndCapture(() => moduleFor().mod.runCouncil(args(workspace, { session: 'nosuch', resume: true })));
    assert.equal(r2.code, 2);
    assert.ok(r2.err.includes('no prior council state'));
  });
});

// ── フェーズ機械: クォーラム緩和・再試行・欠席・投票対象 ─────────────────────────

test('意見1名成功で続行: agent-b は欠席、投票は成功者のみ、完走 exit 0', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['success'] },
        { pid: 'agent-b', outcomes: ['fail', 'fail'] },
      ],
      vote: [{ pid: 'agent-a', outcomes: ['success'] }],
    }));
    const { mod, gqlCalls, spawnCalls } = loadModule({
      spawn: spawn,
      resolveConfig: makeResolveConfig(),
      phaseJobs: jobs,
    });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('COUNCIL_FINISHED cleanupExit=0'));
    assert.ok(r.out.includes('COUNCIL_PHASE_DONE opinion 1/2 absent=1'));
    assert.ok(r.out.includes('COUNCIL_PHASE_DONE vote 1/1 absent=0'));
    assert.ok(r.out.includes('COUNCIL_WT_REMOVED '));

    // 再試行: opinion round2 は失敗者 agent-b のみ（round1 は全員）
    const opinionCalls = jobs.calls.filter((c) => c.manifest.phase === 'opinion');
    assert.equal(opinionCalls.length, 2);
    assert.deepEqual(opinionCalls[0].manifest.participants.map((p) => p.participant_id), ['agent-a', 'agent-b']);
    assert.deepEqual(opinionCalls[1].manifest.participants.map((p) => p.participant_id), ['agent-b']);

    // 投票マニフェストは意見成功者のみ（votes 参照用 opinions も成功者全員）
    const voteManifest = jobs.calls.find((c) => c.manifest.phase === 'vote').manifest;
    assert.deepEqual(voteManifest.participants.map((p) => p.participant_id), ['agent-a']);
    assert.deepEqual(voteManifest.opinions, [{ participant_id: 'agent-a', opinion: 'opinion of agent-a' }]);

    // worktree は add → remove の順で呼ばれた
    const wtAdd = spawnCalls.find((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('add'));
    const wtRemove = spawnCalls.find((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('remove'));
    assert.ok(wtAdd && wtRemove, 'git worktree add/remove が呼ばれた');

    // state は complete。欠席者・意見/投票・集計が永続化されている
    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.status, 'complete');
    assert.equal(state.absentees.length, 1);
    assert.equal(state.absentees[0].participant_id, 'agent-b');
    assert.equal(state.opinions.length, 1);
    assert.equal(state.opinions[0].participant_id, 'agent-a');
    assert.ok(state.opinions[0].commentUrl, '意見コメント URL が記録される');
    assert.equal(state.votes.length, 1);
    assert.equal(state.tally.totalVotes, 1);
    assert.equal(state.tally.entries.length, 2);
    assert.equal(state.worktreeRemoved, true);
    assert.equal(state.worktreeResidual, false);

    // コメント投稿: 意見1 + 投票1 + 要約1（調査/context なし）
    const commentCalls = gqlCalls.filter((c) => c.args.some((a) => a.includes('addDiscussionComment')));
    assert.equal(commentCalls.length, 3);
  });
});

test('全滅停止: 0名成功で exit 3・stopped state・worktree も片付け', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['fail', 'fail'] },
        { pid: 'agent-b', outcomes: ['fail', 'fail'] },
      ],
    }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig(), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('COUNCIL_STOPPED opinion 0/2 succeeded (all failed)'));
    assert.ok(r.out.includes('COUNCIL_PHASE_DONE opinion 0/2 absent=2'));
    assert.ok(r.out.includes('COUNCIL_WT_REMOVED '));

    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.status, 'stopped');
    assert.equal(state.phase, 'opinion');
    assert.equal(state.failures.length, 2);
    for (const f of state.failures) assert.equal(f.attempt, 2, '再試行上限の attempt が記録される');
    assert.equal(state.worktreeRemoved, true);
  });
});

test('再試行上限: 参加者ごとに最大2試行（1回の再起動）で打ち切り', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({
      opinion: [{ pid: 'agent-a', outcomes: ['fail', 'fail'] }],
    }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 3);
    // opinion は2ラウンド（round1 全員・round2 失敗者のみ）で停止
    const opinionCalls = jobs.calls.filter((c) => c.manifest.phase === 'opinion');
    assert.equal(opinionCalls.length, 2);
    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.failures[0].participant_id, 'agent-a');
    assert.equal(state.failures[0].attempt, 2);
  });
});

test('runPhaseWithRetry: prior の試行回数を引き継ぎ、再試行上限を跨がない（resume時のattempt加算）', async () => {
  // prior.results に agent-b の失敗(attempt 1)が記録されている状態からの再開。
  // attempt は 0 から数え直さず、次回は 2 として起動し、2回目の失敗で上限到達→欠席にする
  // （3回目の起動はしない。review指摘 #2）。
  const seen = [];
  const { mod } = moduleFor({
    phaseJobs: makePhaseJobs(async ({ manifest, attemptOf }) => {
      seen.push(manifest.participants.map((p) => attemptOf(p.participant_id)));
      return manifest.participants.map((p) => {
        const attempt = attemptOf(p.participant_id);
        return { participant_id: p.participant_id, status: 'failed', attempt, error: `fail ${attempt}` };
      });
    }),
  });
  const outcome = await mod.runPhaseWithRetry({
    phaseName: 'opinion',
    participants: [
      { participant_id: 'agent-a', agent_id: 'agent-a' },
      { participant_id: 'agent-b', agent_id: 'agent-b' },
    ],
    makeManifest: (pending) => ({ phase: 'opinion', participants: pending }),
    workspace: '/ws',
    maxAttempts: 2,
    prior: {
      status: 'in_progress',
      results: {
        'agent-a': { participant_id: 'agent-a', status: 'success', attempt: 1 },
        'agent-b': { participant_id: 'agent-b', status: 'failed', attempt: 1, error: 'fail1' },
      },
      absentees: [],
    },
  });

  // 成功済み agent-a は再起動されない。agent-b のみ attempt=2 で1回だけ再試行
  assert.deepEqual(seen, [[2]]);
  assert.deepEqual(outcome.absentees.map((a) => a.participant_id), ['agent-b']);
  assert.equal(outcome.results['agent-b'].attempt, 2, '累積試行回数が結果に反映される');
  // agent-a の成功は引き継がれる（全滅ではない）
  assert.equal(outcome.allFailed, false);
  assert.equal(outcome.successes.length, 1);
});

test('worktree 片付け失敗: 完走後でも exit 3・state に残存を記録', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync({ worktreeRemoveFail: true });
    const jobs = makePhaseJobs(scenario({
      opinion: [{ pid: 'agent-a', outcomes: ['success'] }],
      vote: [{ pid: 'agent-a', outcomes: ['success'] }],
    }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('COUNCIL_FINISHED cleanupExit=3'), 'cleanup の実結果が exit 3 として記録される');
    assert.ok(r.out.includes('COUNCIL_WT_REMOVED_FAILED '));

    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.status, 'complete');
    assert.equal(state.worktreeRemoved, false);
    assert.equal(state.worktreeResidual, true);
  });
});

// ── complete + worktreeResidual の --resume（review指摘 #7） ────────────────────
// 完走済み（status=complete）だが worktree 片付けに失敗した残存がある state を --resume
// で再開すると、従来は COUNCIL_ALREADY_COMPLETE で exit 0 になり、手動片付けが必要という
// シグナル（worktreeResidual=true・exit 3）が消えていた。修正後は complete 分岐内で
// 片付けを再試行し、成功なら COUNCIL_WT_REMOVED / 失敗なら COUNCIL_WT_REMOVED_FAILED で
// exit 3 を維持する。state は手書きで用意する（フェーズジョブ・GraphQL は再実行されない）。

test('complete + worktreeResidual の --resume: 片付け再試行に成功すれば exit 0 + COUNCIL_WT_REMOVED', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const worktreeDir = path.join(workspace, '.gh-maestro', `council-wt-${AUTO_SESSION}`);
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, '.git'), 'gitdir: /fake\n', 'utf8');
    fs.writeFileSync(stateFile(workspace, AUTO_SESSION), JSON.stringify({
      status: 'complete',
      session: AUTO_SESSION,
      worktreeDir,
      worktreeRemoved: false,
      worktreeResidual: true,
    }), 'utf8');

    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(async () => []);
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig(), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace, { session: AUTO_SESSION, resume: true })));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('COUNCIL_ALREADY_COMPLETE'));
    assert.ok(r.out.includes('COUNCIL_WT_REMOVED '), '片付け再試行の成功が報告される');
    assert.equal(jobs.calls.length, 0, 'フェーズジョブは再実行されない');

    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.worktreeResidual, false);
    assert.equal(state.worktreeRemoved, true);
  });
});

test('complete + worktreeResidual の --resume: 片付け再試行も失敗なら exit 3 を維持（シグナル消滅を防ぐ）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const worktreeDir = path.join(workspace, '.gh-maestro', `council-wt-${AUTO_SESSION}`);
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, '.git'), 'gitdir: /fake\n', 'utf8');
    fs.writeFileSync(stateFile(workspace, AUTO_SESSION), JSON.stringify({
      status: 'complete',
      session: AUTO_SESSION,
      worktreeDir,
      worktreeRemoved: false,
      worktreeResidual: true,
    }), 'utf8');

    const spawn = makeSpawnSync({ worktreeRemoveFail: true });
    const jobs = makePhaseJobs(async () => []);
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig(), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace, { session: AUTO_SESSION, resume: true })));
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('COUNCIL_ALREADY_COMPLETE'));
    assert.ok(r.out.includes('COUNCIL_WT_REMOVED_FAILED '), '手動片付けが必要というシグナルが維持される');

    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.worktreeResidual, true);
    assert.equal(state.worktreeRemoved, false);
  });
});

test('--group: 指定グループの参加者で進行する', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-x' }], vote: [{ pid: 'agent-x' }] }));
    const { mod } = loadModule({
      spawn: spawn,
      resolveConfig: makeResolveConfig({ groups: { default: { agents: ['agent-a'] }, other: { agents: ['agent-x'] } } }),
      phaseJobs: jobs,
    });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace, { group: 'other' })));
    assert.equal(r.code, 0);
    const opinionManifest = jobs.calls.find((c) => c.manifest.phase === 'opinion').manifest;
    assert.deepEqual(opinionManifest.participants.map((p) => p.participant_id), ['agent-x']);
  });
});

// ── --resume（冪等再開） ───────────────────────────────────────────────────────

test('--resume: 意見フェーズ途中で中断 → 未完了分のみ再開して完走', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    // 1回目: opinion round1（a成功・b失敗）でラウンド進行を state に永続化した直後、
    // round2 で構造的失敗（executor throw）→ exit 2（フェイルクローズ）
    let opinionRounds = 0;
    const jobs1 = makePhaseJobs(async ({ manifest }) => {
      if (manifest.phase === 'opinion') {
        opinionRounds += 1;
        if (opinionRounds === 1) {
          return [
            { participant_id: 'agent-a', status: 'success', attempt: 1, output: { participant_id: 'agent-a', opinion: 'opinion of agent-a', stance: 'AGREE' } },
            { participant_id: 'agent-b', status: 'failed', attempt: 1, error: 'mock failure for agent-b' },
          ];
        }
        throw new Error('simulated interruption (structural failure)');
      }
      return [];
    });
    const r1 = await runAndCapture(() => moduleFor({ phaseJobs: jobs1 }).mod.runCouncil(args(workspace)));
    assert.equal(r1.code, 2);
    assert.ok(r1.err.includes('unexpected failure'));

    // state は opinion を in_progress のまま残す（a は成功済み）
    const mid = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(mid.phases.opinion.status, 'in_progress');
    assert.equal(mid.phases.opinion.results['agent-a'].status, 'success');

    // 2回目: --resume。opinion は失敗者のみ（agent-b）を再起動し、その後投票も完走 → exit 0
    const spawn2 = makeSpawnSync();
    const jobs2 = makePhaseJobs(scenario({
      opinion: [{ pid: 'agent-b', outcomes: ['success'] }],
      vote: [{ pid: 'agent-a' }, { pid: 'agent-b' }],
    }));
    const { mod: mod2 } = loadModule({ spawn: spawn2, resolveConfig: makeResolveConfig(), phaseJobs: jobs2 });
    const r2 = await runAndCapture(() => mod2.runCouncil(args(workspace, { session: AUTO_SESSION, resume: true })));
    assert.equal(r2.code, 0);
    assert.ok(r2.out.includes('COUNCIL_FINISHED cleanupExit=0'));

    // opinion の再開マニフェストは成功済み agent-a を含まない（完了済みジョブを再実行しない）
    const opinionCalls = jobs2.calls.filter((c) => c.manifest.phase === 'opinion');
    assert.equal(opinionCalls.length, 1);
    assert.deepEqual(opinionCalls[0].manifest.participants.map((p) => p.participant_id), ['agent-b']);

    // 投票対象は意見成功者全員（a + b）
    const voteManifest = jobs2.calls.find((c) => c.manifest.phase === 'vote').manifest;
    assert.deepEqual(voteManifest.participants.map((p) => p.participant_id), ['agent-a', 'agent-b']);

    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.status, 'complete');
    assert.equal(state.opinions.length, 2);
    assert.equal(state.votes.length, 2);
  });
});

test('冪等再開: complete state は --resume 有無にかかわらず即 exit 0', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r1 = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r1.code, 0);
    const jobCountAfterFirst = jobs.calls.length;
    assert.ok(jobCountAfterFirst > 0, '初回はフェーズジョブが実行される');

    const r2 = await runAndCapture(() => mod.runCouncil(args(workspace, { session: AUTO_SESSION, resume: true })));
    assert.equal(r2.code, 0);
    assert.ok(r2.out.includes('COUNCIL_ALREADY_COMPLETE'));

    const r3 = await runAndCapture(() => mod.runCouncil(args(workspace, { session: AUTO_SESSION })));
    assert.equal(r3.code, 0);
    assert.ok(r3.out.includes('COUNCIL_ALREADY_COMPLETE'));

    assert.equal(jobs.calls.length, jobCountAfterFirst, 'フェーズジョブは追加実行されない');
  });
});

test('全滅停止後の --resume: 停止フェーズを全参加者で再試行し、成功すれば完走', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    // 1回目: opinion 全滅（2試行とも失敗）→ stopped（exit 3）
    const stopJobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['fail', 'fail'] },
        { pid: 'agent-b', outcomes: ['fail', 'fail'] },
      ],
    }));
    const r0 = await runAndCapture(() => moduleFor({ phaseJobs: stopJobs }).mod.runCouncil(args(workspace)));
    assert.equal(r0.code, 3);

    // 2回目: --resume。停止フェーズ（opinion）の進行をリセットし、全参加者を
    // attempt 0 から再起動する。今回は成功 → 完走（exit 0）
    const spawn2 = makeSpawnSync();
    const resumeJobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['success'] },
        { pid: 'agent-b', outcomes: ['success'] },
      ],
      vote: [{ pid: 'agent-a' }, { pid: 'agent-b' }],
    }));
    const { mod: mod2 } = loadModule({ spawn: spawn2, resolveConfig: makeResolveConfig(), phaseJobs: resumeJobs });
    const r1 = await runAndCapture(() => mod2.runCouncil(args(workspace, { session: AUTO_SESSION, resume: true })));
    assert.equal(r1.code, 0);
    assert.ok(r1.out.includes('COUNCIL_FINISHED cleanupExit=0'));

    // 再試行は「成功者のみ」ではなく全参加者（停止フェーズの進行がリセットされている）
    const opinionCalls = resumeJobs.calls.filter((c) => c.manifest.phase === 'opinion');
    assert.equal(opinionCalls.length, 1);
    assert.deepEqual(opinionCalls[0].manifest.participants.map((p) => p.participant_id), ['agent-a', 'agent-b']);

    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.status, 'complete');
    assert.equal(state.absentees.length, 0);
  });
});

test('全滅停止後の --resume: 再試行も全滅なら再停止（exit 3・attempt は数え直し）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const stopJobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['fail', 'fail'] },
        { pid: 'agent-b', outcomes: ['fail', 'fail'] },
      ],
    }));
    const r0 = await runAndCapture(() => moduleFor({ phaseJobs: stopJobs }).mod.runCouncil(args(workspace)));
    assert.equal(r0.code, 3);

    // resume 後も全滅 → 再停止。attempt はリセットされて 1 から数え直す
    const resumeJobs = makePhaseJobs(scenario({
      opinion: [
        { pid: 'agent-a', outcomes: ['fail', 'fail'] },
        { pid: 'agent-b', outcomes: ['fail', 'fail'] },
      ],
    }));
    const r1 = await runAndCapture(() => moduleFor({ phaseJobs: resumeJobs }).mod.runCouncil(args(workspace, { session: AUTO_SESSION, resume: true })));
    assert.equal(r1.code, 3);
    assert.ok(r1.out.includes('COUNCIL_STOPPED opinion'));
    const state = JSON.parse(fs.readFileSync(stateFile(workspace, AUTO_SESSION), 'utf8'));
    assert.equal(state.status, 'stopped');
    assert.equal(state.failures[0].attempt, 2, '再試行は1ラウンド目から数え直し、上限で停止');
  });
});

// ── セッション排他ロック・state 原子書き込み ────────────────────────────────────

test('セッションロック: 実行完了後にロックが解放される', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const lockPath = path.join(workspace, '.gh-maestro', `council-${AUTO_SESSION}.lock`);
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(lockPath), false, '完了後にセッションロックが解放されている');
  });
});

test('セッションロック: 他プロセスが保持中は exit 2 で拒否し、ロックは消さない', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    // 別プロセス（pid 424242）がロックを保持している状況を作る
    const lockPath = path.join(workspace, '.gh-maestro', `council-${AUTO_SESSION}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, startTime: new Date().toISOString() }), 'utf8');

    // テスト中は実プロセス生存確認をしない。保持者を「生存・同一プロセス」とみなして
    // ビジー拒否を検証する（test-process-spawn-safety ルール準拠）
    workerLease._setIsProcessAlive(() => true);
    workerLease._setVerifyProcessIdentity(() => ({ match: true }));
    try {
      const { mod } = moduleFor();
      const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
      assert.equal(r.code, 2);
      assert.ok(r.err.includes('another process is running council session'));
      // 保持者が別プロセスなのでロックファイルは残す（誤って消さない）
      const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(holder.pid, 424242);
    } finally {
      workerLease._setIsProcessAlive(processLifecycle.isProcessAlive);
      workerLease._setVerifyProcessIdentity(processLifecycle.verifyProcessIdentity);
    }
  });
});

test('セッションロック: stale ロック（保持者非生存）は自動回収して取得できる', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'council-lock-stale-'));
  try {
    const lockPath = path.join(ws, '.gh-maestro', 'council-s1.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // 死亡済みプロセスの残骸ロック
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startTime: '2000-01-01T00:00:00.000Z' }), 'utf8');

    workerLease._setIsProcessAlive(() => false);
    try {
      const { mod } = moduleFor();
      mod.acquireCouncilSessionLock(ws, 's1'); // throw しない
      const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(holder.pid, process.pid, 'stale ロックを回収して自分が保持者になる');
      mod.releaseCouncilSessionLock(ws, 's1');
      assert.equal(fs.existsSync(lockPath), false, '解放後はロックが消える');
    } finally {
      workerLease._setIsProcessAlive(processLifecycle.isProcessAlive);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('persistState: 一時ファイル+rename で原子的に書き出し、.staging が残らない', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'council-atomic-'));
  try {
    const { mod } = moduleFor();
    const statePath = path.join(ws, '.gh-maestro', 'council-s1.json');
    mod.persistState(statePath, { status: 'running' });
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).status, 'running');
    // 中間ファイル（.staging-*）が残っていない（共有 atomicWriteJson の命名に追随）
    const leftovers = fs.readdirSync(path.dirname(statePath)).filter((f) => f.includes('.staging-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── セッションID（--title からの自動生成・明示指定） ────────────────────────────

test('--session 自動生成: --title からスラッグ・既存 state 衝突で接尾辞 -2', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    // 同タイトルの別セッション state を先に置いて衝突させる
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(stateFile(workspace, AUTO_SESSION), JSON.stringify({ status: 'complete' }), 'utf8');
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(`COUNCIL_SESSION ${AUTO_SESSION}-2`));
    assert.ok(fs.existsSync(stateFile(workspace, `${AUTO_SESSION}-2`)), '新しいセッションの state が作られる');
  });
});

test('--session 明示: 指定セッションで進行し state が作られる', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace, { session: 'my-session' })));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('COUNCIL_SESSION my-session'));
    assert.ok(fs.existsSync(stateFile(workspace, 'my-session')));
  });
});

test('マニフェスト構造: phase/session/title/agenda/worktree/participants を正しく運ぶ', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    const opinionManifest = jobs.calls.find((c) => c.manifest.phase === 'opinion').manifest;
    assert.equal(opinionManifest.phase, 'opinion');
    assert.equal(opinionManifest.session, AUTO_SESSION);
    assert.equal(opinionManifest.title, 'Test Council');
    assert.ok(opinionManifest.agenda.includes('RAG構成'));
    assert.ok(opinionManifest.worktree.endsWith(`council-wt-${AUTO_SESSION}`));
    assert.deepEqual(opinionManifest.participants, [{ participant_id: 'agent-a', agent_id: 'agent-a' }]);
  });
});

// ── 調査結果の自動検知・補足コンテクスト ────────────────────────────────────────

test('調査結果の自動検知: 初回コメント投稿＋context_appendix 全文埋め込み（SSOT）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const invPath = path.join(workspace, '.gh-maestro', `council-${AUTO_SESSION}.investigation.json`);
    fs.mkdirSync(path.dirname(invPath), { recursive: true });
    fs.writeFileSync(invPath, JSON.stringify({ findings: '調査により X が判明', sources: ['src/a.md', 'docs/b.md'] }), 'utf8');
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod, gqlCalls } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('COUNCIL_INVEST_POSTED true'));

    // 初回コメント（意見投稿より前）が調査結果そのもの
    const commentCalls = gqlCalls.filter((c) => c.args.some((a) => a.includes('addDiscussionComment')));
    assert.equal(commentCalls.length, 4, '調査 + 意見 + 投票 + 要約');
    const first = commentCalls[0].execOpts.input;
    assert.ok(first.includes('## 調査結果'));
    assert.ok(first.includes('調査により X が判明'));
    assert.ok(first.includes('src/a.md'));
    assert.ok(first.includes('docs/b.md'));

    // context_appendix に全文埋め込み（orchestrator の再編纂なし）
    const opinionManifest = jobs.calls.find((c) => c.manifest.phase === 'opinion').manifest;
    assert.ok(opinionManifest.context_appendix.includes('## 調査結果（自動埋め込み）'));
    assert.ok(opinionManifest.context_appendix.includes('調査により X が判明'));
    assert.ok(opinionManifest.context_appendix.includes('src/a.md'));
  });
});

test('--context-file: 補足コンテクストを投稿し appendix に併記', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const ctx = path.join(workspace, 'ctx.md');
    fs.writeFileSync(ctx, '追加の文脈です', 'utf8');
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod, gqlCalls } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace, { contextFile: ctx })));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('COUNCIL_INVEST_POSTED false'));

    const commentCalls = gqlCalls.filter((c) => c.args.some((a) => a.includes('addDiscussionComment')));
    assert.ok(commentCalls.some((c) => c.execOpts.input === '追加の文脈です'), '補足コンテクストのコメントが投稿される');

    const opinionManifest = jobs.calls.find((c) => c.manifest.phase === 'opinion').manifest;
    assert.ok(opinionManifest.context_appendix.includes('## 補足コンテクスト'));
    assert.ok(opinionManifest.context_appendix.includes('追加の文脈です'));
  });
});

test('調査結果・context が無い場合は appendix 無しで完走', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('COUNCIL_INVEST_POSTED false'));
    const opinionManifest = jobs.calls.find((c) => c.manifest.phase === 'opinion').manifest;
    assert.equal(opinionManifest.context_appendix, undefined);
  });
});

test('壊れた調査結果ファイルは欠落扱いで続行（exit 0・警告のみ）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const invPath = path.join(workspace, '.gh-maestro', `council-${AUTO_SESSION}.investigation.json`);
    fs.mkdirSync(path.dirname(invPath), { recursive: true });
    fs.writeFileSync(invPath, '{ not json', 'utf8');
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(scenario({ opinion: [{ pid: 'agent-a' }], vote: [{ pid: 'agent-a' }] }));
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 0);
    assert.ok(r.err.includes('corrupt'), '警告を stderr に出す');
    assert.ok(r.out.includes('COUNCIL_INVEST_POSTED false'));
  });
});

test('調査結果コメント投稿失敗はフェイルクローズ（exit 2）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const invPath = path.join(workspace, '.gh-maestro', `council-${AUTO_SESSION}.investigation.json`);
    fs.mkdirSync(path.dirname(invPath), { recursive: true });
    fs.writeFileSync(invPath, JSON.stringify({ findings: 'X', sources: [] }), 'utf8');
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(async () => []);
    const { mod } = loadModule({
      spawn: spawn,
      resolveConfig: makeResolveConfig({ agents: ['agent-a'] }),
      phaseJobs: jobs,
      graphqlOpts: { commentFail: true },
    });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 2);
    assert.ok(r.err.includes('investigation comment post failed'));
  });
});

test('finalize: 投票スキーマ違反はフェイルクローズ（exit 2・集計しない）', async () => {
  await withCouncilEnv(async ({ workspace }) => {
    const spawn = makeSpawnSync();
    const jobs = makePhaseJobs(async ({ manifest }) => {
      if (manifest.phase === 'opinion') {
        return [{ participant_id: 'agent-a', status: 'success', attempt: 1, output: { participant_id: 'agent-a', opinion: 'o', stance: 'AGREE' } }];
      }
      // additionalProperties: false の vote スキーマ違反（未知フィールド）
      return [{ participant_id: 'agent-a', status: 'success', attempt: 1, output: { participant_id: 'agent-a', choice: 'x', rationale: 'y', extraField: true } }];
    });
    const { mod } = loadModule({ spawn: spawn, resolveConfig: makeResolveConfig({ agents: ['agent-a'] }), phaseJobs: jobs });
    const r = await runAndCapture(() => mod.runCouncil(args(workspace)));
    assert.equal(r.code, 2);
    assert.ok(r.err.includes('vote schema validation failed'));
  });
});
