'use strict';

const path = require('path');

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmScriptCommand(script) {
  return `npm run ${script}`;
}

function runNpmScript({ script, cwd, env, spawnSyncFn, envOverrides = {}, platform = process.platform }) {
  const command = npmScriptCommand(script);
  try {
    const child = spawnSyncFn(npmCommand(platform), ['run', '--silent', script], {
      cwd: path.resolve(cwd),
      env: { ...env, ...envOverrides },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: platform === 'win32',
    }) || {};
    return {
      command,
      status: Number.isInteger(child.status) && child.status >= 0 ? child.status : null,
      error: child.error || null,
      stdout: child.stdout === undefined || child.stdout === null ? '' : String(child.stdout),
      stderr: child.stderr === undefined || child.stderr === null ? '' : String(child.stderr),
    };
  } catch (error) {
    return { command, status: null, error, stdout: '', stderr: '' };
  }
}

module.exports = { npmCommand, npmScriptCommand, runNpmScript };
