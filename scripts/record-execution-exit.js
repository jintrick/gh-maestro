#!/usr/bin/env node
'use strict';

const { markProcessExit } = require('./shared/execution-registry');

const [workspace, executionId, exitCode] = process.argv.slice(2);
if (!workspace || !executionId || exitCode === undefined) {
  process.stderr.write('Usage: record-execution-exit.js <workspace> <execution-id> <exit-code>\n');
  process.exit(1);
}

try {
  markProcessExit(workspace, executionId, exitCode);
} catch (error) {
  process.stderr.write(`record-execution-exit: ${error.message}\n`);
  process.exit(1);
}
