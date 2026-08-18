'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIssue } = require('../scripts/create-issue');

test('createIssue: 成功時はunlinkし、URLからissue番号を抽出し、assistantを起動する', () => {
  const unlinked = [];
  let spawnAssistantArgs = null;
  const result = createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: null, workspace: '/tmp/ws' },
    {
      ghCreateFn: () => ({ status: 0, stdout: 'https://github.com/o/r/issues/42\n', stderr: '' }),
      unlinkBodyFileFn: (p) => unlinked.push(p),
      spawnAssistantFn: (args) => { spawnAssistantArgs = args; return { status: 0, stdout: '', stderr: '' }; },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.number, '42');
  assert.equal(result.url, 'https://github.com/o/r/issues/42');
  assert.equal(result.assistantWarning, null);
  assert.deepEqual(unlinked, ['/tmp/body.md']);
  assert.deepEqual(spawnAssistantArgs, { issue: '42', repo: 'o/r', workspace: '/tmp/ws' });
});

test('createIssue: --repoを明示していればURLからの抽出より優先してassistantに渡す', () => {
  let spawnAssistantArgs = null;
  createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: 'explicit/repo', workspace: '/tmp/ws' },
    {
      ghCreateFn: () => ({ status: 0, stdout: 'https://github.com/o/r/issues/7\n', stderr: '' }),
      unlinkBodyFileFn: () => {},
      spawnAssistantFn: (args) => { spawnAssistantArgs = args; return { status: 0 }; },
    }
  );
  assert.equal(spawnAssistantArgs.repo, 'explicit/repo');
});

test('createIssue: Issue作成成功後の削除失敗は作成成功として警告し、assistantを継続する', () => {
  let spawnAssistantCalled = false;
  const result = createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: 'o/r', workspace: '/tmp/ws' },
    {
      ghCreateFn: () => ({ status: 0, stdout: 'https://github.com/o/r/issues/42\n', stderr: '' }),
      unlinkBodyFileFn: () => { throw new Error('EPERM'); },
      spawnAssistantFn: () => { spawnAssistantCalled = true; return { status: 0 }; },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(spawnAssistantCalled, true);
  assert.match(result.cleanupWarning, /原案を保持/);
  assert.match(result.cleanupWarning, /EPERM/);
});

test('createIssue: gh issue create失敗時はunlinkせずok:falseを返す', () => {
  let unlinkCalled = false;
  let spawnAssistantCalled = false;
  const result = createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: null, workspace: '/tmp/ws' },
    {
      ghCreateFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      isRetryableGhFailureFn: () => false,
      unlinkBodyFileFn: () => { unlinkCalled = true; },
      spawnAssistantFn: () => { spawnAssistantCalled = true; return { status: 0 }; },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.stderr, 'boom');
  assert.equal(unlinkCalled, false);
  assert.equal(spawnAssistantCalled, false);
});

test('createIssue: retryable失敗時はGraphQLフォールバックし成功すればassistantを起動する', () => {
  let graphqlArgs = null;
  const result = createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: null, workspace: '/tmp/ws' },
    {
      ghCreateFn: () => ({ status: 1, stdout: '', stderr: 'rest api down' }),
      isRetryableGhFailureFn: () => true,
      resolveRepoForFallbackFn: () => 'fallback/repo',
      readBodyFileFn: () => '# body',
      graphqlCreateIssueFn: (args) => {
        graphqlArgs = args;
        return { status: 0, stdout: 'https://github.com/fallback/repo/issues/3\n', stderr: '' };
      },
      unlinkBodyFileFn: () => {},
      spawnAssistantFn: () => ({ status: 0 }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.number, '3');
  assert.deepEqual(graphqlArgs, { repo: 'fallback/repo', title: 't', body: '# body' });
});

test('createIssue: assistant起動失敗はassistantWarningに理由を入れるがissue作成自体は成功扱い', () => {
  const result = createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: null, workspace: '/tmp/ws' },
    {
      ghCreateFn: () => ({ status: 0, stdout: 'https://github.com/o/r/issues/1\n', stderr: '' }),
      unlinkBodyFileFn: () => {},
      spawnAssistantFn: () => ({ status: 1, stdout: '', stderr: 'agy not found' }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.assistantWarning, 'agy not found');
});

test('createIssue: repoもworkspaceも解決できない場合はassistantを起動せず警告を返す', () => {
  let spawnAssistantCalled = false;
  const result = createIssue(
    { title: 't', bodyFile: '/tmp/body.md', repo: null, workspace: null },
    {
      // URLにowner/repoが含まれない不正な形（本来起きないが防御的に確認）
      ghCreateFn: () => ({ status: 0, stdout: 'https://github.com/issues/1\n', stderr: '' }),
      unlinkBodyFileFn: () => {},
      spawnAssistantFn: () => { spawnAssistantCalled = true; return { status: 0 }; },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(spawnAssistantCalled, false);
  assert.match(result.assistantWarning, /解決できず/);
});
