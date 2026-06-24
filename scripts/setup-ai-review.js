#!/usr/bin/env node
// Deploys ai-review.yml, reviewer-*.lock.yml, reviewer-*.md, and shared/ files to a target repository

const { spawnSync } = require('child_process');
const { readFileSync, existsSync, readdirSync } = require('fs');
const { resolve } = require('path');

const repo = process.argv[2];
if (!repo || !repo.includes('/')) {
  console.error('Usage: setup-ai-review.js <owner/repo>');
  process.exit(1);
}

const workflowsDir = resolve(__dirname, '..', 'workflows');
const sharedDir = resolve(__dirname, '..', '.github', 'workflows', 'shared');
const templatePath = resolve(workflowsDir, 'caller-template', 'ai-review.yml');

function step(msg) { console.log(`\x1b[36m[setup-ai-review] ${msg}\x1b[0m`); }
function ok(msg)   { console.log(`  \x1b[32mv ${msg}\x1b[0m`); }
function skip(msg) { console.log(`  \x1b[90m- ${msg}\x1b[0m`); }
function warn(msg) { console.log(`  \x1b[33m! ${msg}\x1b[0m`); }
function fail(msg) { console.error(`  \x1b[31mx ${msg}\x1b[0m`); process.exit(1); }

function ghApi(apiPath, method, body) {
  const args = ['api', apiPath, '--method', method];
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
  if (body !== null && body !== undefined) {
    opts.input = JSON.stringify(body);
    args.push('--input', '-');
  }
  const r = spawnSync('gh', args, opts);
  let data = null;
  try { data = JSON.parse(r.stdout); } catch {}
  return { ok: r.status === 0, data };
}

// Returns 'deployed' | 'skipped' | 'failed'
function deployFile(repo, branch, targetPath, content, commitMsg) {
  const normalized = content.replace(/\r\n/g, '\n');
  const contentB64 = Buffer.from(normalized).toString('base64');
  const body = { message: commitMsg, content: contentB64, branch };

  const existing = ghApi(`repos/${repo}/contents/${targetPath}?ref=${branch}`, 'GET');
  if (existing.ok && existing.data && existing.data.sha) {
    const existingNormalized = Buffer.from(
      existing.data.content.replace(/\n/g, ''), 'base64'
    ).toString('utf8').replace(/\r\n/g, '\n');
    if (existingNormalized === normalized) return 'skipped';
    body.sha = existing.data.sha;
  }

  const result = ghApi(`repos/${repo}/contents/${targetPath}`, 'PUT', body);
  return result.ok ? 'deployed' : 'failed';
}

function deleteFile(repo, branch, targetPath, sha, commitMsg) {
  const result = ghApi(`repos/${repo}/contents/${targetPath}`, 'DELETE', {
    message: commitMsg, sha, branch,
  });
  return result.ok;
}

function listWorkflowFiles(repo, branch) {
  const result = ghApi(`repos/${repo}/contents/.github/workflows?ref=${branch}`, 'GET');
  if (!result.ok || !Array.isArray(result.data)) return [];
  return result.data;
}

if (!existsSync(templatePath)) {
  fail(`Template not found: ${templatePath}`);
}

const lockFiles = readdirSync(workflowsDir)
  .filter(f => f.endsWith('.lock.yml'))
  .map(f => ({ name: f, path: resolve(workflowsDir, f) }));

const sourceFiles = readdirSync(workflowsDir)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ name: f, path: resolve(workflowsDir, f) }));

const sharedFiles = existsSync(sharedDir)
  ? readdirSync(sharedDir).map(f => ({ name: f, path: resolve(sharedDir, f) }))
  : [];

if (lockFiles.length === 0) {
  fail(`No .lock.yml files found in ${workflowsDir}`);
}

const callerContent = readFileSync(templatePath, 'utf8');
const branches = ['main', 'dev'];
let deployed = false;

const expectedNames = new Set([
  'ai-review.yml',
  ...lockFiles.map(f => f.name),
  ...sourceFiles.map(f => f.name),
]);

