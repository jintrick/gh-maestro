#!/usr/bin/env node
// gh-maestro per-project setup script
// Validates prerequisites only. No state files are written.

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { resolve } = require('path');

const workspaceRoot = process.argv[2] ?? process.cwd();

function step(msg)  { console.log(`\x1b[36m[gh-maestro] ${msg}\x1b[0m`); }
function ok(msg)    { console.log(`  \x1b[32mv ${msg}\x1b[0m`); }
function fail(msg)  { console.error(`  \x1b[31mx ${msg}\x1b[0m`); process.exit(1); }

function run(cmd, args, { capture } = {}) {
  const r = spawnSync(cmd, args, { cwd: workspaceRoot, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.status !== 0) return null;
  return capture ? r.stdout.trim() : true;
}

// ─── Prerequisites ────────────────────────────────────────────────────────────

step('Checking prerequisites...');

if (!process.env.WEZTERM_PANE) {
  fail('WEZTERM_PANE が設定されていません。WezTerm のペイン内で /gh-maestro を呼び出してください。');
}
ok(`Orchestrator pane-id: ${process.env.WEZTERM_PANE}`);

if (!run('wezterm', ['--version'], { capture: true })) {
  fail('wezterm CLI not found in PATH.');
}
ok('wezterm CLI found');

if (!existsSync(resolve(workspaceRoot, '.git'))) {
  fail(`Not a git repository: ${workspaceRoot}`);
}

const remoteUrl = run('git', ['config', '--get', 'remote.origin.url'], { capture: true });
if (!remoteUrl) fail("No remote 'origin' found. Configure git remote first.");
const match = remoteUrl.match(/github\.com[:/](.+?\/.+?)(\.git)?$/);
if (!match) fail(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);
ok(`Repository: ${match[1]}`);

if (!run('gh', ['auth', 'status'], { capture: true })) {
  fail("gh CLI not authenticated. Run 'gh auth login' first.");
}
ok('gh CLI authenticated');

const devBranch = run('git', ['branch', '--list', 'dev'], { capture: true });
if (!devBranch) {
  step("Creating 'dev' branch from main...");
  if (!run('git', ['checkout', '-b', 'dev', 'main'])) fail("Failed to create 'dev' branch.");
  run('git', ['push', '-u', 'origin', 'dev']);
}
ok("Branch 'dev' exists");

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log('\ngh-maestro ready.\n');
