'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveRepo, buildPromptFileContent, buildShortPrompt, toUnix } = require('../scripts/spawn-assistant');

test('toUnix: バックスラッシュをスラッシュに変換する', () => {
  assert.equal(toUnix('C:\\Users\\amg\\work\\gh-maestro'), 'C:/Users/amg/work/gh-maestro');
});

test('resolveRepo: --repoが明示されていればそれを使い、gh repo viewは呼ばない', () => {
  let called = false;
  const repo = resolveRepo('/tmp/ws', 'o/r', () => { called = true; return { status: 0, stdout: 'x/y' }; });
  assert.equal(repo, 'o/r');
  assert.equal(called, false);
});

test('resolveRepo: --repo未指定時はgh repo viewの結果を使う', () => {
  const repo = resolveRepo('/tmp/ws', null, (ws) => {
    assert.equal(ws, '/tmp/ws');
    return { status: 0, stdout: 'owner/repo\n' };
  });
  assert.equal(repo, 'owner/repo');
});

test('resolveRepo: gh repo view失敗時はnull', () => {
  const repo = resolveRepo('/tmp/ws', null, () => ({ status: 1, stdout: '' }));
  assert.equal(repo, null);
});

test('resolveRepo: gh repo viewの出力が空ならnull', () => {
  const repo = resolveRepo('/tmp/ws', null, () => ({ status: 0, stdout: '   \n' }));
  assert.equal(repo, null);
});

test('buildPromptFileContent: ISSUE/REPO/WORKSPACEを含み、worktreeが無い旨を明記する', () => {
  const content = buildPromptFileContent({ issue: '5', repo: 'o/r', workspace: 'C:\\ws' });
  assert.match(content, /ISSUE=5/);
  assert.match(content, /REPO=o\/r/);
  assert.match(content, /WORKSPACE=C:\/ws/);
  assert.match(content, /workers\.json/);
});

test('buildShortPrompt: issue番号とpromptFileパス（スラッシュ化）を含む1行', () => {
  const shortPrompt = buildShortPrompt({ issue: '9', promptFile: 'C:\\ws\\.gh-maestro\\assistants\\issue-9\\prompt.md' });
  assert.match(shortPrompt, /ISSUE=9/);
  assert.match(shortPrompt, /gh-maestro-assistant/);
  assert.match(shortPrompt, /C:\/ws\/\.gh-maestro\/assistants\/issue-9\/prompt\.md/);
  assert.equal(shortPrompt.includes('\n'), false);
});
