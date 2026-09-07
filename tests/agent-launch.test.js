'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  buildAgentCommandArgs,
  buildAgentResumeCommandArgs,
  runAgentWithPrompt,
  RESULT_FILE_TOKEN,
  RESUME_REPORTING_REMINDER,
} = require('../scripts/shared/agent-launch');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = { end() {} };
  return child;
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-launch-test-'));
}

function removeTree(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function promptInRoot(root) {
  const directories = fs.readdirSync(root)
    .map(name => ({ name, mtimeMs: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  assert.ok(directories.length > 0);
  return path.join(root, directories[0].name, 'prompt.md');
}

function fileDeliveryConfig(promptDelivery, extra = {}) {
  return {
    command: 'agent',
    extraArgs: ['--non-interactive'],
    promptDelivery,
    ...(promptDelivery === 'flag' ? { promptFlag: '--prompt' } : {}),
    ...extra,
  };
}

async function observeClose(child, callback) {
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(callback ? callback(code) : code));
  });
}

test('runAgentWithPrompt: 配送方式に関係なく本文を内部ファイルへ書き、完了後に所有ディレクトリを閉じる', async () => {
  for (const promptDelivery of ['system-prompt-file', 'flag', 'positional']) {
    const root = tempRoot();
    let capturedPrompt;
    let capturedPromptFile;
    const child = fakeChild();
    const config = fileDeliveryConfig(promptDelivery, promptDelivery === 'system-prompt-file'
      ? { promptDelivery, extraArgs: ['--print'] }
      : {});
    try {
      const runPromise = runAgentWithPrompt({
        agentConfig: config,
        promptText: '本文です',
        cwd: root,
        systemPromptText: 'system',
        tempPrefix: 'agent-launch-scope-',
        tempDirOptions: { tempRoot: root },
        spawnFn: () => {
          capturedPromptFile = promptInRoot(root);
          capturedPrompt = fs.readFileSync(capturedPromptFile, 'utf8');
          process.nextTick(() => child.emit('close', 0));
          return child;
        },
        observe: observeClose,
      });
      const result = await runPromise;
      assert.equal(result.observed, 0);
      assert.equal(capturedPrompt, '本文です');
      assert.ok(capturedPromptFile);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      removeTree(root);
    }
  }
});

test('runAgentWithPrompt: 結果本文だけを返し、同時実行中の別スコープを消さない', async () => {
  const root = tempRoot();
  const children = [fakeChild(), fakeChild()];
  let firstObserved;
  let releaseSecond;
  const secondDone = new Promise((resolve) => { releaseSecond = resolve; });
  const spawnFn = () => {
    const child = children.shift();
    const promptFile = promptInRoot(root);
    const prompt = fs.readFileSync(promptFile, 'utf8');
    const resultPath = prompt.match(/結果: (.+)$/m)[1];
    if (!firstObserved) {
      firstObserved = true;
      fs.writeFileSync(resultPath, '{"ok":true}', 'utf8');
      process.nextTick(() => child.emit('close', 0));
    } else {
      secondDone.then(() => child.emit('close', 0));
    }
    return child;
  };
  try {
    const first = runAgentWithPrompt({
      agentConfig: fileDeliveryConfig('positional'),
      promptText: `結果: ${RESULT_FILE_TOKEN}`,
      cwd: root,
      resultFileName: 'result.json',
      tempPrefix: 'agent-launch-concurrent-',
      tempDirOptions: { tempRoot: root },
      spawnFn,
      observe: observeClose,
    });
    const second = runAgentWithPrompt({
      agentConfig: fileDeliveryConfig('positional'),
      promptText: `結果: ${RESULT_FILE_TOKEN}`,
      cwd: root,
      resultFileName: 'result.json',
      tempPrefix: 'agent-launch-concurrent-',
      tempDirOptions: { tempRoot: root },
      spawnFn,
      observe: observeClose,
    });

    const firstResult = await first;
    assert.equal(firstResult.resultFileText, '{"ok":true}');
    const remaining = fs.readdirSync(root);
    assert.equal(remaining.length, 1, 'second launch scope remains owned by its own invocation');
    releaseSecond();
    await second;
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    removeTree(root);
  }
});

test('runAgentWithPrompt: spawn失敗・observer例外・timeout相当の拒否でもスコープを閉じる', async () => {
  for (const scenario of [
    { spawnFn: () => { throw new Error('spawn failed'); }, observe: () => Promise.reject(new Error('unused')) },
    { spawnFn: () => fakeChild(), observe: () => Promise.reject(new Error('observer failed')) },
  ]) {
    const root = tempRoot();
    try {
      await assert.rejects(runAgentWithPrompt({
        agentConfig: fileDeliveryConfig('positional'),
        promptText: '本文',
        cwd: root,
        tempPrefix: 'agent-launch-failure-',
        tempDirOptions: { tempRoot: root },
        spawnFn: scenario.spawnFn,
        observe: scenario.observe,
      }), /failed|observer/);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      removeTree(root);
    }
  }

  const root = tempRoot();
  const child = fakeChild();
  try {
    await assert.rejects(runAgentWithPrompt({
      agentConfig: fileDeliveryConfig('positional'),
      promptText: '本文',
      cwd: root,
      tempPrefix: 'agent-launch-failure-',
      tempDirOptions: { tempRoot: root },
      spawnFn: () => child,
      observe: () => Promise.reject(new Error('timeout')),
    }), /timeout/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    removeTree(root);
  }
});

test('buildAgentCommandArgs: system-prompt-file delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'claude',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'system-prompt-file',
  }, {
    promptFile: 'C:/tmp/prompt.md',
    systemPromptText: 'start',
  });

  assert.deepEqual(args, [
    'claude',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file',
    'C:/tmp/prompt.md',
    'start',
  ]);
});

