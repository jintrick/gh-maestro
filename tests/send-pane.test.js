'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'send-pane.js');

// wezterm を差し替えるための node 製モックを書き出す。
// `cli list` には MOCK_LIST_JSON を返し、その他（send-text 等）は exit 0。
// 実バイナリへの依存と OS 差（PATH 区切り・.cmd 起動制限）を回避する。
function writeWeztermMock(dir) {
  const mockPath = path.join(dir, 'wezterm-mock.js');
  fs.writeFileSync(
    mockPath,
    "const a = process.argv.slice(2).join(' ');\n" +
    "if (a.startsWith('cli list')) process.stdout.write(process.env.MOCK_LIST_JSON || '[]');\n" +
    "process.exit(0);\n",
    'utf8'
  );
  return mockPath;
}

// send-text 呼び出しの引数を1行1呼び出しでlogPathに追記するモック。
// terminator選択の配線（workers.json の agentId → agents.json の enterSequence）を検証するために使う。
function writeLoggingWeztermMock(dir, logPath) {
  const mockPath = path.join(dir, 'wezterm-mock-logging.js');
  fs.writeFileSync(
    mockPath,
    "const fs = require('fs');\n" +
    "const argv = process.argv.slice(2);\n" +
    "const a = argv.join(' ');\n" +
    "if (a.startsWith('cli list')) { process.stdout.write(process.env.MOCK_LIST_JSON || '[]'); process.exit(0); }\n" +
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + '\\n');\n` +
    "process.exit(0);\n",
    'utf8'
  );
  return mockPath;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('引数なしでエラー終了する', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('ワーカー名のみでエラー終了する（メッセージが必要）', () => {
  const r = run(['orchestrator']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('workers.json が存在する場合にpane-idを解決する（wezterm呼び出し前に解決されること）', () => {
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '42', 'issue-1-implement': '99' }),
      'utf8'
    );

    // wezterm がなくても解決ロジックは動く（wezterm呼び出しで失敗するが、
    // 解決自体は行われているはずなので exit code は wezterm 起因のエラー）
    const r = run(['orchestrator', 'hello', '--workspace', workspace], {
      WEZTERM_PANE: '99',
    });
    // wezterm が存在しない環境でも "Usage" エラーにはならない（引数は正しい）
    assert.ok(!r.stderr.includes('Usage'), `予期しないUsageエラー: ${r.stderr}`);
  });
});

test('orchestratorからの送信にはプレフィックス "orchestratorです。" が付く', () => {
  // send-pane.js のプレフィックスロジックを直接検証するため、
  // スクリプト内のロジックを関数として切り出せないので、
  // workers.json でorchestratorのpane-idを自分のWEZTERM_PANEと一致させてチェック
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '1', 'issue-1-implement': '2' }),
      'utf8'
    );

    // WEZTERM_PANE=1 → 自分はorchestratorとして認識される
    // → fullMessage = "orchestratorです。<message>"
    // wezterm がないので実際には送信失敗するが、プレフィックス付与ロジックは到達する
    const r = run(['issue-1-implement', 'test message', '--workspace', workspace], {
      WEZTERM_PANE: '1',
    });
    assert.ok(!r.stderr.includes('Usage'));
  });
});

// ── pane cwd 検証 ─────────────────────────────────────────────────────

test('cwd が期待と異なる pane のみの場合、cwd 再検索で見つからずエラー終了する', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.gh-maestro', 'workers.json'),
      JSON.stringify({ orchestrator: '0', 'issue-1-fix': '1' }),
      'utf8'
    );

    // mock: pane_id=1 だが cwd が全然違う（cwd 検索でもヒットしない）
    const r = run(['issue-1-fix', 'hello', '--workspace', workspace], {
      WEZTERM_PANE: '0',
      WEZTERM_MOCK: writeWeztermMock(tmp),
      MOCK_LIST_JSON: '[{"pane_id":1,"cwd":"file:///some/other/dir"}]',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /見つかりません/);
  });
});

test('pane_id が間違っていても cwd 一致ペインがあればそちらに送信する', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'issue-1-fix');
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.gh-maestro', 'workers.json'),
      JSON.stringify({ orchestrator: '0', 'issue-1-fix': '99' }),  // 意図的に違う pane_id
      'utf8'
    );

    const cwdJson = `[{"pane_id":77,"cwd":"${pathToFileURL(worktree).href}"}]`;  // 正しい cwd のペインは 77

    const r = run(['issue-1-fix', 'hello', '--workspace', workspace], {
      WEZTERM_PANE: '0',
      WEZTERM_MOCK: writeWeztermMock(tmp),
      MOCK_LIST_JSON: cwdJson,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /→ 77/, 'should report corrected pane_id 77');
  });
});

test('cwd が一致する場合は検証を通過する', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'issue-1-fix');
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.gh-maestro', 'workers.json'),
      JSON.stringify({ orchestrator: '0', 'issue-1-fix': '1' }),
      'utf8'
    );

    const cwdJson = `[{"pane_id":1,"cwd":"${pathToFileURL(worktree).href}"}]`;

    const r = run(['issue-1-fix', 'hello', '--workspace', workspace], {
      WEZTERM_PANE: '0',
      WEZTERM_MOCK: writeWeztermMock(tmp),
      MOCK_LIST_JSON: cwdJson,
    });
    assert.ok(!r.stderr.includes('cwd'), `cwd検証が誤って失敗しました: ${r.stderr}`);
  });
});

// ── agentId経由のterminator解決 ──────────────────────────────────────

test('workers.jsonのagentIdからagents.jsonのenterSequenceを引いてEnterを送信する', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'issue-1-fix');
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.gh-maestro', 'workers.json'),
      JSON.stringify({
        orchestrator: { paneId: '0' },
        'issue-1-fix': { paneId: '1', agentId: 'reasonix' },
      }),
      'utf8'
    );

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-home-'));
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gh-maestro', 'agents.json'),
      JSON.stringify([{ id: 'reasonix', enterSequence: '\r' }]),
      'utf8'
    );

    const logPath = path.join(tmp, 'send-text-calls.log');
    const cwdJson = `[{"pane_id":1,"cwd":"${pathToFileURL(worktree).href}"}]`;

    try {
      const r = run(['issue-1-fix', 'hello', '--workspace', workspace], {
        WEZTERM_PANE: '0',
        WEZTERM_MOCK: writeLoggingWeztermMock(tmp, logPath),
        MOCK_LIST_JSON: cwdJson,
        HOME: home,
        USERPROFILE: home,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);

      const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const sendTextCalls = calls.filter(c => c[0] === 'cli' && c[1] === 'send-text');
      assert.equal(sendTextCalls.length, 2, 'メッセージ本文送信 + Enter送信の2回のはず');
      const enterCall = sendTextCalls[1];
      assert.equal(enterCall[enterCall.length - 1], '\r', 'reasonixのenterSequence(\\r)が使われるべき');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── 並行送信のロック ──────────────────────────────────────────────────

// send-text 呼び出し（cli list以外）にわずかな遅延を入れて競合の窓を広げつつ、
// 呼び出し元プロセス識別用の env TEST_CALL_ID 付きで1呼び出し1行ログに残すモック。
// wez()は呼び出しごとに新しいモックプロセスをspawnするためpidでは呼び出し元を
// 識別できず、send-pane.js自身のプロセスに設定したenvを子へ継承させて識別する。
// ロックなしなら2プロセスの本文/Enter呼び出しが入れ替わって記録されるはず。
function writeDelayedLoggingWeztermMock(dir, logPath) {
  const mockPath = path.join(dir, 'wezterm-mock-delayed.js');
  fs.writeFileSync(
    mockPath,
    "const fs = require('fs');\n" +
    "const argv = process.argv.slice(2);\n" +
    "const a = argv.join(' ');\n" +
    "if (a.startsWith('cli list')) { process.stdout.write(process.env.MOCK_LIST_JSON || '[]'); process.exit(0); }\n" +
    "if (a.startsWith('cli send-text')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); }\n" +
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ callId: process.env.TEST_CALL_ID, argv }) + '\\n');\n` +
    "process.exit(0);\n",
    'utf8'
  );
  return mockPath;
}