for (const branch of branches) {
  const branchCheck = ghApi(`repos/${repo}/git/ref/heads/${branch}`, 'GET');
  if (!branchCheck.ok) {
    skip(`Branch '${branch}' not found — skipping`);
    continue;
  }

  step(`Deploying to ${repo}@${branch}...`);

  const aiResult = deployFile(repo, branch, '.github/workflows/ai-review.yml', callerContent, 'ci: update AI code review workflow');
  if (aiResult === 'failed') { warn(`Failed to deploy ai-review.yml to '${branch}' — skipping branch`); continue; }
  aiResult === 'skipped' ? skip('ai-review.yml unchanged') : ok('ai-review.yml deployed');

  for (const lf of lockFiles) {
    const content = readFileSync(lf.path, 'utf8');
    const r = deployFile(repo, branch, `.github/workflows/${lf.name}`, content, `ci: update ${lf.name}`);
    if (r === 'failed') warn(`Failed to deploy ${lf.name}`);
    else if (r === 'skipped') skip(`${lf.name} unchanged`);
    else ok(`${lf.name} deployed`);
  }

  for (const sf of sourceFiles) {
    const content = readFileSync(sf.path, 'utf8');
    const r = deployFile(repo, branch, `.github/workflows/${sf.name}`, content, `ci: update ${sf.name}`);
    if (r === 'failed') warn(`Failed to deploy ${sf.name}`);
    else if (r === 'skipped') skip(`${sf.name} unchanged`);
    else ok(`${sf.name} deployed`);
  }

  for (const sf of sharedFiles) {
    const content = readFileSync(sf.path, 'utf8');
    const r = deployFile(repo, branch, `.github/workflows/shared/${sf.name}`, content, `ci: update shared/${sf.name}`);
    if (r === 'failed') warn(`Failed to deploy shared/${sf.name}`);
    else if (r === 'skipped') skip(`shared/${sf.name} unchanged`);
    else ok(`shared/${sf.name} deployed`);
  }

  // Remove stale reviewer-* files that no longer exist in workflows/
  const remoteFiles = listWorkflowFiles(repo, branch);
  for (const file of remoteFiles) {
    if (!/^reviewer-/.test(file.name)) continue;
    if (!expectedNames.has(file.name)) {
      step(`Removing stale ${file.name}...`);
      const deleted = deleteFile(repo, branch, `.github/workflows/${file.name}`, file.sha, `ci: remove stale workflow ${file.name}`);
      if (deleted) ok(`Removed stale ${file.name}`);
      else warn(`Failed to remove stale ${file.name}`);
    }
  }

  deployed = true;
}

if (!deployed) {
  fail(`Failed to deploy to any branch of ${repo}`);
}

step('Enabling GitHub Actions PR approval permission...');
const workflowPerms = ghApi(`repos/${repo}/actions/permissions/workflow`, 'GET');
const currentDefault = workflowPerms.data?.default_workflow_permissions || 'read';
const permResult = ghApi(`repos/${repo}/actions/permissions/workflow`, 'PUT', {
  default_workflow_permissions: currentDefault,
  can_approve_pull_request_reviews: true,
});
if (permResult.ok) {
  ok('GitHub Actions can now approve pull requests');
} else {
  warn('Failed to enable GitHub Actions PR approval — set it manually: repo Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"');
}

step('Checking DEEPSEEK_API_KEY secret...');
const secretsList = spawnSync('gh', ['secret', 'list', '--repo', repo], { encoding: 'utf8', stdio: 'pipe' });
if (secretsList.status === 0 && secretsList.stdout.includes('DEEPSEEK_API_KEY')) {
  ok('DEEPSEEK_API_KEY already set');
} else {
  warn(`DEEPSEEK_API_KEY is not set on ${repo}.`);
  warn(`Set it with: gh secret set DEEPSEEK_API_KEY --repo ${repo}`);
}

console.log(`\nAI Code Review CI is ready on ${repo}\n`);