test('buildAgentCommandArgs: flag delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'agy',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'flag',
    promptFlag: '-i',
  }, {
    shortPrompt: 'start',
  });

  assert.deepEqual(args, ['agy', '--dangerously-skip-permissions', '-i', 'start']);
});

test('buildAgentCommandArgs: positional delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'codex',
    extraArgs: ['--no-alt-screen'],
    promptDelivery: 'positional',
  }, {
    shortPrompt: 'start',
  });

  assert.deepEqual(args, ['codex', '--no-alt-screen', 'start']);
});

test('buildAgentCommandArgs: send-text-after-launch delivery', () => {
  const args = buildAgentCommandArgs({
    command: 'node',
    extraArgs: ['reasonix.js', '--yolo'],
    promptDelivery: 'send-text-after-launch',
  });

  assert.deepEqual(args, ['node', 'reasonix.js', '--yolo']);
});

test('buildAgentCommandArgs: unknown delivery fails clearly', () => {
  assert.throws(() => buildAgentCommandArgs({
    command: 'x',
    promptDelivery: 'unknown',
  }), /unknown promptDelivery/);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildAgentResumeCommandArgs
// ═══════════════════════════════════════════════════════════════════════════

test('buildAgentResumeCommandArgs: flag delivery（agy）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'agy',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'flag',
    promptFlag: '-i',
  }, ['--continue'], { shortPrompt: '新着メッセージです' });

  assert.deepEqual(argv, ['agy', '--dangerously-skip-permissions', '--continue', '-i', '新着メッセージです']);
  assert.equal(afterLaunchText, null);
});

test('buildAgentResumeCommandArgs: positional delivery（codex）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'codex',
    extraArgs: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    promptDelivery: 'positional',
  }, ['resume', '--last'], { shortPrompt: '新着メッセージです' });

  // 非対話トークン exec は extraArgs 由来の1回のみ。resumeCommand（resumeArgs）には含めない
  assert.deepEqual(argv, ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--last', '新着メッセージです']);
  assert.equal(afterLaunchText, null);
  assert.equal(argv.filter(a => a === 'exec').length, 1, 'exec should appear exactly once');
});

test('buildAgentResumeCommandArgs: send-text-after-launch delivery（reasonix）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'node',
    extraArgs: ['reasonix.js', '--yolo'],
    promptDelivery: 'send-text-after-launch',
  }, ['--continue'], { shortPrompt: '新着メッセージです' });

  assert.deepEqual(argv, ['node', 'reasonix.js', '--yolo', '--continue']);
  assert.equal(afterLaunchText, '新着メッセージです');
});

test('buildAgentResumeCommandArgs: system-prompt-file delivery（claude系。--continueはシステムプロンプトを復元しないため、resumeのたびに報告プロトコルのリマインダーを--append-system-promptで再注入する）', () => {
  const { argv, afterLaunchText } = buildAgentResumeCommandArgs({
    command: 'claude-ds-pro',
    extraArgs: ['--dangerously-skip-permissions', '--print'],
    promptDelivery: 'system-prompt-file',
  }, ['--continue'], { shortPrompt: '新着メッセージです' });

  assert.deepEqual(argv, [
    'claude-ds-pro', '--dangerously-skip-permissions', '--print', '--continue',
    '--append-system-prompt', RESUME_REPORTING_REMINDER,
    '新着メッセージです',
  ]);
  assert.equal(afterLaunchText, null);
});

test('buildAgentResumeCommandArgs: リマインダーはmsg-send.jsの正確な呼び出し構文と位置引数禁止の警告を含む', () => {
  assert.match(RESUME_REPORTING_REMINDER, /msg-send\.js/);
  assert.match(RESUME_REPORTING_REMINDER, /--stdin/);
  assert.match(RESUME_REPORTING_REMINDER, /位置引数/);
});

test('buildAgentResumeCommandArgs: 未知のdeliveryはエラー', () => {
  assert.throws(() => buildAgentResumeCommandArgs({
    command: 'claude',
    promptDelivery: 'unknown',
  }, ['--continue'], { shortPrompt: 'x' }), /promptDelivery "unknown" に対応していません/);
});

test('buildAgentResumeCommandArgs: resumeArgsが配列でないとエラー', () => {
  assert.throws(() => buildAgentResumeCommandArgs({
    command: 'agy', promptDelivery: 'flag', promptFlag: '-i',
  }, null, { shortPrompt: 'x' }), /resumeArgs must be an array/);
});

test('buildAgentResumeCommandArgs: shortPrompt必須', () => {
  assert.throws(() => buildAgentResumeCommandArgs({
    command: 'agy', promptDelivery: 'flag', promptFlag: '-i',
  }, ['--continue'], {}), /shortPrompt is required/);
});
