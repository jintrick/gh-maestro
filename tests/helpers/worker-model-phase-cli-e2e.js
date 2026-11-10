#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseFlags } = require('../../scripts/shared/workspace');
const { buildLoginShellExecArgs } = require('../../scripts/shared/agent-exec');
const { resolveAgentConfig } = require('../../scripts/shared/resolve-config');
const { readCycleEvents } = require('../../scripts/shared/cycle-metrics');
const { readImplementationApproval, implementationApprovalPath } = require('../../scripts/shared/implementation-approval');
const { contractPath } = require('../../scripts/shared/response-contract');
const { createFakeGh, samePath } = require('./fake-gh');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, 'scripts');
const PRELOAD_PATH = path.join(__dirname, 'worker-model-phase-cli-e2e-preload.js');
const SPEC = {
  flags: { '--agent': {}, '--plan-agent': {} },
  booleans: ['--help', '-h', '--preflight-only'],
  positionals: { min: 0, max: 0 },
};
const USAGE = `worker-model-phase-cli-e2e.js — GH-Maestro経由で実エージェントCLIのモデル切替を確認する

Usage:
  $env:GH_MAESTRO_RUNTIME_DIR = Join-Path $env:TEMP ("ghm725-runtime-<cli>-" + [guid]::NewGuid().ToString("N"))
  node tests/helpers/worker-model-phase-cli-e2e.js --agent <regular-agent> --plan-agent <planning-agent>
  node tests/helpers/worker-model-phase-cli-e2e.js --agent <regular-agent> --plan-agent <planning-agent> --preflight-only

Options:
  --agent <id>       ~/.gh-maestro/config.json に定義済みの通常モデルの agent ID
  --plan-agent <id>  ~/.gh-maestro/config.json に定義済みの計画モデルの agent ID
  --preflight-only   CLIを起動せず、fake gh とログインシェル経路だけを確認する
  --help, -h         このヘルプを表示する`;

function fail(message) {
  const error = new Error(message);
  error.code = 1;
  throw error;
}

function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { help: true };
    fail(error.errors.map(item => item.message).join('\n'));
  }
  if (values['--help'] || values['-h']) return { help: true };
  if (!values['--agent']) fail('--agent が必要です');
  if (!values['--plan-agent']) fail('--plan-agent が必要です');
  return {
    help: false,
    preflightOnly: values['--preflight-only'] === true,
    agentId: values['--agent'],
    planAgentId: values['--plan-agent'],
  };
}

function commandResult(result) {
  return {
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    spawnError: result.error ? result.error.message : null,
  };
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) return { ...commandResult(result), stdout: result.stdout || '', stderr: result.stderr || '' };
  return { ...commandResult(result), stdout: result.stdout || '', stderr: result.stderr || '' };
}

function homedir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function userAgentConfigPath() {
  return path.join(homedir(), '.gh-maestro', 'config.json');
}

function resolvePair(agentId, planAgentId) {
  const configPath = userAgentConfigPath();
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`~/.gh-maestro/config.json を読めません: ${error.message}`);
  }
  if (!config.agents || typeof config.agents !== 'object'
      || !Object.prototype.hasOwnProperty.call(config.agents, agentId)
      || !Object.prototype.hasOwnProperty.call(config.agents, planAgentId)) {
    fail('指定した両方の agent ID が ~/.gh-maestro/config.json の agents に定義されていません');
  }

  const regular = resolveAgentConfig(agentId, { homedir: homedir() });
  const planning = resolveAgentConfig(planAgentId, { homedir: homedir() });
  if (!regular || !planning) fail('config.json の agent 定義を解決できません');
  if (regular.runtime !== planning.runtime || regular.command !== planning.command) {
    fail('通常モデルと計画モデルは同じ CLI command/runtime である必要があります');
  }
  if (!['codex', 'claude', 'agy'].includes(regular.runtime)) {
    fail(`対象外 runtime です: ${regular.runtime}`);
  }
  if (!Array.isArray(regular.extraArgs) || !Array.isArray(planning.extraArgs)) {
    fail('解決済み agent.extraArgs が配列ではありません');
  }
  return { regular, planning, configPath };
}

function hashFile(filePath) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertRuntimeDir() {
  const runtimeDir = process.env.GH_MAESTRO_RUNTIME_DIR;
  if (!runtimeDir) fail('GH_MAESTRO_RUNTIME_DIR を一時領域に設定してください');
  const resolvedRuntime = path.resolve(runtimeDir);
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const sharedRuntime = path.resolve(localAppData, 'gh-maestro', 'runtime-v1');
  if (samePath(resolvedRuntime, sharedRuntime)) {
    fail('GH_MAESTRO_RUNTIME_DIR が共有 runtime-v1 を指しています');
  }
  fs.mkdirSync(resolvedRuntime, { recursive: true });
  return resolvedRuntime;
}

