'use strict';

// Shared gh executable shim for tests that exercise spawnSync('gh', ...).
// A copied Node executable is required on Windows because spawnSync does not resolve .cmd files.

const fs = require('node:fs');
const path = require('node:path');
const { copyFileSync, mkdirSync, chmodSync, writeFileSync } = fs;

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function nodeRequireOption(filePath) {
  return `--require="${path.resolve(filePath).replace(/\\/g, '/')}"`;
}

function matchFixture(fixture, args) {
  if (Array.isArray(fixture.match)) {
    return fixture.match.length === args.length && fixture.match.every((part, index) => part === args[index]);
  }
  if (fixture.match && Array.isArray(fixture.match.prefix)) {
    return fixture.match.prefix.length <= args.length
      && fixture.match.prefix.every((part, index) => part === args[index]);
  }
  return false;
}

function appendLog(logPath, record) {
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function readJsonArray(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(value)) throw new Error(`fake gh fixture state must be an array: ${filePath}`);
    return value;
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function readJsonFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '[]';
    throw error;
  }
}

function runFixtureAction(fixture, args, config) {
  if (fixture.action === 'read-base64-json-lines') {
    const values = readJsonArray(fixture.stateFile);
    return { status: 0, stdout: values.map(value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')).join('\n'), stderr: '' };
  }

  if (fixture.action === 'read-json-file') {
    return { status: 0, stdout: readJsonFile(fixture.stateFile), stderr: '' };
  }

  if (fixture.action === 'read-json-pages') {
    const values = readJsonArray(fixture.stateFile);
    return { status: 0, stdout: JSON.stringify([values]), stderr: '' };
  }

  if (fixture.action === 'append-body-file') {
    const bodyFlag = fixture.bodyFlag || '--body-file';
    const bodyIndex = args.indexOf(bodyFlag);
    if (bodyIndex < 0 || typeof args[bodyIndex + 1] !== 'string') {
      return { status: 2, stdout: '', stderr: `fake gh fixture expected ${bodyFlag}\n` };
    }
    const rawTarget = args[bodyIndex + 1];
    const body = (rawTarget === '-' || rawTarget === 'body=@-')
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(rawTarget, 'utf8');
    const value = {
      ...(fixture.fields || {}),
      body,
    };
    const values = readJsonArray(fixture.stateFile);
    values.push(value);
    fs.mkdirSync(path.dirname(fixture.stateFile), { recursive: true });
    fs.writeFileSync(fixture.stateFile, JSON.stringify(values), 'utf8');
    return { status: fixture.status ?? 0, stdout: fixture.stdout || '', stderr: fixture.stderr || '' };
  }

  if (fixture.action === 'write-marker') {
    fs.mkdirSync(path.dirname(fixture.markerPath), { recursive: true });
    fs.writeFileSync(fixture.markerPath, fixture.markerText || 'called', 'utf8');
  }

  return {
    status: fixture.status ?? 0,
    stdout: fixture.stdout || '',
    stderr: fixture.stderr || '',
  };
}

function runFakeGh(config, args = [path.basename(process.argv[1] || ''), ...process.argv.slice(2)]) {
  const record = {
    args,
    cwd: process.cwd(),
    executable: path.resolve(process.execPath),
    pid: process.pid,
  };

  if (args[0] === '__ghm-preflight') {
    const nonce = args[1];
    if (typeof nonce !== 'string' || nonce === '') {
      process.stderr.write('fake gh preflight requires a nonce\n');
      appendLog(config.logPath, { ...record, fixtureMatched: false, status: 2 });
      return 2;
    }
    process.stdout.write(`GHM_FAKE_GH:${nonce}\n`);
    appendLog(config.logPath, { ...record, fixtureMatched: true, status: 0 });
    return 0;
  }

  const fixture = config.fixtures.find(candidate => matchFixture(candidate, args));
  if (!fixture) {
    process.stderr.write(`fake gh rejected an unregistered command: ${JSON.stringify(args)}\n`);
    appendLog(config.logPath, { ...record, fixtureMatched: false, status: 97 });
    return 97;
  }

  let result;
  try {
    result = runFixtureAction(fixture, args, config);
  } catch (error) {
    appendLog(config.logPath, { ...record, fixtureMatched: true, status: 97, fixtureError: error.message });
    throw error;
  }
  appendLog(config.logPath, { ...record, fixtureMatched: true, status: result.status });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status;
}

function createFakeGh({
  binDir,
  fixtures = [],
  logPath = path.join(binDir || process.cwd(), 'fake-gh-calls.jsonl'),
  baseEnv = process.env,
  extraEnv = {},
} = {}) {
  if (typeof binDir !== 'string' || binDir === '') throw new TypeError('createFakeGh requires binDir');
  if (!Array.isArray(fixtures)) throw new TypeError('fake gh fixtures must be an array');
  const resolvedBinDir = path.resolve(binDir);
  const resolvedLogPath = path.resolve(logPath);
  const executablePath = path.join(resolvedBinDir, process.platform === 'win32' ? 'gh.exe' : 'gh');
  const bootstrapPath = path.join(resolvedBinDir, 'fake-gh-bootstrap.js');
  const helperPath = __filename;

  mkdirSync(resolvedBinDir, { recursive: true });
  mkdirSync(path.dirname(resolvedLogPath), { recursive: true });
  writeFileSync(bootstrapPath, [
    "'use strict';",
    `const config = ${JSON.stringify({
      executablePath,
      logPath: resolvedLogPath,
      fixtures,
    })};`,
    `const helper = require(${JSON.stringify(helperPath)});`,
    'if (helper.samePath(process.execPath, config.executablePath)) process.exit(helper.runFakeGh(config));',
    '',
  ].join('\n'), 'utf8');
  copyFileSync(process.execPath, executablePath);
  if (process.platform !== 'win32') chmodSync(executablePath, 0o755);

  const env = {
    ...baseEnv,
    ...extraEnv,
    PATH: `${resolvedBinDir}${path.delimiter}${(extraEnv.PATH ?? baseEnv.PATH) || ''}`,
    NODE_OPTIONS: [baseEnv.NODE_OPTIONS, extraEnv.NODE_OPTIONS, nodeRequireOption(bootstrapPath)]
      .filter(value => typeof value === 'string' && value !== '')
      .join(' '),
  };

  return {
    binDir: resolvedBinDir,
    executablePath,
    bootstrapPath,
    logPath: resolvedLogPath,
    env,
    readCalls() {
      try {
        return fs.readFileSync(resolvedLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      } catch (error) {
        if (error && error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

module.exports = {
  createFakeGh,
  matchFixture,
  runFakeGh,
  samePath,
};
