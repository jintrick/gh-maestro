#!/usr/bin/env node
'use strict';

// OS-agnostic wrapper: signals the daemon to poll immediately.
// Agents call this after updating labels so the daemon reacts without waiting 30s.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') {
  execSync('pm2 trigger agent-runtime poll', { stdio: 'inherit' });
} else {
  const pidFile = path.join(__dirname, '..', '.daemon.pid');
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  execSync(`kill -SIGUSR1 ${pid}`, { stdio: 'inherit' });
}