function assertStatus(result, description) {
  if (result.spawnError || result.exitCode !== 0) {
    fail(`${description} に失敗しました (exitCode=${result.exitCode}, spawnError=${result.spawnError || 'none'})`);
  }
}

function verifyFakeGhPreflight(fakeGh, env, nonce) {
  const fakeStat = fs.statSync(fakeGh.executablePath);
  const nodeStat = fs.statSync(process.execPath);
  if (!samePath(fakeGh.env.PATH.split(path.delimiter)[0], fakeGh.binDir)) {
    fail('PATH の先頭が fake gh bin ではありません');
  }
  if (fakeStat.size !== nodeStat.size || hashFile(fakeGh.executablePath) !== hashFile(process.execPath)) {
    fail('fake gh executable が process.execPath のコピーではありません');
  }
  if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes(fakeGh.bootstrapPath.replace(/\\/g, '/'))) {
    fail('NODE_OPTIONS に fake-gh bootstrap がありません');
  }

  const nodeCall = runCommand('gh', ['__ghm-preflight', nonce], { env, cwd: REPO_ROOT });
  assertStatus(nodeCall, 'Node spawnSync fake-gh preflight');
  if (nodeCall.stdout.trim() !== `GHM_FAKE_GH:${nonce}`) {
    fail('Node spawnSync preflight が fake-gh nonce を返しませんでした');
  }

  if (process.platform === 'win32') {
    const expectedSource = fakeGh.executablePath.replace(/'/g, "''");
    const sourceCheck = runCommand('pwsh', [
      '-NoLogo', '-Command',
      `$ErrorActionPreference = 'Stop'; $cmd = Get-Command gh -ErrorAction Stop; if ($cmd.CommandType -ne 'Application') { throw "gh resolved to $($cmd.CommandType)" }; $source = [IO.Path]::GetFullPath($cmd.Source); if ($source -ine [IO.Path]::GetFullPath('${expectedSource}')) { throw "gh resolved to $source" }; Write-Output "GHM_FAKE_GH_SOURCE:$source"`,
    ], { env, cwd: REPO_ROOT });
    assertStatus(sourceCheck, 'profile-loaded pwsh Get-Command gh preflight');
    if (!sourceCheck.stdout.toLowerCase().includes(`ghm_fake_gh_source:${fakeGh.executablePath}`.toLowerCase())) {
      fail('profile-loaded pwsh did not resolve gh to fake-bin/gh.exe');
    }

    const shellArgs = buildLoginShellExecArgs(['gh', '__ghm-preflight', nonce], process.platform);
    if (shellArgs[0].toLowerCase() !== 'pwsh' || shellArgs[1] !== '-NoLogo'
        || shellArgs[2] !== '-EncodedCommand') {
      fail('agent launch login-shell path is not the expected pwsh -EncodedCommand form');
    }
    const pwshCall = runCommand(shellArgs[0], shellArgs.slice(1), { env, cwd: REPO_ROOT });
    assertStatus(pwshCall, 'buildLoginShellExecArgs pwsh fake-gh preflight');
    if (pwshCall.stdout.trim() !== `GHM_FAKE_GH:${nonce}`) {
      fail('agent pwsh route did not return the fake-gh nonce');
    }
  } else {
    const shellArgs = buildLoginShellExecArgs(['gh', '__ghm-preflight', nonce], process.platform);
    const shellCall = runCommand(shellArgs[0], shellArgs.slice(1), { env, cwd: REPO_ROOT });
    assertStatus(shellCall, 'buildLoginShellExecArgs fake-gh preflight');
    if (shellCall.stdout.trim() !== `GHM_FAKE_GH:${nonce}`) fail('login shell route did not return the fake-gh nonce');
  }

  const calls = fakeGh.readCalls();
  const matching = calls.filter(call => call.args[0] === '__ghm-preflight' && call.args[1] === nonce);
  if (matching.length !== 2
      || matching.some(call => !samePath(call.executable, fakeGh.executablePath))) {
    fail('fake-gh log に Node とログインシェルの両 preflight が記録されていません');
  }
  return {
    node: { exitCode: nodeCall.exitCode, response: nodeCall.stdout.trim() },
    loginShell: { exitCode: process.platform === 'win32' ? 0 : 0, response: `GHM_FAKE_GH:${nonce}` },
    fakeExecutable: fakeGh.executablePath,
    bootstrap: fakeGh.bootstrapPath,
    callCount: matching.length,
  };
}