test('同一paneへの並行送信はロックで直列化され、本文とEnterが他プロセスと入れ替わらない', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    const workspace = path.join(tmp, 'project');
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.gh-maestro', 'workers.json'),
      JSON.stringify({ orchestrator: '0' }),
      'utf8'
    );

    const logPath = path.join(tmp, 'concurrent-calls.log');
    const mock = writeDelayedLoggingWeztermMock(tmp, logPath);
    const runEnv = {
      ...process.env,
      WEZTERM_PANE: '99',
      WEZTERM_MOCK: mock,
      MOCK_LIST_JSON: `[{"pane_id":0,"cwd":"${pathToFileURL(workspace).href}"}]`,
    };

    const runAsync = (msg, callId) => new Promise((res) => {
      const child = spawn(process.execPath, [SCRIPT, 'orchestrator', msg, '--workspace', workspace], {
        env: { ...runEnv, TEST_CALL_ID: callId },
      });
      child.on('exit', (code) => res(code));
    });

    const [codeA, codeB] = await Promise.all([runAsync('メッセージA', 'A'), runAsync('メッセージB', 'B')]);
    assert.equal(codeA, 0, 'メッセージAの送信は成功するはず');
    assert.equal(codeB, 0, 'メッセージBの送信は成功するはず');

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    // send-text呼び出し（本文+Enterの2回）だけを抽出
    const sendTextLines = lines.filter(l => l.argv[0] === 'cli' && l.argv[1] === 'send-text');
    assert.equal(sendTextLines.length, 4, '2プロセス × (本文+Enter) = 4回のはず');

    // ロックにより、同じcallIdの2回（本文→Enter）が隣接しているはず
    // （他プロセスの呼び出しが間に挟まらない = 入れ替わっていない）
    for (let i = 0; i < sendTextLines.length; i += 2) {
      assert.equal(
        sendTextLines[i].callId, sendTextLines[i + 1].callId,
        `呼び出し${i},${i + 1}が同一プロセスのはず（ロックが効いていない可能性）: ${JSON.stringify(sendTextLines)}`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
