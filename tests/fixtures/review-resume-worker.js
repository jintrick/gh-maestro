'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const promptReference = process.argv.at(-1);
const promptFileMatch = typeof promptReference === 'string'
  ? /^Read (.+) and execute it\.$/.exec(promptReference)
  : null;
if (!promptFileMatch) throw new Error('missing prompt file reference');
const prompt = fs.readFileSync(promptFileMatch[1], 'utf8');
const fixture = process.env.REVIEW_RESUME_FIXTURE;
const events = path.join(fixture, 'events.jsonl');
function event(value) { fs.appendFileSync(events, JSON.stringify(value) + '\n'); }
function value(name) {
  const match = new RegExp(`^${name}=([^\\r\\n]+)$`, 'm').exec(prompt);
  if (!match) throw new Error(`missing ${name} input`);
  return match[1];
}
const manifestFile = /^MANIFEST=([^\r\n]+)$/m.exec(prompt)?.[1];
const resultsFile = /^RESULTS=([^\r\n]+)$/m.exec(prompt)?.[1];
const jobResult = /`([^`]*review-job-([^/\\]+?)-review-[^`]+)`/.exec(prompt);
if (manifestFile) {
  event({ kind: 'phase1' });
  const workspace = value('WORKSPACE');
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  if (headResult.status !== 0) throw new Error(`could not read review worktree HEAD: ${headResult.stderr}`);
  const head = headResult.stdout.trim();
  const plan = JSON.parse(fs.readFileSync(path.join(fixture, 'plan.json'), 'utf8'));
  plan.headRefOid = head;
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(plan));
} else if (resultsFile) {
  event({ kind: 'phase2' });
  fs.copyFileSync(resultsFile, path.join(fixture, 'observed-results.json'));
  const workspace = value('WORKSPACE');
  const sentinel = path.join(workspace, '.gh-maestro', 'records', 'pr', '11', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, JSON.stringify({ reason: 'incomplete-review' }));
} else if (jobResult) {
  const [, resultPath, jobId] = jobResult;
  event({ kind: 'job', id: jobId });
  fs.writeFileSync(resultPath, '[]');
} else {
  throw new Error('missing structured review input');
}
setTimeout(() => process.exit(0), 700);