function verifyAgentCommandResolution(agentCommand, env) {
  if (process.platform !== 'win32') return { command: agentCommand, checked: false };
  const quoted = agentCommand.replace(/'/g, "''");
  const result = runCommand('pwsh', [
    '-NoLogo', '-Command',
    `$ErrorActionPreference = 'Stop'; $cmd = Get-Command '${quoted}' -ErrorAction Stop; Write-Output "GHM_AGENT_COMMAND:$($cmd.CommandType):$($cmd.Name)"`,
  ], { env, cwd: REPO_ROOT });
  assertStatus(result, `profile-loaded pwsh Get-Command ${agentCommand} preflight`);
  if (!result.stdout.includes(`GHM_AGENT_COMMAND:`)) fail(`pwsh could not resolve agent command ${agentCommand}`);
  return { command: agentCommand, checked: true, resolution: result.stdout.trim().split(/\r?\n/).at(-1) };
}

function createFakeGhForRun(runDir, workerName) {
  const commentsPath = path.join(runDir, 'fixtures', 'comments.json');
  fs.mkdirSync(path.dirname(commentsPath), { recursive: true });
  fs.writeFileSync(commentsPath, '[]', 'utf8');
  const future = '2999-01-01T00:00:00Z';
  return createFakeGh({
    binDir: path.join(runDir, 'fake-bin'),
    logPath: path.join(runDir, 'fake-gh-calls.jsonl'),
    fixtures: [
      {
        match: { prefix: ['api', '--method', 'GET', 'repos/test/maestro/issues/725/comments'] },
        action: 'read-json-pages', stateFile: commentsPath,
      },
      { match: { prefix: ['repo', 'view'] }, stdout: 'test/maestro\n' },
      {
        match: { prefix: ['pr', 'list', '--repo', 'test/maestro', '--head', workerName, '--state', 'all'] },
        stdout: '[]',
      },
      {
        match: { prefix: ['pr', 'list', '--repo', 'test/maestro', '--head', workerName, '--state', 'open'] },
        stdout: JSON.stringify([{
          number: 98765,
          createdAt: future,
          url: 'https://example.invalid/test/maestro/pull/98765',
          state: 'OPEN',
          headRefName: workerName,
          baseRefName: 'e2e-base',
        }]),
      },
      {
        match: { prefix: ['issue', 'comment', '725', '--body-file', '-'] },
        action: 'append-body-file', stateFile: commentsPath,
        fields: {
          id: 9001,
          created_at: future,
          user: { login: 'fake-worker' },
          html_url: 'https://example.invalid/test/maestro/issues/725#issuecomment-9001',
        },
        stdout: 'https://example.invalid/test/maestro/issues/725#issuecomment-9001\n',
      },
    ],
  });
}

function initializeFixtureWorkspace(workspace, sessionId) {
  fs.mkdirSync(workspace, { recursive: true });
  const commands = [
    ['init', '-q'],
    ['config', 'user.email', 'ghm725-e2e@example.invalid'],
    ['config', 'user.name', 'GH-Maestro E2E'],
  ];
  for (const args of commands) {
    const result = runCommand('git', args, { cwd: workspace, timeout: 30000 });
    assertStatus(result, `temporary fixture git ${args[0]}`);
  }
  fs.writeFileSync(path.join(workspace, 'README.md'), '# GH-Maestro model phase CLI fixture\n', 'utf8');
  for (const args of [['add', 'README.md'], ['commit', '-m', 'temporary E2E fixture']]) {
    const result = runCommand('git', args, { cwd: workspace, timeout: 30000 });
    assertStatus(result, `temporary fixture git ${args[0]}`);
  }
  const readState = require('../../scripts/shared/read-state');
  readState.initializeState(workspace, 'orchestrator', { sessionId });
  return workspace;
}

function launchCapturePath(runDir) {
  return path.join(runDir, 'launches.jsonl');
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function findWorkerEntry(workspace, workerName) {
  const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
  const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
  const entry = workers[workerName];
  if (!entry) fail(`workers.json に worker ${workerName} がありません`);
  return entry;
}

async function waitForStoppedEvent(workspace, workerName, priorEvents, phase) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const events = readCycleEvents(workspace, 725);
    const stopped = events.find(event => event.event === 'worker-stopped'
      && event.workerName === workerName
      && !priorEvents.has(`${event.at}:${event.pid || ''}:${event.exitCode ?? ''}`));
    if (stopped) {
      const key = `${stopped.at}:${stopped.pid || ''}:${stopped.exitCode ?? ''}`;
      priorEvents.add(key);
      return stopped;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  fail(`${phase} CLI の終了イベントを10分以内に確認できませんでした。再実行はしません`);
}

function stoppedEventKeys(workspace, workerName) {
  return new Set(readCycleEvents(workspace, 725)
    .filter(event => event.event === 'worker-stopped' && event.workerName === workerName)
    .map(event => `${event.at}:${event.pid || ''}:${event.exitCode ?? ''}`));
}

function assertSuccessfulStoppedEvent(event, phase) {
  if (event.abnormal || (event.exitCode !== undefined && event.exitCode !== 0)) {
    fail(`${phase} CLI の終了コードが非ゼロです (exitCode=${event.exitCode ?? 'unknown'})。再実行はしません`);
  }
}

function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch (error) {
    fail(`GH-Maestro のワーカーログを読めません: ${error.message}`);
  }
}

function parseJsonLines(text) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(start));
      if (parsed && typeof parsed === 'object') result.push(parsed);
    } catch { /* non-JSON CLI progress lines are not model evidence */ }
  }
  return result;
}

