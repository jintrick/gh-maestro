'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planMigration } = require('../scripts/migrate-records');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-migrate-records-'));
  fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
  return dir;
}

test('migration is dry-run safe and then idempotent', () => {
  const dir = workspace();
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', 'issue-5-coder-fix.log');
  const oldWatch = path.join(dir, '.gh-maestro', 'assistant-watch', '5.json');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.mkdirSync(path.dirname(oldWatch), { recursive: true });
  fs.writeFileSync(oldLog, 'log\n');
  fs.writeFileSync(oldWatch, '{"prs":{}}');

  const preview = planMigration(dir, 'all', { dryRun: true });
  assert.equal(preview.moved.length, 2);
  assert.equal(fs.existsSync(oldLog), true);
  assert.equal(fs.existsSync(oldWatch), true);

  const applied = planMigration(dir, 'all');
  assert.equal(applied.moved.length, 2);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(oldWatch), false);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-coder-fix', 'worker.log')), true);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'assistant-watch.json')), true);

  const rerun = planMigration(dir, 'all');
  assert.equal(rerun.moved.length, 0);
  assert.equal(rerun.alreadyMigrated.length, 0);
});

test('migration reports differing destination content as a conflict without overwrite', () => {
  const dir = workspace();
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', 'issue-5-coder-fix.log');
  const destination = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-coder-fix', 'worker.log');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(oldLog, 'old');
  fs.writeFileSync(destination, 'new');

  const result = planMigration(dir, 'worker-log');
  assert.equal(result.conflicts.length, 1);
  assert.equal(fs.readFileSync(oldLog, 'utf8'), 'old');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
});

test('migration holds a worker log owned by a live workers.json process', () => {
  const dir = workspace();
  const workerName = 'issue-5-coder-fix';
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', `${workerName}.log`);
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, 'live\n');
  fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
    [workerName]: { pid: process.pid },
  }));

  const result = planMigration(dir, 'worker-log', { dryRun: true });
  assert.equal(result.held.length, 1);
  assert.equal(result.moved.length, 0);
  assert.equal(fs.existsSync(oldLog), true);
});
