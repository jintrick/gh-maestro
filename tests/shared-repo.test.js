'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withTempDir } = require('../scripts/shared/temp-directory');
const { resolveRepo } = require('../scripts/shared/repo');

test('resolveRepo は明示repoを優先し、workspace探索やghを呼ばない', () => {
  let ghCalls = 0;
  let workspaceCalls = 0;
  const result = resolveRepo({ repo: ' owner/project ', workspace: 'ignored' }, {
    resolveWorkspaceFn: () => { workspaceCalls += 1; return null; },
    ghRepoViewFn: () => { ghCalls += 1; return { status: 1 }; },
  });

  assert.deepEqual(result, { ok: true, repo: 'owner/project', workspacePath: null });
  assert.equal(workspaceCalls, 0);
  assert.equal(ghCalls, 0);
});

test('resolveRepo はworkspaceからgh repo viewのowner/repoを取得する', () => {
  withTempDir('gh-maestro-resolve-repo-', (workspace) => {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'));
    const calls = [];
    const result = resolveRepo({ workspace }, {
      ghRepoViewFn: (options) => {
        calls.push(options);
        return { status: 0, stdout: 'owner/project\n' };
      },
    });

    assert.deepEqual(result, { ok: true, repo: 'owner/project', workspacePath: workspace });
    assert.deepEqual(calls, [{ cwd: workspace }]);
  });
});

test('resolveRepo はworkspace・gh取得・空repoの失敗を区別する', () => {
  const noWorkspace = resolveRepo({ workspace: 'missing' }, {
    resolveWorkspaceFn: () => null,
    ghRepoViewFn: () => assert.fail('workspace解決失敗後にghを呼んだ'),
  });
  assert.equal(noWorkspace.ok, false);
  assert.match(noWorkspace.error, /ワークスペースを解決できません/);

  const ghFailure = resolveRepo({ workspace: 'workspace' }, {
    resolveWorkspaceFn: () => 'workspace',
    ghRepoViewFn: () => ({ status: 1, stderr: 'auth denied' }),
  });
  assert.equal(ghFailure.ok, false);
  assert.match(ghFailure.error, /auth denied/);

  const thrownFailure = resolveRepo({ workspace: 'workspace' }, {
    resolveWorkspaceFn: () => 'workspace',
    ghRepoViewFn: () => { throw new Error('gh spawn failed'); },
  });
  assert.equal(thrownFailure.ok, false);
  assert.match(thrownFailure.error, /gh spawn failed/);

  const empty = resolveRepo({ workspace: 'workspace' }, {
    resolveWorkspaceFn: () => 'workspace',
    ghRepoViewFn: () => ({ status: 0, stdout: '  ' }),
  });
  assert.deepEqual(empty, { ok: false, error: 'リポジトリ名が空です' });
});
