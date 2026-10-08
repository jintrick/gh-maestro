'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withTempDir } = require('../scripts/shared/temp-directory');

const { main, notifyHuman, USAGE } = require('../scripts/notify-human');
const { resolveHumanNotificationConfig } = require('../scripts/shared/resolve-config');

function withConfigDirs(fn) {
  withTempDir('ghm-notify-', root => {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fn({ home, workspace });
  });
}

function writeConfig(dir, value) {
  fs.writeFileSync(path.join(dir, '.gh-maestro', 'config.json'), JSON.stringify(value), 'utf8');
}

test('human notification config uses defaults and global then workspace overrides', () => {
  withConfigDirs(({ home, workspace }) => {
    writeConfig(home, { humanNotification: { url: 'https://ntfy.sh/global', method: 'PUT' } });
    writeConfig(workspace, { humanNotification: { url: 'https://ntfy.sh/workspace' } });
    assert.deepEqual(resolveHumanNotificationConfig({ home, homedir: home, workspace }), {
      url: 'https://ntfy.sh/workspace', method: 'PUT',
    });
  });
});

test('human notification config rejects an invalid method', () => {
  withConfigDirs(({ home, workspace }) => {
    writeConfig(workspace, { humanNotification: { method: 'POST;bad' } });
    assert.equal(resolveHumanNotificationConfig({ homedir: home, workspace }), null);
  });
});

test('CLI help succeeds without resolving a repository or sending', () => {
  const result = main(['--help'], {
    resolveRepoFn: () => { throw new Error('must not resolve'); },
    spawnSyncFn: () => { throw new Error('must not send'); },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage:/);
  assert.equal(USAGE, result.stdout);
});

test('notification sends repository name as one curl data argument', () => {
  let called;
  const result = main(['--repo', 'owner/project'], {
    resolveRepoFn: ({ repo }) => ({ ok: true, repo }),
    resolveConfigFn: () => ({ url: 'https://ntfy.sh/topic', method: 'POST' }),
    spawnSyncFn: (...args) => { called = args; return { status: 0, stderr: '' }; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(called[0], 'curl');
  assert.deepEqual(called[1], [
    '--fail', '--silent', '--show-error', '--request', 'POST',
    '--data-binary', 'owner/project', 'https://ntfy.sh/topic',
  ]);
});

test('notification reports curl missing and HTTP/network failures without retrying', () => {
  let calls = 0;
  const missingCurl = notifyHuman({ repo: 'owner/project' }, {
    resolveRepoFn: () => ({ ok: true, repo: 'owner/project' }),
    resolveConfigFn: () => ({ url: 'https://ntfy.sh/topic', method: 'POST' }),
    spawnSyncFn: () => { calls++; return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }; },
  });
  assert.equal(missingCurl.exitCode, 1);
  assert.match(missingCurl.stderr, /ENOENT/);
  assert.equal(calls, 1);

  const httpFailure = notifyHuman({ repo: 'owner/project' }, {
    resolveRepoFn: () => ({ ok: true, repo: 'owner/project' }),
    resolveConfigFn: () => ({ url: 'https://ntfy.sh/topic', method: 'POST' }),
    spawnSyncFn: () => ({ status: 22, stderr: 'The requested URL returned error: 500' }),
  });
  assert.equal(httpFailure.exitCode, 1);
  assert.match(httpFailure.stderr, /500/);
});

test('parse errors reject positionals and do not fall through to sending', () => {
  const result = main(['unexpected'], { spawnSyncFn: () => assert.fail('must not send') });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /位置引数/);
});