function collectClaudeModelUsage(text) {
  const found = [];
  for (const item of parseJsonLines(text)) {
    const usage = item.modelUsage || item.model_usage;
    if (!usage || typeof usage !== 'object') continue;
    for (const [model, tokens] of Object.entries(usage)) {
      const outputTokens = tokens && (tokens.outputTokens ?? tokens.output_tokens);
      if (Number(outputTokens) > 0) found.push({ model, outputTokens: Number(outputTokens) });
    }
  }
  return found;
}

function findJsonlFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(candidate);
    }
  };
  visit(root);
  return found;
}

function modelEvidenceForClaude({ home, cwd, log, expectedHint, afterOffset = 0 }) {
  const configRoot = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const projectName = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projectDir = path.join(configRoot, 'projects', projectName);
  const transcripts = findJsonlFiles(projectDir).sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (transcripts.length === 0) fail('Claude Code の session transcript を確認できません');
  const transcript = transcripts[0];
  const sessionId = path.basename(transcript, '.jsonl');
  const content = fs.readFileSync(transcript, 'utf8');
  const usage = collectClaudeModelUsage(log.slice(afterOffset));
  const match = usage.find(item => item.model.toLowerCase().includes(expectedHint.toLowerCase()));
  if (!match) fail(`Claude Code の modelUsage に ${expectedHint} と nonzero output token がありません`);
  return {
    sessionId,
    transcript,
    transcriptSize: Buffer.byteLength(content),
    model: match.model,
    outputTokens: match.outputTokens,
  };
}

function parseCodexTranscript(filePath, fromByte = 0) {
  const buffer = fs.readFileSync(filePath);
  const text = buffer.subarray(fromByte).toString('utf8');
  const objects = parseJsonLines(text);
  const modelAndEffort = [];
  let threadId = null;
  const walk = (value, recordType = '') => {
    if (!value || typeof value !== 'object') return;
    if (recordType === 'session_meta') {
      threadId = threadId || value.id || value.thread_id || value.threadId || null;
    }
    const model = value.model;
    const effort = value.effort ?? value.model_reasoning_effort ?? value.reasoning_effort;
    if (typeof model === 'string') modelAndEffort.push({ model, effort: typeof effort === 'string' ? effort : null });
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') walk(child, key === 'type' ? child : recordType);
    }
  };
  for (const item of objects) {
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'session_meta') {
      const payload = item.payload && typeof item.payload === 'object' ? item.payload : item;
      threadId = threadId || payload.id || payload.thread_id || payload.threadId || null;
    }
    walk(item, type);
  }
  return { threadId, modelAndEffort, size: buffer.length };
}

function getCodexSessionsRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

function findNewCodexTranscript(root, priorFiles) {
  const files = findJsonlFiles(root).filter(file => !priorFiles.has(path.resolve(file)));
  if (files.length === 0) fail('Codex の新しい session transcript が見つかりません');
  files.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return files[0];
}

function codexModelEvidence(filePath, fromByte, expectedEffort, knownThreadId = null) {
  const parsed = parseCodexTranscript(filePath, fromByte);
  const exactModel = parsed.modelAndEffort.find(item => item.model === 'gpt-6-luna');
  if (!exactModel || !parsed.modelAndEffort.some(item => item.model === 'gpt-6-luna' && item.effort === expectedEffort)) {
    fail(`Codex transcript に gpt-6-luna / effort=${expectedEffort} の実行記録がありません`);
  }
  const threadId = parsed.threadId || knownThreadId;
  if (!threadId) fail('Codex transcript から同一 thread ID を取得できません');
  return { threadId, model: exactModel.model, effort: expectedEffort, size: parsed.size };
}

