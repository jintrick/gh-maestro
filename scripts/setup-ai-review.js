#!/usr/bin/env node

const { spawnSync } = require('child_process');
const { readFileSync, existsSync, readdirSync } = require('fs');
const { resolve, basename } = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT      = resolve(__dirname, '..');
const WORKFLOWS = resolve(ROOT, 'workflows');
const SHARED    = resolve(ROOT, '.github', 'workflows', 'shared');
const BRANCHES  = ['main', 'dev'];

// Set by main(); referenced by API functions (only called when require.main === module)
let repo;

// ── Logging ────────────────────────────────────────────────────────────────
const log = {
  step: msg => console.log(`\x1b[36m[setup-ai-review] ${msg}\x1b[0m`),
  ok:   msg => console.log(`  \x1b[32mv ${msg}\x1b[0m`),
  skip: msg => console.log(`  \x1b[90m- ${msg}\x1b[0m`),
  warn: msg => console.log(`  \x1b[33m! ${msg}\x1b[0m`),
  fail: msg => { console.error(`  \x1b[31mx ${msg}\x1b[0m`); process.exit(1); },
};

// ── GitHub API ─────────────────────────────────────────────────────────────
function ghApi(path, method, body) {
  const args = ['api', path, '--method', method];
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
  if (body != null) { opts.input = JSON.stringify(body); args.push('--input', '-'); }
  const r = spawnSync('gh', args, opts);
  let data = null;
  try { data = JSON.parse(r.stdout); } catch {}
  return { ok: r.status === 0, data };
}

// ── File operations ────────────────────────────────────────────────────────
// Returns 'deployed' | 'skipped' | 'failed'
function deployFile(branch, destPath, content, commitMsg) {
  const normalized = content.replace(/\r\n/g, '\n');
  const body = { message: commitMsg, content: Buffer.from(normalized).toString('base64'), branch };

  const existing = ghApi(`repos/${repo}/contents/${destPath}?ref=${branch}`, 'GET');
  if (existing.ok && existing.data?.sha) {
    const remote = Buffer.from(existing.data.content.replace(/\n/g, ''), 'base64')
      .toString('utf8').replace(/\r\n/g, '\n');
    if (remote === normalized) return 'skipped';
    body.sha = existing.data.sha;
  }

  return ghApi(`repos/${repo}/contents/${destPath}`, 'PUT', body).ok ? 'deployed' : 'failed';
}

function deleteFile(branch, destPath, sha) {
  return ghApi(`repos/${repo}/contents/${destPath}`, 'DELETE', {
    message: `ci: remove stale ${basename(destPath)}`, sha, branch,
  }).ok;
}

function listRemoteWorkflowFiles(branch) {
  const r = ghApi(`repos/${repo}/contents/.github/workflows?ref=${branch}`, 'GET');
  return (r.ok && Array.isArray(r.data)) ? r.data : [];
}

// ── Manifest ───────────────────────────────────────────────────────────────
// Defines every file to deploy as { src: local path, dest: remote path }.
// The review CI is a single self-triggering workflow (reviewer.lock.yml, on: pull_request).
// It runtime-imports reviewer.md and shared/reviewer-output-policy.md at CI runtime,
// so those source files must be deployed alongside the compiled lock.
function buildManifest() {
  const entries = [];
  const add = (src, dest) => entries.push({ src, dest });

  readdirSync(WORKFLOWS)
    .filter(f => f.endsWith('.lock.yml'))
    .forEach(f => add(resolve(WORKFLOWS, f), `.github/workflows/${f}`));

  readdirSync(WORKFLOWS)
    .filter(f => f.endsWith('.md') && f.startsWith('reviewer'))
    .forEach(f => add(resolve(WORKFLOWS, f), `.github/workflows/${f}`));

  if (existsSync(SHARED)) {
    readdirSync(SHARED)
      .forEach(f => add(resolve(SHARED, f), `.github/workflows/shared/${f}`));
  }

  return entries;
}

// ── Deployment ─────────────────────────────────────────────────────────────
function deployToBranch(branch, manifest) {
  if (!ghApi(`repos/${repo}/git/ref/heads/${branch}`, 'GET').ok) {
    log.skip(`Branch '${branch}' not found — skipping`);
    return false;
  }

  log.step(`Deploying to ${repo}@${branch}...`);

  for (const { src, dest } of manifest) {
    const label = dest.replace('.github/workflows/', '');
    const r = deployFile(branch, dest, readFileSync(src, 'utf8'), `ci: update ${label}`);
    if      (r === 'failed') log.warn(`Failed to deploy ${label}`);
    else if (r === 'skipped') log.skip(`${label} unchanged`);
    else                      log.ok(`${label} deployed`);
  }

  pruneStaleFiles(branch, manifest);
  return true;
}

// Files this tool manages in the target's .github/workflows/. Anything matching
// but not in the current manifest is a leftover from a previous layout (e.g. the
// old 3-reviewer split or the ai-review.yml caller) and gets removed.
const MANAGED_PATTERN = /^(reviewer|ai-review)/;

function pruneStaleFiles(branch, manifest) {
  const managed = new Set(
    manifest.map(e => basename(e.dest)).filter(n => MANAGED_PATTERN.test(n))
  );
  for (const file of listRemoteWorkflowFiles(branch)) {
    if (!MANAGED_PATTERN.test(file.name) || managed.has(file.name)) continue;
    log.step(`Removing stale ${file.name}...`);
    deleteFile(branch, `.github/workflows/${file.name}`, file.sha)
      ? log.ok(`Removed ${file.name}`)
      : log.warn(`Failed to remove ${file.name}`);
  }
}

// ── Post-setup ─────────────────────────────────────────────────────────────
function enablePrApproval() {
  log.step('Enabling GitHub Actions PR approval permission...');
  const current = ghApi(`repos/${repo}/actions/permissions/workflow`, 'GET');
  const r = ghApi(`repos/${repo}/actions/permissions/workflow`, 'PUT', {
    default_workflow_permissions: current.data?.default_workflow_permissions ?? 'read',
    can_approve_pull_request_reviews: true,
  });
  r.ok
    ? log.ok('GitHub Actions can now approve pull requests')
    : log.warn('Failed to enable PR approval — set manually: Settings → Actions → General');
}

function checkSecret() {
  log.step('Checking DEEPSEEK_API_KEY secret...');
  const r = spawnSync('gh', ['secret', 'list', '--repo', repo], { encoding: 'utf8', stdio: 'pipe' });
  r.status === 0 && r.stdout.includes('DEEPSEEK_API_KEY')
    ? log.ok('DEEPSEEK_API_KEY already set')
    : log.warn(`DEEPSEEK_API_KEY not set — run: gh secret set DEEPSEEK_API_KEY --repo ${repo}`);
}

// ── Exports (for testing) ──────────────────────────────────────────────────
module.exports = { buildManifest, WORKFLOWS, SHARED };

// ── Main ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  repo = process.argv[2];
  if (!repo || !repo.includes('/')) {
    console.error('Usage: setup-ai-review.js <owner/repo>');
    process.exit(1);
  }

  const manifest = buildManifest();
  if (!manifest.some(e => e.dest.endsWith('.lock.yml'))) {
    log.fail(`No .lock.yml found in ${WORKFLOWS} — run 'gh aw compile -d workflows' first`);
  }

  const anyDeployed = BRANCHES.map(b => deployToBranch(b, manifest)).some(Boolean);
  if (!anyDeployed) log.fail(`Failed to deploy to any branch of ${repo}`);

  enablePrApproval();
  checkSecret();

  console.log(`\nAI Code Review CI is ready on ${repo}\n`);
}
