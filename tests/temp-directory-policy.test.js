'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIRECT_TEMP_USAGE = new Map([
  ['assistant-watch.test.js', 2],
  ['assistants-registry.test.js', 2],
  ['atomic-write.test.js', 2],
  ['cleanup-workspace-registry.test.js', 4],
  ['collect-housekeeping-exclusions.test.js', 2],
  ['comment-issue.test.js', 2],
  ['config.test.js', 6],
  ['council-worktree.test.js', 2],
  ['cycle-metrics.test.js', 2],
  ['doc-ref-check.test.js', 14],
  ['ensure-status-pane.test.js', 2],
  ['env-leak-guard.test.js', 4],
  ['execution-registry.test.js', 2],
  ['finalize-issue.test.js', 10],
  ['finalize-review.test.js', 14],
  ['find-matching-rules.test.js', 2],
  ['gh-maestro-session-hook.test.js', 11],
  ['headless-launch.test.js', 2],
  ['installer.test.js', 67],
  ['json-file.test.js', 3],
  ['junction-safety.test.js', 2],
  ['link-node-modules.test.js', 2],
  ['migration-marker.test.js', 2],
  ['msg-poll.test.js', 2],
  ['msg-read.test.js', 2],
  ['msg-send.test.js', 2],
  ['print-review-leaves.test.js', 2],
  ['process-lifecycle.test.js', 1],
  ['read-state.test.js', 2],
  ['reset-session.test.js', 2],
  ['resident-audit.test.js', 2],
  ['resident-parent-death.test.js', 2],
  ['resolve-agent.test.js', 4],
  ['resolve-config.test.js', 30],
  ['response-contract.test.js', 2],
  ['restart-residents.test.js', 2],
  ['run-council-jobs.test.js', 2],
  ['run-council.test.js', 6],
  ['run-review-jobs.test.js', 103],
  ['run-review-manager.test.js', 2],
  ['running-review-managers.test.js', 2],
  ['spawn-worker.test.js', 20],
  ['start-review-manager.test.js', 1],
  ['status-pane-registry.test.js', 2],
  ['strip-thinking-token-lines.test.js', 2],
  ['sync-rules.test.js', 4],
  ['update-issue.test.js', 2],
  ['watchdog-exit-notify.test.js', 2],
  ['worker-exit-hook.test.js', 2],
  ['worker-lease.test.js', 20],
  ['worker-status.test.js', 4],
  ['worker-supervisor.test.js', 2],
  ['workers-registry.test.js', 2],
  ['workspace-housekeeping.test.js', 14],
  ['workspace.test.js', 22],
  ['write-draft.test.js', 10],
]);

// Detect direct Node temporary-directory calls, while leaving the shared
// scope API available to every test. The expected count is intentionally
// exact: adding a call to an existing exception is a policy failure too.
const DIRECT_TEMP_CALL = /(?:\bfs(?:\.promises)?\.mkdtemp(?:Sync)?|\brequire\(\s*["']fs["']\s*\)(?:\.promises)?\.mkdtemp(?:Sync)?|\bos\.tmpdir|\brequire\(\s*["']os["']\s*\)\.tmpdir|\btmpdir|(?<![\w$.])mkdtemp(?:Sync)?)\s*\(/g;

function directTempUsageCount(source) {
  return [...source.matchAll(DIRECT_TEMP_CALL)].length;
}

test('temporary-directory policy: full層テストの直接一時ディレクトリ利用は既知のallowlistと完全一致する', () => {
  const testsRoot = __dirname;
  const actual = new Map();
  for (const entry of fs.readdirSync(testsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.js')) continue;
    if (entry.name === 'temp-directory-policy.test.js') continue;
    const count = directTempUsageCount(fs.readFileSync(path.join(testsRoot, entry.name), 'utf8'));
    if (count > 0) actual.set(entry.name, count);
  }

  assert.deepEqual(
    [...actual.entries()].sort(),
    [...DIRECT_TEMP_USAGE.entries()].sort(),
    'new or changed direct temp creation must use the shared scope or an explicitly reviewed exact exception',
  );
});