function agyConversationIds(text) {
  const ids = new Set();
  const patterns = [
    /conversation(?:_id|Id|\s+id)?\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})/gi,
    /conversation\s+([A-Za-z0-9_-]{8,})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) ids.add(match[1]);
  }
  return [...ids];
}

function verifyAgyModelLog(logPath, modelArg, label) {
  if (!logPath || !fs.existsSync(logPath)) fail(`Antigravity の一時 --log-file がありません: ${logPath || '(unset)'}`);
  const log = fs.readFileSync(logPath, 'utf8');
  if (!log.includes(modelArg)) fail(`Antigravity の一時 CLI log に実 model ID ${modelArg} がありません`);
  if (!log.toLowerCase().includes(label.toLowerCase())) fail(`Antigravity の一時 CLI log に ${label} model selection label がありません`);
  const ids = agyConversationIds(log);
  if (ids.length === 0) fail('Antigravity の一時 CLI log から conversation ID を取得できません');
  return { model: modelArg, label, conversationIds: ids, logPath };
}

function assertMarker(log, marker, phase) {
  if (!log.includes(marker)) fail(`${phase} の実際の応答に marker ${marker} がありません`);
}

function modelArg(agent) {
  const index = agent.extraArgs.findIndex((arg, i) => i > 0 && agent.extraArgs[i - 1] === '--model');
  if (index >= 0) return agent.extraArgs[index];
  return agent.extraArgs.find(arg => arg.startsWith('model=')) || null;
}

function modelEffort(agent) {
  const argument = agent.extraArgs.find(value => value.startsWith('model_reasoning_effort='));
  return argument ? argument.slice('model_reasoning_effort='.length) : null;
}

function modelHint(agent) {
  const arg = modelArg(agent) || '';
  return arg.toLowerCase().includes('haiku') ? 'haiku'
    : arg.toLowerCase().includes('sonnet') ? 'sonnet'
      : arg.toLowerCase().includes('argon') ? 'argon'
        : arg.toLowerCase().includes('flash') ? 'flash'
          : arg;
}

function assertBaseArguments(runtime, argv, phase) {
  const required = runtime === 'codex'
    ? ['exec', '--dangerously-bypass-approvals-and-sandbox']
    : runtime === 'claude'
      ? ['--dangerously-skip-permissions', '--print']
      : ['--dangerously-skip-permissions', '--print'];
  const missing = required.filter(arg => !argv.includes(arg));
  if (missing.length) fail(`${phase} argv から基底必須引数が欠落しています: ${missing.join(', ')}`);
}

function makeEnvironment(fakeGh, details, launchKind, runDir) {
  const env = {
    ...fakeGh.env,
    NODE_OPTIONS: `${fakeGh.env.NODE_OPTIONS} --require="${PRELOAD_PATH.replace(/\\/g, '/')}"`,
    GH_MAESTRO_RUNTIME_DIR: process.env.GH_MAESTRO_RUNTIME_DIR,
    GHM_MODEL_PHASE_E2E_SCRIPTS_ROOT: SCRIPTS_ROOT,
    GHM_MODEL_PHASE_E2E_CAPTURE: launchCapturePath(runDir),
    GHM_MODEL_PHASE_E2E_AGENT: details.regular.id,
    GHM_MODEL_PHASE_E2E_PLAN_AGENT: details.planning.id,
    GHM_MODEL_PHASE_E2E_LAUNCH_KIND: launchKind,
    GHM_MODEL_PHASE_E2E_AGY_LOG_DIR: path.join(runDir, 'agy-cli-logs'),
  };
  if (details.regular.runtime === 'agy') {
    const safeSkillPath = path.join(runDir, 'safe-e2e-skill.md');
    fs.writeFileSync(safeSkillPath,
      '# E2E only\nDo not use tools or access files. Reply exactly with the marker in the current prompt.\n', 'utf8');
    env.GHM_MODEL_PHASE_E2E_AGY_SKILL = safeSkillPath;
  }
  return env;
}

function addInboxMessage(commentsPath, workerName) {
  const marker = JSON.stringify({ v: 1, to: workerName, from: 'orchestrator' });
  fs.writeFileSync(commentsPath, JSON.stringify([{
    id: 725001,
    created_at: new Date().toISOString(),
    user: { login: 'orchestrator' },
    body: `<!-- gh-maestro ${marker} -->\n> Return exactly GHM725_MODEL_PHASE_RESUME_OK. Do not use tools or access files.`,
    html_url: 'https://example.invalid/test/maestro/issues/725#issuecomment-725001',
  }]), 'utf8');
}

