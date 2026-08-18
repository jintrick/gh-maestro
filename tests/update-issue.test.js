'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { main, updateIssue, defaultGhEdit, USAGE } = require('../scripts/update-issue');
const { toWinPath } = require('../scripts/win-path');

function withTempWorkspace(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-update-issue-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'));
  const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return fn(workspace);
  } finally {
    if (savedWorkspace === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
    else process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function withLogicalBody(content, fn) {
  const logicalPath = `/tmp/gh-maestro-update-issue-${process.pid}-${Date.now()}.md`;
  const physicalPath = path.resolve(toWinPath(logicalPath));
  fs.writeFileSync(physicalPath, content, 'utf8');
  try {
    return fn(logicalPath, physicalPath);
  } finally {
    fs.rmSync(physicalPath, { force: true });
  }
}

test('defaultGhEdit: Issue本文更新のargvとcwdを組み立てる', () => {
  let call = null;
  const result = defaultGhEdit({
    issue: '42',
    title: '新しいタイトル',
    bodyFile: 'C:\\Temp\\issue-42.md',
    repo: 'owner/repo',
    workspace: 'C:\\workspace',
  }, (cmd, args, opts) => {
    call = { cmd, args, opts };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(result.status, 0);
  assert.deepEqual(call, {
    cmd: 'gh',
    args: ['issue', 'edit', '42', '--title', '新しいタイトル', '--body-file', 'C:\\Temp\\issue-42.md', '--repo', 'owner/repo'],
    opts: { cwd: 'C:\\workspace', encoding: 'utf8' },
  });
});

test('updateIssue: 成功時はbody-fileを削除する', () => {
  const unlinked = [];
  const result = updateIssue(
    { issue: '42', bodyFile: 'C:\\Temp\\issue-42.md', workspace: 'C:\\workspace' },
    {
      ghEditFn: (params) => {
        assert.equal(params.issue, '42');
        assert.equal(params.bodyFile, 'C:\\Temp\\issue-42.md');
        return { status: 0, stdout: '', stderr: '' };
      },
      unlinkBodyFileFn: (file) => unlinked.push(file),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(unlinked, ['C:\\Temp\\issue-42.md']);
});

test('updateIssue: gh失敗時はbody-fileを削除せず、更新成功扱いにしない', () => {
  let unlinkCalled = false;
  const result = updateIssue(
    { issue: '42', bodyFile: 'C:\\Temp\\issue-42.md', workspace: 'C:\\workspace' },
    {
      ghEditFn: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
      unlinkBodyFileFn: () => { unlinkCalled = true; },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(unlinkCalled, false);
  assert.match(result.stderr, /permission denied/);
});

test('update-issue CLI: /tmpの論理パスを実体へ解決し、成功時に削除する', () => {
  withTempWorkspace((workspace) => withLogicalBody('本文 `$VALUE`\n', (logicalPath, physicalPath) => {
    let captured = null;
    const result = main([
      '--issue', '42',
      '--title', '更新タイトル',
      '--body-file', logicalPath,
      '--repo', 'owner/repo',
      '--workspace', workspace,
    ], {
      ghEditFn: (params) => {
        captured = params;
        return { status: 0, stdout: '', stderr: '' };
      },
      unlinkBodyFileFn: (file) => fs.unlinkSync(file),
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ISSUE_UPDATED:42');
    assert.equal(captured.bodyFile, physicalPath);
    assert.equal(captured.workspace, workspace);
    assert.equal(fs.existsSync(physicalPath), false);
  }));
});

test('update-issue CLI: gh失敗時は論理パスの入力を保持する', () => {
  withTempWorkspace((workspace) => withLogicalBody('本文', (logicalPath, physicalPath) => {
    const result = main([
      '--issue', '42', '--body-file', logicalPath, '--workspace', workspace,
    ], {
      ghEditFn: () => ({ status: 1, stderr: 'failed' }),
      unlinkBodyFileFn: (file) => fs.unlinkSync(file),
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /保持/);
    assert.equal(fs.existsSync(physicalPath), true);
  }));
});

test('update-issue CLI: --helpはcode 0でusageを返す', () => {
  const result = main(['--help']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, USAGE);
});

test('update-issue CLI: Issue番号が不正なら外部操作を呼ばない', () => {
  let called = false;
  const result = main(['--issue', '0', '--body-file', '/tmp/body.md'], {
    ghEditFn: () => { called = true; return { status: 0 }; },
  });
  assert.equal(result.code, 1);
  assert.equal(called, false);
  assert.match(result.stderr, /正の整数/);
});
