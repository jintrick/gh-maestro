#!/usr/bin/env node
// Deploys ai-review.yml and reviewer-*.lock.yml to a target repository (main + dev branches via GitHub API)

const { spawnSync } = require('child_process');
const { readFileSync, existsSync, readdirSync } = require('fs');
const { resolve } = require('path');

const repo = process.argv[2];
if (!repo || !repo.includes('/')) {
  console.error('Usage: setup-ai-review.js <owner/repo>');
  process.exit(1);
}

const workflowsDir = resolve(__dirname, '..', 'workflows');
const templatePath = resolve(workflowsDir, 'caller-template', 'ai-review.yml');

function step(msg) { console.log(`\x1b[36m[setup-ai-review] ${msg}\x1b[0m`); }
function ok(msg)   { console.log(`  \x1b[32mv ${msg}\x1b[0m`); }
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

function deployFile(repo, branch, targetPath, content, commitMsg) {
  const contentB64 = Buffer.from(content).toString('base64');
  const body = { message: commitMsg, content: contentB64, branch };
  const existing = ghApi(`repos/${repo}/contents/${targetPath}?ref=${branch}`, 'GET');
  if (existing.ok && existing.data && existing.data.sha) {
    body.sha = existing.data.sha;
  }
  const result = ghApi(`repos/${repo}/contents/${targetPath}`, 'PUT', body);
  return result.ok;
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

if (lockFiles.length === 0) {
  fail(`No .lock.yml files found in ${workflowsDir}`);
}

const callerContent = readFileSync(templatePath, 'utf8');
const branches = ['main', 'dev'];
let deployed = false;

for (const branch of branches) {
  const branchCheck = ghApi(`repos/${repo}/git/ref/heads/${branch}`, 'GET');
  if (!branchCheck.ok) {
    ok(`Branch '${branch}' not found — skipping`);
    continue;
  }

  step(`Deploying ai-review.yml to ${repo}@${branch}...`);
  const aiReviewOk = deployFile(repo, branch, '.github/workflows/ai-review.yml', callerContent, 'ci: add AI code review workflow');
  if (!aiReviewOk) {
    warn(`Failed to deploy ai-review.yml to branch '${branch}' — skipping branch`);
    continue;
  }
  ok(`ai-review.yml deployed to ${branch}`);

  for (const lf of lockFiles) {
    step(`Deploying ${lf.name} to ${repo}@${branch}...`);
    const lockContent = readFileSync(lf.path, 'utf8');
    const lockOk = deployFile(repo, branch, `.github/workflows/${lf.name}`, lockContent, `ci: add gh-aw lock file ${lf.name}`);
    if (!lockOk) {
      warn(`Failed to deploy ${lf.name} to branch '${branch}'`);
    } else {
      ok(`${lf.name} deployed to ${branch}`);
    }
  }

  for (const sf of sourceFiles) {
    step(`Deploying ${sf.name} to ${repo}@${branch}...`);
    const srcContent = readFileSync(sf.path, 'utf8');
    const srcOk = deployFile(repo, branch, `.github/workflows/${sf.name}`, srcContent, `ci: add gh-aw source file ${sf.name}`);
    if (!srcOk) {
      warn(`Failed to deploy ${sf.name} to branch '${branch}'`);
    } else {
      ok(`${sf.name} deployed to ${branch}`);
    }
  }

  deployed = true;
}

if (!deployed) {
  fail(`Failed to deploy to any branch of ${repo}`);
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
