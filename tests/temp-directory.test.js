'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  MAX_MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  TempDirectoryCleanupError,
  TempDirectoryCleanupAggregateError,
  TempDirectoryBodyAndCleanupError,
  createTempDirScope,
  withTempDir,
} = require('../scripts/shared/temp-directory');

test('withTempDir: 同期コールバック中は存在し、完了後に削除される', () => {
  let directory;
  const result = withTempDir('ghm-temp-directory-sync-', (dir) => {
    directory = dir;
    assert.equal(fs.existsSync(dir), true);
    fs.writeFileSync(path.join(dir, 'created-during-callback.txt'), 'done', 'utf8');
    assert.equal(fs.existsSync(path.join(dir, 'created-during-callback.txt')), true);
    return 'callback-result';
  });

  assert.equal(result, 'callback-result');
  assert.equal(fs.existsSync(directory), false);
});

test('withTempDir: 非同期コールバックの完了後に削除される', async () => {
  let directory;
  const result = await withTempDir('ghm-temp-directory-async-', async (dir) => {
    directory = dir;
    assert.equal(fs.existsSync(dir), true);
    await new Promise((resolve) => setImmediate(resolve));
    fs.writeFileSync(path.join(dir, 'created-after-await.txt'), 'done', 'utf8');
    assert.equal(fs.existsSync(path.join(dir, 'created-after-await.txt')), true);
    return 'async-result';
  });

  assert.equal(result, 'async-result');
  assert.equal(fs.existsSync(directory), false);
});

test('withTempDir: 本体エラーだけなら元のエラーを維持する', () => {
  const bodyError = new Error('body failed');
  assert.throws(
    () => withTempDir('ghm-temp-directory-body-', () => { throw bodyError; }),
    (error) => error === bodyError,
  );
});

test('withTempDir: 後片付け単独の失敗はcleanupとして失敗する', () => {
  const cleanupCause = new Error('remove failed');
  let removedPath;
  assert.throws(
    () => withTempDir('ghm-temp-directory-cleanup-', () => 'success', {
      mkdtempSyncFn: () => 'fake-temp-directory',
      rmSyncFn: (directory) => {
        removedPath = directory;
        throw cleanupCause;
      },
    }),
    (error) => {
      assert.ok(error instanceof TempDirectoryCleanupError);
      assert.equal(error.phase, 'cleanup');
      assert.equal(error.directory, 'fake-temp-directory');
      assert.equal(error.cause, cleanupCause);
      assert.match(error.message, /後片付けに失敗/);
      return true;
    },
  );
  assert.equal(removedPath, 'fake-temp-directory');
});

test('withTempDir: 本体と後片付けの失敗を専用の二重失敗として区別する', () => {
  const bodyError = new Error('body failed');
  const cleanupCause = new Error('remove failed');
  assert.throws(
    () => withTempDir('ghm-temp-directory-both-', () => { throw bodyError; }, {
      mkdtempSyncFn: () => 'fake-temp-directory',
      rmSyncFn: () => { throw cleanupCause; },
    }),
    (error) => {
      assert.ok(error instanceof TempDirectoryBodyAndCleanupError);
      assert.equal(error.phase, 'body-and-cleanup');
      assert.equal(error.bodyError, bodyError);
      assert.ok(error.cleanupError instanceof TempDirectoryCleanupError);
      assert.equal(error.cleanupError.cause, cleanupCause);
      assert.deepEqual(error.errors, [bodyError, error.cleanupError]);
      return true;
    },
  );
});

test('scope.cleanup: 複数対象は一部が失敗しても全件を試行し、失敗を集約する', () => {
  const removed = [];
  const causes = new Map([
    ['fake-first', new Error('first remove failed')],
    ['fake-second', new Error('second remove failed')],
  ]);
  const scope = createTempDirScope({
    mkdtempSyncFn: (prefix) => prefix.includes('first') ? 'fake-first' : 'fake-second',
    rmSyncFn: (directory) => {
      removed.push(directory);
      throw causes.get(directory);
    },
  });
  scope.mkdtemp('first-');
  scope.mkdtemp('second-');

  assert.throws(
    () => scope.cleanup(),
    (error) => {
      assert.ok(error instanceof TempDirectoryCleanupAggregateError);
      assert.equal(error.phase, 'cleanup');
      assert.deepEqual(removed, ['fake-first', 'fake-second']);
      assert.deepEqual(error.cleanupErrors.map((item) => item.directory), removed);
      assert.ok(error.cleanupErrors.every((item) => item instanceof TempDirectoryCleanupError));
      assert.deepEqual(error.cleanupErrors.map((item) => item.cause), removed.map((directory) => causes.get(directory)));
      assert.deepEqual(error.errors, error.cleanupErrors);
      return true;
    },
  );
});

test('scope.cleanup: 失敗した所有物だけを次回cleanupで再試行する', () => {
  const calls = [];
  let failed = true;
  const scope = createTempDirScope({
    mkdtempSyncFn: () => 'retry-target',
    rmSyncFn: (directory) => {
      calls.push(directory);
      if (failed) {
        failed = false;
        throw new Error('retryable remove failure');
      }
    },
  });
  scope.mkdtemp('retry-');

  assert.throws(() => scope.cleanup(), TempDirectoryCleanupError);
  assert.doesNotThrow(() => scope.cleanup());
  assert.deepEqual(calls, ['retry-target', 'retry-target']);
  assert.doesNotThrow(() => scope.cleanup(), '成功後のcleanupは冪等である');
  assert.deepEqual(calls, ['retry-target', 'retry-target']);
});

test('scope.mkdtemp: 作成と同時に所有登録し、cleanupで回収する', () => {
  const created = [];
  const removed = [];
  const scope = createTempDirScope({
    mkdtempSyncFn: (prefix) => {
      created.push(prefix);
      return prefix;
    },
    rmSyncFn: (directory) => removed.push(directory),
  });

  const first = scope.mkdtemp('first-');
  const second = scope.mkdtempAt('parent', 'second-');
  scope.cleanup();

  assert.deepEqual(created, [created[0], 'parent' + path.sep + 'second-']);
  assert.deepEqual(removed, [first, second]);
});

test('cleanup options: 既定値と上限、型の検証を固定する', () => {
  assert.equal(DEFAULT_MAX_RETRIES, 5);
  assert.equal(DEFAULT_RETRY_DELAY_MS, 100);
  assert.equal(MAX_MAX_RETRIES, 5);
  assert.equal(MAX_RETRY_DELAY_MS, 1000);

  for (const value of [null, true, '5', NaN, Infinity, -1, 1.5, MAX_MAX_RETRIES + 1]) {
    assert.throws(() => createTempDirScope({ maxRetries: value }), RangeError);
  }
  for (const value of [null, false, '100', NaN, Infinity, -1, 1.5, MAX_RETRY_DELAY_MS + 1]) {
    assert.throws(() => createTempDirScope({ retryDelay: value }), RangeError);
  }

  let optionsSeen;
  const scope = createTempDirScope({
    maxRetries: 2,
    retryDelay: 7,
    mkdtempSyncFn: () => 'fake-temp-directory',
    rmSyncFn: (_directory, options) => { optionsSeen = options; },
  });
  scope.mkdtemp('accepted-');
  scope.cleanup();
  assert.deepEqual(optionsSeen, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 7,
  });
});
