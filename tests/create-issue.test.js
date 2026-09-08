'use strict';

const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildGhCreateArgs, createIssue, validateBodyMode, USAGE } = require('../scripts/create-issue');

const CREATE_ISSUE_SCRIPT = path.join(__dirname, '..', 'scripts', 'create-issue.js');

test('createIssue: title-onlyは空本文で作成し、body-file削除とassistant起動を行わない', () => {
  let ghCreateArgs = null;
  let readBodyCalled = false;
  let unlinkCalled = false;
  let spawnAssistantCalled = false;
  const result = createIssue(
    { title: 'title only', bodyFile: null, titleOnly: true, repo: null, workspace: null },
    {
      ghCreateFn: (args) => {
        ghCreateArgs = args;
        return { status: 0, stdout: 'https://github.com/o/r/issues/42\n', stderr: '' };
      },
      readBodyFileFn: () => { readBodyCalled = true; return 'unexpected'; },
      unlinkBodyFileFn: () => { unlinkCalled = true; },
      spawnAssistantFn: () => { spawnAssistantCalled = true; return { status: 0 }; },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.assistantWarning, null);
  assert.equal(result.cleanupWarning, null);
  assert.deepEqual(ghCreateArgs, {
    title: 'title only',
    bodyFile: null,
    titleOnly: true,
    repo: null,
  });
  assert.equal(readBodyCalled, false);
  assert.equal(unlinkCalled, false);
  assert.equal(spawnAssistantCalled, false);
});

test('createIssue: body入力モードはbody-fileまたはtitle-onlyの一方だけを要求する', () => {
  assert.equal(validateBodyMode({ bodyFile: '/tmp/body.md', titleOnly: false }), null);
  assert.equal(validateBodyMode({ bodyFile: null, titleOnly: true }), null);
  assert.match(validateBodyMode({ bodyFile: '/tmp/body.md', titleOnly: true }), /同時に指定できません/);
  assert.match(validateBodyMode({ bodyFile: null, titleOnly: false }), /いずれかが必要です/);
});

test('create-issue.js: 本文入力モードの拒否をCLI境界で検証する', () => {
  const missingMode = spawnSync(process.execPath, [CREATE_ISSUE_SCRIPT, '--title', 't'], {
    encoding: 'utf8',
  });
  assert.notEqual(missingMode.status, 0);
  assert.match(`${missingMode.stderr}${missingMode.stdout}`, /--body-file または --title-only/);

  const conflictingModes = spawnSync(process.execPath, [
    CREATE_ISSUE_SCRIPT,
    '--title', 't',
    '--body-file', 'unused-body.md',
    '--title-only',
  ], { encoding: 'utf8' });
  assert.notEqual(conflictingModes.status, 0);
  assert.match(`${conflictingModes.stderr}${conflictingModes.stdout}`, /--body-file と --title-only/);
});

test('create-issue.js: title-onlyはgh issue createへ空本文を渡す', () => {
  assert.deepEqual(
    buildGhCreateArgs({ title: 't', bodyFile: null, titleOnly: true, repo: 'o/r' }),
    ['issue', 'create', '--title', 't', '--body', '', '--repo', 'o/r'],
  );
});

test('create-issue.js: helpはtitle-onlyと本文モードの排他条件を説明する', () => {
  assert.match(USAGE, /--title-only/);
  assert.match(USAGE, /--body-file または --title-only/);
});

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