function assertOnlyFakeGh(fakeGh) {
  const calls = fakeGh.readCalls();
  const nonFake = calls.filter(call => !samePath(call.executable, fakeGh.executablePath));
  if (nonFake.length) fail('fake-gh の呼出記録に不正な executable が含まれています');
  const rejected = calls.filter(call => call.fixtureMatched !== true || call.status !== 0);
  if (rejected.length) fail(`fake-gh が未登録または失敗した呼出を拒否しました (${rejected.length}件)`);
  return { count: calls.length, calls };
}

function preflight({ regular, planning }, runtimeDir, runDir) {
  const workerName = `issue-725-senior-coder-model-phase-${regular.runtime}`;
  const fakeGh = createFakeGhForRun(runDir, workerName);
  const nonce = `ghm725-${regular.runtime}-${Date.now()}`;
  const env = makeEnvironment(fakeGh, { regular, planning }, 'preflight', runDir);
  const gh = verifyFakeGhPreflight(fakeGh, env, nonce);
  const agent = verifyAgentCommandResolution(regular.command, env);
  return {
    report: {
      runtimeDir,
      fakeGh: gh,
      agent,
      fakeGhLog: fakeGh.logPath,
    },
    fakeGh,
  };
}

async function runCliCheck({ regular, planning, runtimeDir, runDir, preflightResult, fakeGh }) {
  const workerName = `issue-725-senior-coder-model-phase-${regular.runtime}`;
  const workspace = path.join(runDir, 'workspace');
  const sessionId = `ghm725-${regular.runtime}-${Date.now()}`;
  initializeFixtureWorkspace(workspace, sessionId);
  const capture = launchCapturePath(runDir);
  const codexSessionsRoot = regular.runtime === 'codex' ? getCodexSessionsRoot() : null;
  const codexSessionsBefore = codexSessionsRoot
    ? new Set(findJsonlFiles(codexSessionsRoot).map(file => path.resolve(file)))
    : null;
  const scripts = [
    ['start', path.join(SCRIPTS_ROOT, 'spawn-worker.js'), [
      '--skill', 'gh-maestro-senior-coder', '--issue', '725', '--description', `model-phase-${regular.runtime}`,
      '--repo', 'test/maestro', '--workspace', workspace, '--agent', regular.id,
      '--short-prompt', 'Return exactly GHM725_MODEL_PHASE_START_OK and do not use tools.', '--session-id', sessionId,
    ]],
  ];

  if (!preflightResult || !preflightResult.fakeGh) fail('preflight result がありません');
  const startEnv = makeEnvironment(fakeGh, { regular, planning }, 'start', runDir);
  const start = runCommand(process.execPath, [scripts[0][1], ...scripts[0][2]], { cwd: REPO_ROOT, env: startEnv, timeout: 180000 });
  if (start.exitCode !== 0) {
    fail(`spawn-worker 初回起動に失敗しました (exitCode=${start.exitCode}, signal=${start.signal || 'none'}). 再実行はしません`);
  }
  const entry = findWorkerEntry(workspace, workerName);
  if (entry.modelPhase !== 'planning') fail('spawn-worker が modelPhase: planning を記録していません');
  const startLaunches = readJsonLines(capture).filter(item => item.kind === 'start');
  if (startLaunches.length !== 1) fail(`初回 agent 起動記録が1件ではありません (${startLaunches.length})`);
  const startLaunch = startLaunches[0];
  assertBaseArguments(regular.runtime, startLaunch.argv, '初回');
  if (!startLaunch.argv.includes(modelArg(planning))) fail('初回 argv に計画モデルの設定値がありません');
  if (regular.runtime === 'codex' && modelEffort(planning)
      && !startLaunch.argv.includes(`model_reasoning_effort=${modelEffort(planning)}`)) {
    fail('初回 Codex argv に計画モデルの reasoning effort がありません');
  }
  const workerLogPath = entry.logPath;
  if (!workerLogPath) fail('workers.json に worker log path がありません');
  const startStopped = await waitForStoppedEvent(workspace, workerName, new Set(), '初回');
  assertSuccessfulStoppedEvent(startStopped, '初回');
  const startLog = readLog(workerLogPath);
  assertMarker(startLog, 'GHM725_MODEL_PHASE_START_OK', '初回');

  const modelByRuntime = {};
  let transcriptPath = null;
  let transcriptThread = null;
  let codexTranscriptSizeAfterStart = null;
  let claudeTranscriptPath = null;
  let claudeSessionId = null;
  if (regular.runtime === 'codex') {
    const transcript = findNewCodexTranscript(codexSessionsRoot, codexSessionsBefore);
    transcriptPath = transcript;
    const effort = modelEffort(planning);
    if (!effort) fail('Codex の計画 agent extraArgs に model_reasoning_effort がありません');
    const evidence = codexModelEvidence(transcript, 0, effort);
    modelByRuntime.start = evidence;
    transcriptThread = evidence.threadId;
    codexTranscriptSizeAfterStart = fs.statSync(transcriptPath).size;
  } else if (regular.runtime === 'claude') {
    const cwd = startLaunch.cwd;
    const projectRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'projects', path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'));
    const files = findJsonlFiles(projectRoot);
    if (files.length === 0) fail('Claude Code の初回 session transcript がありません');
    claudeTranscriptPath = files.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
    claudeSessionId = path.basename(claudeTranscriptPath, '.jsonl');
    const expected = modelHint(planning);
    modelByRuntime.start = modelEvidenceForClaude({ home: homedir(), cwd, log: startLog, expectedHint: expected });
  } else {
    modelByRuntime.start = verifyAgyModelLog(startLaunch.cliLogPath, modelArg(planning), 'argon');
  }

  const setApproval = runCommand(process.execPath, [
    path.join(SCRIPTS_ROOT, 'set-response-contract.js'), '--issue', '725',
    '--skill', 'gh-maestro-senior-coder', '--type', 'artifact-or-message', '--artifact', 'pr',
    '--workspace', workspace,
  ], { cwd: REPO_ROOT, env: makeEnvironment(fakeGh, { regular, planning }, 'approval', runDir), timeout: 60000 });
  if (setApproval.exitCode !== 0) fail(`set-response-contract.js が失敗しました (exitCode=${setApproval.exitCode})`);
  const approvalPath = implementationApprovalPath(workspace, workerName);
  if (!readImplementationApproval(workspace, workerName) || !fs.existsSync(approvalPath)) {
    fail('set-response-contract.js の永続承認記録がありません');
  }
  const commentsPath = path.join(runDir, 'fixtures', 'comments.json');
  addInboxMessage(commentsPath, workerName);

  const resumeEnv = makeEnvironment(fakeGh, { regular, planning }, 'resume', runDir);
  const supervisorScript = path.join(SCRIPTS_ROOT, 'worker-supervisor.js');
  const resume = runCommand(process.execPath, [supervisorScript, '--workspace', workspace, '--once'], {
    cwd: REPO_ROOT, env: resumeEnv, timeout: 180000,
  });
  if (resume.exitCode !== 0) fail(`worker-supervisor.js --once が失敗しました (exitCode=${resume.exitCode})`);
  if (!resume.stdout.includes(`DELIVERED:${workerName}:725001`)) {
    fail('worker-supervisor.js --once が合成 inbox message を配送しませんでした');
  }
  const launchesAfterResume = readJsonLines(capture);
  const resumeLaunches = launchesAfterResume.filter(item => item.kind === 'resume');
  if (resumeLaunches.length !== 1) fail(`再開 agent 起動記録が1件ではありません (${resumeLaunches.length})`);
  const resumeLaunch = resumeLaunches[0];
  assertBaseArguments(regular.runtime, resumeLaunch.argv, '再開');
  if (!samePath(startLaunch.cwd, resumeLaunch.cwd) || !samePath(startLaunch.logPath, resumeLaunch.logPath)) {
    fail('resume の cwd または worker log が初回と異なります');
  }

  const stopKeysBeforeResume = stoppedEventKeys(workspace, workerName);
  const resumeStopped = await waitForStoppedEvent(workspace, workerName, stopKeysBeforeResume, '再開');
  assertSuccessfulStoppedEvent(resumeStopped, '再開');
  const resumedLog = readLog(workerLogPath);
  const startMarkerOffset = resumedLog.indexOf('GHM725_MODEL_PHASE_START_OK');
  const resumeText = resumedLog.slice(Math.max(0, startMarkerOffset + 'GHM725_MODEL_PHASE_START_OK'.length));
  assertMarker(resumeText, 'GHM725_MODEL_PHASE_RESUME_OK', '再開');

  if (!readImplementationApproval(workspace, workerName)) {
    fail('worker-supervisor の contract cleanup 後に承認記録が残っていません');
  }
  if (fs.existsSync(contractPath(workspace, workerName))) {
    fail('worker-supervisor --once 後に response contract が残っています');
  }

  if (regular.runtime === 'codex') {
    if (!fs.existsSync(transcriptPath)) fail('Codex transcript が再開後にありません');
    const startSize = codexTranscriptSizeAfterStart;
    const evidence = codexModelEvidence(
      transcriptPath, startSize, modelEffort(regular), transcriptThread,
    );
    if (evidence.threadId !== transcriptThread) fail('Codex resume が同じ thread ID を継続しませんでした');
    modelByRuntime.resume = evidence;
    modelByRuntime.session = { file: transcriptPath, threadId: transcriptThread, size: startSize };
  } else if (regular.runtime === 'claude') {
    const resumedTranscriptFiles = findJsonlFiles(path.dirname(claudeTranscriptPath));
    const latestTranscript = resumedTranscriptFiles
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
    if (!latestTranscript || !samePath(latestTranscript, claudeTranscriptPath)) {
      fail('Claude Code resume が初回 transcript を継続しませんでした');
    }
    if (fs.statSync(claudeTranscriptPath).size <= modelByRuntime.start.transcriptSize) {
      fail('Claude Code resume で同じ transcript に新しい会話記録が追加されませんでした');
    }
    const currentId = path.basename(claudeTranscriptPath, '.jsonl');
    if (currentId !== claudeSessionId) fail('Claude Code session ID が変わりました');
    modelByRuntime.resume = modelEvidenceForClaude({
      home: homedir(), cwd: resumeLaunch.cwd, log: resumedLog,
      expectedHint: modelHint(regular),
      afterOffset: startLog.length,
    });
    modelByRuntime.session = { sessionId: claudeSessionId, transcript: claudeTranscriptPath };
  } else {
    modelByRuntime.resume = verifyAgyModelLog(resumeLaunch.cliLogPath, modelArg(regular), 'flash');
    const startIds = modelByRuntime.start.conversationIds;
    const resumeIds = modelByRuntime.resume.conversationIds;
    if (!startIds.some(id => resumeIds.includes(id))) fail('Antigravity resume が同じ conversation ID を記録しませんでした');
    modelByRuntime.session = { conversationId: startIds.find(id => resumeIds.includes(id)) };
  }

  const gh = assertOnlyFakeGh(fakeGh);
  const requiredResumeArgs = regular.runtime === 'codex' ? ['resume', '--last']
    : regular.runtime === 'claude' ? ['--continue'] : ['--continue'];
  if (!requiredResumeArgs.every(arg => resumeLaunch.argv.includes(arg))) {
    fail(`resume argv に CLI 固有の再開指定がありません: ${requiredResumeArgs.join(' ')}`);
  }
  if (!resumeLaunch.argv.includes(modelArg(regular))) fail('resume argv に通常モデルの設定値がありません');
  if (regular.runtime === 'codex' && modelEffort(regular)
      && !resumeLaunch.argv.includes(`model_reasoning_effort=${modelEffort(regular)}`)) {
    fail('resume Codex argv に通常モデルの reasoning effort がありません');
  }

  return {
    cli: regular.runtime,
    agent: regular.id,
    planAgent: planning.id,
    start: {
      command: [process.execPath, scripts[0][1], ...scripts[0][2]],
      exitCode: start.exitCode,
      agentExitCode: startStopped.exitCode ?? null,
      argv: startLaunch.argv,
      responseMarker: 'GHM725_MODEL_PHASE_START_OK',
      model: modelByRuntime.start,
    },
    approval: {
      command: [process.execPath, path.join(SCRIPTS_ROOT, 'set-response-contract.js'),
        '--issue', '725', '--skill', 'gh-maestro-senior-coder', '--type', 'artifact-or-message',
        '--artifact', 'pr', '--workspace', workspace],
      exitCode: setApproval.exitCode,
    },
    resume: {
      command: [process.execPath, supervisorScript, '--workspace', workspace, '--once'],
      exitCode: resume.exitCode,
      agentExitCode: resumeStopped.exitCode ?? null,
      argv: resumeLaunch.argv,
      responseMarker: 'GHM725_MODEL_PHASE_RESUME_OK',
      model: modelByRuntime.resume,
    },
    session: modelByRuntime.session,
    fakeGh: { executable: fakeGh.executablePath, log: fakeGh.logPath, calls: gh.count },
    workspace,
    runtimeDir,
    artifacts: runDir,
    preflight: preflightResult,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const runtimeDir = assertRuntimeDir();
  const { regular, planning } = resolvePair(args.agentId, args.planAgentId);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `ghm725-cli-${regular.runtime}-`));
  fs.mkdirSync(path.join(runDir, 'agy-cli-logs'), { recursive: true });
  const { report: preflightReport, fakeGh } = preflight({ regular, planning }, runtimeDir, runDir);
  if (args.preflightOnly) {
    process.stdout.write(`${JSON.stringify({ cli: regular.runtime, agent: regular.id, planAgent: planning.id, preflight: preflightReport, artifacts: runDir }, null, 2)}\n`);
    return 0;
  }
  const result = await runCliCheck({ regular, planning, runtimeDir, runDir, preflightResult: preflightReport, fakeGh });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`worker-model-phase-cli-e2e: ${error.message}\n`);
    process.exitCode = Number.isInteger(error.code) ? error.code : 1;
  });
}
