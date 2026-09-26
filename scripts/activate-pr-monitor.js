#!/usr/bin/env node
'use strict';

// Usage: node activate-pr-monitor.js --issue <N> [--workspace <path>]
//        [--session-pid <pid>] [--base-branch <branch>]
//        [--no-review-manager] [--no-review-events]

const {
  resolveWorkspace,
  parseFlags,
} = require('./shared/workspace');
const {
  createPrMonitorTarget,
  writePrMonitorTarget,
} = require('./shared/pr-monitor-target');
const {
  resolveSessionPid,
  getProcessStartTime,
} = require('./process-lifecycle');

const USAGE = `activate-pr-monitor.js — plugin monitor のPR監視対象を設定する

Usage: node activate-pr-monitor.js --issue <N> [--workspace <path>]
       [--session-pid <pid>] [--base-branch <branch>]
       [--no-review-manager] [--no-review-events]

Options:
  --issue <N>              監視対象の Issue 番号（必須）
  --workspace <path>       ワークスペースパス
  --session-pid <pid>      対話型セッションのPID（省略時は自動検出）
  --base-branch <branch>   PRの期待ベースブランチ
  --no-review-manager      PR検出時にReview Managerを起動しない
  --no-review-events       inline review comments・formal reviewsを監視しない
  --help, -h               このヘルプを表示する`;

function positiveIssue(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function parseCli(argv) {
  let values;
  let rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: {
        '--issue': {},
        '--workspace': {},
        '--session-pid': {},
        '--base-branch': {},
      },
      booleans: ['--no-review-manager', '--no-review-events', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { help: true };
    return { help: false, errors: error.errors };
  }
  return {
    help: values['--help'] === true || values['-h'] === true,
    errors: [],
    values,
    rest,
  };
}

function run(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseCli(argv);
  const writeOut = deps.writeOut || ((line) => process.stdout.write(`${line}\n`));
  const writeErr = deps.writeErr || ((line) => process.stderr.write(`${line}\n`));
  if (parsed.help) {
    writeOut(USAGE);
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) writeErr(`activate-pr-monitor: ${error.message}`);
    writeErr(USAGE);
    return 1;
  }

  const values = parsed.values;
  const issue = values['--issue'];
  if (!positiveIssue(issue)) {
    writeErr('activate-pr-monitor: --issue には正の整数を指定してください');
    writeErr(USAGE);
    return 1;
  }
  const workspace = (deps.resolveWorkspaceFn || resolveWorkspace)(values['--workspace']);
  if (!workspace) {
    writeErr('activate-pr-monitor: ワークスペースを解決できません。--workspace を指定してください');
    return 1;
  }

  let sessionPid = resolveSessionPid(values['--session-pid']);
  if (!Number.isInteger(sessionPid) || sessionPid <= 0) sessionPid = null;
  const getStartTime = deps.getProcessStartTimeFn || getProcessStartTime;
  const sessionStartTime = sessionPid ? getStartTime(sessionPid) : null;
  const target = createPrMonitorTarget({
    issue,
    baseBranch: values['--base-branch'] || null,
    noReviewManager: values['--no-review-manager'] === true,
    noReviewEvents: values['--no-review-events'] === true,
    sessionPid,
    sessionStartTime,
  });
  const writeTarget = deps.writeTargetFn || writePrMonitorTarget;
  writeTarget(workspace, target);
  writeOut(`PR_MONITOR_TARGET_SET:${JSON.stringify({ workspace, ...target })}`);
  return 0;
}

module.exports = { USAGE, parseCli, run };

if (require.main === module) process.exitCode = run();
