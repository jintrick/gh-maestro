'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parseFrontmatter } = require('../scripts/sync-rules');
const { withTempDir } = require('../scripts/shared/temp-directory');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_DIR = path.join(ROOT, 'scripts');
const GUIDE_DIR = path.join(ROOT, 'skills', 'gh-maestro-orchestrator');

const CASES = [
  {
    script: 'create-issue.js',
    guide: 'stage-2-research.md',
    signal: 'implementation-issue',
    heading: '# 工程 2. 必要な調査【任意】',
    args: (workspace) => [
      '--title', 'CLI guidance probe', '--body-file', path.join(workspace, 'missing-body.md'),
      '--repo', 'owner/repo', '--workspace', workspace,
    ],
  },
  {
    script: 'update-issue.js',
    guide: 'stage-2-research.md',
    signal: 'requirements-updated',
    heading: '# 工程 2. 必要な調査【任意】',
    args: (workspace) => [
      '--issue', '42', '--body-file', path.join(workspace, 'missing-body.md'),
      '--repo', 'owner/repo', '--workspace', workspace,
    ],
  },
  {
    script: 'spawn-worker.js',
    guide: 'stage-3-architect.md',
    signal: 'architect-start',
    heading: '# 工程 3. Architect起動判断【必須】',
    args: (workspace) => [
      '--skill', 'gh-maestro-architect', '--issue', '42', '--description', 'guidance-probe',
      '--repo', 'owner/repo', '--session-id', 'missing-session', '--workspace', workspace,
    ],
  },
  {
    script: 'spawn-worker.js',
    guide: 'stage-4-coder.md',
    signal: 'coder-start',
    heading: '# 工程 4. Coder起動【必須】',
    args: (workspace) => [
      '--skill', 'gh-maestro-coder', '--issue', '42', '--description', 'guidance-probe',
      '--repo', 'owner/repo', '--session-id', 'missing-session', '--workspace', workspace,
    ],
  },
  {
    script: 'set-response-contract.js',
    guide: 'stage-6-implementation-start.md',
    signal: 'implementation-approved',
    heading: '# 工程 6. 実装開始指示【必須】',
    args: (workspace) => [
      '--issue', '42', '--skill', 'gh-maestro-coder', '--type', 'artifact-or-message',
      '--artifact', 'pr', '--workspace', workspace,
    ],
  },
  {
    script: 'create-issue.js',
    guide: 'lightweight-pr.md',
    signal: 'lightweight-anchor',
    heading: '# 軽量PR経路',
    args: (workspace) => [
      '--title', 'CLI guidance probe', '--body-file', path.join(workspace, 'missing-body.md'),
      '--repo', 'owner/repo', '--workspace', workspace,
    ],
  },
  {
    script: 'activate-pr-monitor.js',
    guide: 'lightweight-pr.md',
    signal: 'lightweight-pr',
    heading: '# 軽量PR経路',
    args: (workspace) => [
      '--issue', '42', '--workspace', workspace, '--no-review-manager', '--no-review-events',
    ],
  },
];

function createWorkspace(root) {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  const skillTarget = path.join(workspace, '.claude', 'skills', 'gh-maestro-orchestrator');
  fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
  fs.cpSync(GUIDE_DIR, skillTarget, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gh-maestro', 'workers.json'), JSON.stringify({
    'issue-42-implement': {
      paneId: '42', agentId: 'test-agent', issue: 42, skill: 'gh-maestro-coder',
    },
  }), 'utf8');
  return workspace;
}

function runCli(script, args, workspace) {
  return spawnSync(process.execPath, [path.join(SCRIPT_DIR, script), ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_MAESTRO_WORKER: 'orchestrator',
      GH_MAESTRO_RUNTIME_DIR: path.join(path.dirname(workspace), 'runtime'),
    },
  });
}

test('宣言された全script合図は実際のCLI argvで手順書をstdoutへ出し、合図なしでは出さない', () => {
  withTempDir('ghm-guidance-cli-', (root) => {
    const workspace = createWorkspace(root);
    const unflagged = new Map();
    const declaredSignals = fs.readdirSync(GUIDE_DIR)
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) => parseFrontmatter(fs.readFileSync(path.join(GUIDE_DIR, file), 'utf8')).signals || [])
      .filter((signal) => signal.startsWith('script:'))
      .sort();
    const testedSignals = CASES.map(({ script, signal }) => `script:${script}:${signal}`).sort();
    assert.deepEqual(testedSignals, declaredSignals, 'every declared script signal is exercised through its CLI');

    for (const { script, guide, signal, heading, args } of CASES) {
      const declared = parseFrontmatter(fs.readFileSync(path.join(GUIDE_DIR, guide), 'utf8')).signals;
      assert.ok(declared.includes(`script:${script}:${signal}`), `${guide} declares ${script}:${signal}`);

      const flagged = runCli(script, [...args(workspace), '--guidance-signal', signal], workspace);
      assert.equal(flagged.error, undefined, `${script} process should start`);
      assert.ok(flagged.stdout.includes(heading), `${script} accepted --guidance-signal ${signal} and printed its independent heading; stderr=${flagged.stderr}`);
      assert.ok(flagged.stdout.length <= 9000, `${script}:${signal} stdout remains within the guidance limit`);

      if (!unflagged.has(script)) {
        const plain = runCli(script, args(workspace), workspace);
        assert.equal(plain.error, undefined, `${script} process should start without a signal`);
        assert.ok(!plain.stdout.includes(heading), `${script} printed guidance without --guidance-signal`);
        unflagged.set(script, true);
      }
    }
  });
});

test('guidance-signal CLI help matches the enabled command surface', () => {
  const setContractHelp = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'set-response-contract.js'), '--help'], { encoding: 'utf8' });
  assert.equal(setContractHelp.status, 0);
  assert.match(setContractHelp.stdout, /--guidance-signal/);

  const msgSendHelp = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'msg-send.js'), '--help'], { encoding: 'utf8' });
  assert.equal(msgSendHelp.status, 0);
  assert.doesNotMatch(msgSendHelp.stdout, /--guidance-signal/);
});
