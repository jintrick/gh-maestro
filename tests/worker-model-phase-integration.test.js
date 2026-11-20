'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withTempDir } = require('../scripts/shared/temp-directory');
const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');

installLivenessTestAdapter();

const processLiveness = require('../scripts/shared/process-liveness');
const headlessLaunch = require('../scripts/shared/headless-launch');
const closedPrGuard = require('../scripts/shared/closed-pr-guard');
const { clearContract, contractPath } = require('../scripts/shared/response-contract');
const { readImplementationApproval } = require('../scripts/shared/implementation-approval');
const { main: setResponseContract } = require('../scripts/set-response-contract');

test('model phase integration: 計画中の再開・工程6の承認記録・承認後の同一会話再開', () => {
  withTempDir('ghm-model-phase-integration-', workspace => {
    const workerName = 'issue-725-senior-coder-model-phase-integration';
    const skill = 'gh-maestro-senior-coder';
    const agentId = 'codex-model-phase-test';
    const home = path.join(workspace, 'home');
    const worktree = path.join(workspace, '.gh-maestro', 'worktrees', workerName);
    const meta = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(home, '.gh-maestro', 'config.json'), JSON.stringify({
      agents: {
        [agentId]: {
          extends: 'codex',
          extraArgs: ['--config', 'model=implementation-model'],
          planExtraArgs: ['--config', 'model=planning-model'],
        },
      },
    }), 'utf8');

    const originalWorkers = {
      orchestrator: { agentId: null },
      [workerName]: {
        pid: process.pid,
        resourceKey: 'a'.repeat(64),
        instanceId: 'worker-phase-generation',
        startTime: '2026-11-02T00:00:00.000Z',
        logPath: path.join(meta, 'worker.log'),
        agentId,
        issue: 725,
        skill,
        modelPhase: 'planning',
      },
    };
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, 'workers.json'), JSON.stringify(originalWorkers, null, 2), 'utf8');

    const launchArgs = [];
    const originalLaunch = headlessLaunch.launchAgentHeadless;
    headlessLaunch.launchAgentHeadless = ({ argv, cwd, logPath }) => {
      launchArgs.push({ argv: [...argv], cwd, logPath });
      const processRef = processLiveness.captureSelf({ workspace, kind: 'worker', name: workerName });
      return { pid: process.pid, processRef, logPath };
    };
    closedPrGuard._setListFn(() => ({ status: 0, stdout: '[]', stderr: '' }));

    try {
      const supervisor = require('../scripts/worker-supervisor');
      supervisor._setSleep(() => {});

      const deliver = (body) => supervisor.tryResumeAndDeliver({
        workerName,
        agentId,
        skill,
        issue: '725',
        modelPhase: 'planning',
        message: { from: 'orchestrator', body },
        workspace,
        homedir: home,
      });

      const beforeApproval = deliver('plan revision');
      assert.equal(beforeApproval.success, true, beforeApproval.error);
      assert.ok(launchArgs[0].argv.includes('model=planning-model'));
      assert.equal(launchArgs[0].argv.includes('model=implementation-model'), false);
      assert.deepEqual(launchArgs[0].argv.slice(1, 5), [
        'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--config',
      ]);
      assert.ok(launchArgs[0].argv.includes('resume'));
      assert.ok(launchArgs[0].argv.includes('--last'));

      const workersBeforeApproval = fs.readFileSync(path.join(meta, 'workers.json'), 'utf8');
      const approvalResult = setResponseContract([
        '--issue', '725', '--skill', skill, '--type', 'artifact-or-message', '--artifact', 'pr',
        '--workspace', workspace,
      ], {
        prepareScriptGuidanceFn: () => '',
        recordCycleEventFn: () => ({ ok: true }),
      });
      assert.equal(approvalResult.code, 0, approvalResult.errLines.join('\n'));
      assert.equal(fs.readFileSync(path.join(meta, 'workers.json'), 'utf8'), workersBeforeApproval);
      assert.ok(fs.existsSync(contractPath(workspace, workerName)));

      clearContract(workspace, workerName);
      assert.ok(readImplementationApproval(workspace, workerName));

      const afterApproval = deliver('implement approved plan');
      assert.equal(afterApproval.success, true, afterApproval.error);
      assert.ok(launchArgs[1].argv.includes('model=implementation-model'));
      assert.equal(launchArgs[1].argv.includes('model=planning-model'), false);
      assert.ok(launchArgs[1].argv.includes('resume'));
      assert.ok(launchArgs[1].argv.includes('--last'));
      assert.deepEqual(
        launchArgs.map(({ argv }) => argv.slice(argv.indexOf('resume'), argv.indexOf('resume') + 2)),
        [['resume', '--last'], ['resume', '--last']],
        'both launches continue the same CLI session rather than starting a new conversation',
      );
      assert.ok(readImplementationApproval(workspace, workerName), 'approval remains after contract cleanup and resume');
    } finally {
      headlessLaunch.launchAgentHeadless = originalLaunch;
      closedPrGuard._resetListFn();
    }
  });
});
