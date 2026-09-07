'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PREFIX = 'gh-maestro-temp-';
const DEFAULT_MAX_RETRIES = 5;
const MAX_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 1000;

function validateBoundedInteger(name, value, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function resolveOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('temporary directory options must be an object');
  }

  const tempRoot = options.tempRoot === undefined ? os.tmpdir() : options.tempRoot;
  if (typeof tempRoot !== 'string' || !tempRoot) {
    throw new TypeError('tempRoot must be a non-empty string');
  }

  const maxRetries = options.maxRetries === undefined
    ? DEFAULT_MAX_RETRIES
    : validateBoundedInteger('maxRetries', options.maxRetries, MAX_MAX_RETRIES);
  const retryDelay = options.retryDelay === undefined
    ? DEFAULT_RETRY_DELAY_MS
    : validateBoundedInteger('retryDelay', options.retryDelay, MAX_RETRY_DELAY_MS);

  const mkdtempSyncFn = options.mkdtempSyncFn === undefined ? fs.mkdtempSync : options.mkdtempSyncFn;
  const rmSyncFn = options.rmSyncFn === undefined ? fs.rmSync : options.rmSyncFn;
  if (typeof mkdtempSyncFn !== 'function') throw new TypeError('mkdtempSyncFn must be a function');
  if (typeof rmSyncFn !== 'function') throw new TypeError('rmSyncFn must be a function');

  return { tempRoot, maxRetries, retryDelay, mkdtempSyncFn, rmSyncFn };
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix) {
    throw new TypeError('temporary directory prefix must be a non-empty string');
  }
}

function errorDetail(error) {
  return error && error.message ? error.message : String(error);
}

class TempDirectoryCleanupError extends Error {
  constructor(directory, cause) {
    super(`一時ディレクトリの後片付けに失敗しました: ${directory} (${errorDetail(cause)})`);
    this.name = 'TempDirectoryCleanupError';
    this.phase = 'cleanup';
    this.directory = directory;
    this.cause = cause;
  }
}

class TempDirectoryCleanupAggregateError extends AggregateError {
  constructor(errors) {
    super(errors, `一時ディレクトリの後片付けに${errors.length}件失敗しました`);
    this.name = 'TempDirectoryCleanupAggregateError';
    this.phase = 'cleanup';
    this.cleanupErrors = errors;
  }
}

class TempDirectoryBodyAndCleanupError extends AggregateError {
  constructor(bodyError, cleanupError) {
    super([bodyError, cleanupError], '一時ディレクトリの本体処理と後片付けの両方に失敗しました');
    this.name = 'TempDirectoryBodyAndCleanupError';
    this.phase = 'body-and-cleanup';
    this.bodyError = bodyError;
    this.cleanupError = cleanupError;
  }
}

function cleanupOwnedDirectories(owned, options) {
  const errors = [];
  const remaining = [];
  for (const directory of owned) {
    try {
      options.rmSyncFn(directory, {
        recursive: true,
        force: true,
        maxRetries: options.maxRetries,
        retryDelay: options.retryDelay,
      });
    } catch (error) {
      errors.push(new TempDirectoryCleanupError(directory, error));
      remaining.push(directory);
    }
  }
  owned.splice(0, owned.length, ...remaining);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new TempDirectoryCleanupAggregateError(errors);
}

/**
 * Create an owner for temporary directories. Every directory created by
 * scope.mkdtemp is registered before it is returned to the caller.
 *
 * The scope factory exists for test-framework hooks whose lifetime is split
 * across beforeEach/afterEach. Most callers should use withTempDir instead.
 *
 * @param {object} [rawOptions]
 * @returns {{mkdtemp: (prefix?: string) => string, mkdtempAt: (parent: string, prefix?: string) => string, cleanup: () => void}}
 */
function createTempDirScope(rawOptions = {}) {
  const options = resolveOptions(rawOptions);
  const owned = [];
  let closed = false;

  function createOwnedDirectory(parent, prefix) {
    if (closed) throw new Error('temporary directory scope is already closed');
    if (typeof parent !== 'string' || !parent) {
      throw new TypeError('temporary directory parent must be a non-empty string');
    }
    validatePrefix(prefix);
    const directory = options.mkdtempSyncFn(path.join(parent, prefix));
    owned.push(directory);
    return directory;
  }

  function mkdtemp(prefix = DEFAULT_PREFIX) {
    return createOwnedDirectory(options.tempRoot, prefix);
  }

  function mkdtempAt(parent, prefix = DEFAULT_PREFIX) {
    return createOwnedDirectory(parent, prefix);
  }

  function cleanup() {
    if (closed) return;
    cleanupOwnedDirectories(owned, options);
    closed = true;
  }

  return Object.freeze({ mkdtemp, mkdtempAt, cleanup });
}

function finishSuccess(scope, value) {
  scope.cleanup();
  return value;
}

function finishFailure(scope, bodyError) {
  try {
    scope.cleanup();
  } catch (cleanupError) {
    throw new TempDirectoryBodyAndCleanupError(bodyError, cleanupError);
  }
  throw bodyError;
}

/**
 * Run a callback with an owned temporary-directory scope and close it after
 * the callback settles. This supports both synchronous and asynchronous
 * node:test fixtures without allowing a synchronous finally block to race a
 * promise that is still writing into the directory.
 *
 * @param {(scope: {mkdtemp: Function, cleanup: Function}) => unknown} callback
 * @param {object} [rawOptions]
 * @returns {unknown}
 */
function withTempDirScope(callback, rawOptions = {}) {
  if (typeof callback !== 'function') throw new TypeError('temporary directory callback must be a function');
  const scope = createTempDirScope(rawOptions);
  let result;
  try {
    result = callback(scope);
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then(
        (value) => finishSuccess(scope, value),
        (bodyError) => finishFailure(scope, bodyError),
      );
    }
  } catch (bodyError) {
    return finishFailure(scope, bodyError);
  }
  return finishSuccess(scope, result);
}

/**
 * Run a callback with one owned temporary directory and remove it when the
 * callback (including an asynchronous callback) has completed.
 *
 * @param {string} prefix
 * @param {(directory: string) => unknown} callback
 * @param {object} [rawOptions]
 * @returns {unknown}
 */
function withTempDir(prefix, callback, rawOptions = {}) {
  validatePrefix(prefix);
  if (typeof callback !== 'function') throw new TypeError('temporary directory callback must be a function');
  return withTempDirScope((scope) => callback(scope.mkdtemp(prefix)), rawOptions);
}

module.exports = {
  DEFAULT_PREFIX,
  DEFAULT_MAX_RETRIES,
  MAX_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  TempDirectoryCleanupError,
  TempDirectoryCleanupAggregateError,
  TempDirectoryBodyAndCleanupError,
  createTempDirScope,
  withTempDirScope,
  withTempDir,
};
