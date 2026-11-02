'use strict';

// This preload is active only in the GH-Maestro CLI process selected by the E2E
// helper. It keeps the real argument builders and headless process boundary while
// replacing the task text with a one-response prompt and recording the argv.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const scriptsRoot = path.resolve(process.env.GHM_MODEL_PHASE_E2E_SCRIPTS_ROOT || '');
const entryPath = path.resolve(process.argv[1] || '');
const allowedEntries = new Set([
  path.join(scriptsRoot, 'spawn-worker.js'),
  path.join(scriptsRoot, 'worker-supervisor.js'),
  path.join(scriptsRoot, 'msg-send.js'),
]);
if (!allowedEntries.has(entryPath)) return;
const isLaunchEntry = entryPath === path.join(scriptsRoot, 'spawn-worker.js')
  || entryPath === path.join(scriptsRoot, 'worker-supervisor.js');

const capturePath = process.env.GHM_MODEL_PHASE_E2E_CAPTURE;
const lowerAgentId = process.env.GHM_MODEL_PHASE_E2E_AGENT;
const planAgentId = process.env.GHM_MODEL_PHASE_E2E_PLAN_AGENT;
const launchKind = process.env.GHM_MODEL_PHASE_E2E_LAUNCH_KIND;
const agyLogDir = process.env.GHM_MODEL_PHASE_E2E_AGY_LOG_DIR;
const safePrompt = launchKind === 'resume'
  ? 'For this CLI verification, do not use tools or access files. Reply exactly: GHM725_MODEL_PHASE_RESUME_OK'
  : 'For this CLI verification, do not use tools or access files. Reply exactly: GHM725_MODEL_PHASE_START_OK';

function recordLaunch(params) {
  if (typeof capturePath !== 'string' || capturePath === '') {
    throw new Error('GHM_MODEL_PHASE_E2E_CAPTURE is required for the CLI E2E preload');
  }
  const argv = [...params.argv];
  const promptFileFlag = argv.indexOf('--append-system-prompt-file');
  if (promptFileFlag >= 0 && typeof argv[promptFileFlag + 1] === 'string') {
    fs.writeFileSync(argv[promptFileFlag + 1], safePrompt, 'utf8');
  }
  const systemPromptFlag = argv.indexOf('--append-system-prompt');
  if (systemPromptFlag >= 0 && typeof argv[systemPromptFlag + 1] === 'string') {
    argv[systemPromptFlag + 1] = safePrompt;
  }
  if (argv.length > 1) argv[argv.length - 1] = safePrompt;

  let cliLogPath = null;
  if (argv[0] === 'agy') {
    if (!agyLogDir || !['start', 'resume'].includes(launchKind)) {
      throw new Error('Antigravity E2E requires a phase-specific temporary --log-file');
    }
    cliLogPath = path.join(agyLogDir, `${launchKind}.log`);
    const insertAt = argv.findIndex((arg, index) => index > 0 && ['--continue', '--print'].includes(arg));
    argv.splice(insertAt < 0 ? argv.length : insertAt, 0, '--log-file', cliLogPath);
  }

  fs.mkdirSync(path.dirname(capturePath), { recursive: true });
  fs.appendFileSync(capturePath, `${JSON.stringify({
    kind: launchKind,
    argv,
    cwd: params.cwd,
    logPath: params.logPath,
    cliLogPath,
  })}\n`, 'utf8');
  return { ...params, argv };
}

const originalLoad = Module._load;
Module._load = function loadWithModelPhaseE2e(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (!parent || path.resolve(parent.filename) !== entryPath) return loaded;

  let resolved;
  try {
    resolved = path.resolve(Module._resolveFilename(request, parent, isMain));
  } catch {
    return loaded;
  }

  if (isLaunchEntry && resolved === path.join(scriptsRoot, 'shared', 'resolve-config.js')) {
    const originalResolve = loaded.resolveAgentConfig;
    return {
      ...loaded,
      resolveAgentConfig(agentId, options) {
        const agent = originalResolve(agentId, options);
        if (!agent || agentId !== lowerAgentId) return agent;
        const planAgent = originalResolve(planAgentId, options);
        if (!planAgent || planAgent.runtime !== agent.runtime) {
          throw new Error(`plan agent ${planAgentId} is not available for ${lowerAgentId}`);
        }
        return {
          ...agent,
          resolvedPhaseArgs: {
            ...(agent.resolvedPhaseArgs || {}),
            planning: [...planAgent.extraArgs],
          },
        };
      },
    };
  }

  if (isLaunchEntry && resolved === path.join(scriptsRoot, 'shared', 'headless-launch.js')) {
    const originalLaunch = loaded.launchAgentHeadless;
    return {
      ...loaded,
      launchAgentHeadless(params) {
        return originalLaunch(recordLaunch(params));
      },
    };
  }

  if (resolved === path.join(scriptsRoot, 'shared', 'ensure-worker-supervisor.js')) {
    return { ...loaded, ensureWorkerSupervisorRunning() {} };
  }

  if (resolved === path.join(scriptsRoot, 'shared', 'ensure-status-pane.js')) {
    return {
      ...loaded,
      ensureStatusPane() { return { ok: true, skipped: true }; },
      formatEnsureStatusPaneFailure() { return ''; },
    };
  }

  if (resolved === path.join(scriptsRoot, 'shared', 'skill-install-path.js') && agentIdForRunIsAgy()) {
    const safeSkill = process.env.GHM_MODEL_PHASE_E2E_AGY_SKILL;
    return {
      ...loaded,
      resolveSkillMdPath(runtime, _cli, skillName) {
        if (runtime === 'agy' && skillName === 'gh-maestro-senior-coder') return safeSkill;
        return loaded.resolveSkillMdPath(runtime, _cli, skillName);
      },
    };
  }

  return loaded;
};

function agentIdForRunIsAgy() {
  return typeof lowerAgentId === 'string' && lowerAgentId.startsWith('agy-');
}
