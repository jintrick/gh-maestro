'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const promptInstruction = process.argv.find(arg => /^Read (.+) and execute it\.$/s.test(arg));
const promptFile = promptInstruction?.match(/^Read (.+) and execute it\.$/s)?.[1];
if (!promptFile) throw new Error('missing prompt file instruction');
const prompt = fs.readFileSync(promptFile, 'utf8');
const fixture = process.env.REVIEW_RESUME_FIXTURE;
const events = path.join(fixture, 'events.jsonl');
function event(value) { fs.appendFileSync(events, JSON.stringify(value) + '\n'); }
function value(name) {
  const match = new RegExp(`^${name}=(.+)$`, 'm').exec(prompt);
  if (!match) throw new Error(`missing ${name} input`);
  return match[1];
}
if (/^Review Manager フェーズ1\r?$/m.test(prompt)) {
  event({ kind: 'phase1' });
  const destination = value('MANIFEST');
  const workspace = value('WORKSPACE');
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  if (headResult.status !== 0) throw new Error(`could not read review worktree HEAD: ${headResult.stderr}`);
  const head = headResult.stdout.trim();
  const plan = JSON.parse(fs.readFileSync(path.join(fixture, 'plan.json'), 'utf8'));
  plan.headRefOid = head;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(plan));
} else if (/^Review Manager フェーズ2\r?$/m.test(prompt)) {
  event({ kind: 'phase2' });
  const results = value('RESULTS');
  fs.copyFileSync(results, path.join(fixture, 'observed-results.json'));
  const workspace = value('WORKSPACE');
  const sentinel = path.join(workspace, '.gh-maestro', 'records', 'pr', '11', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, JSON.stringify({ reason: 'incomplete-review' }));
} else {
  const target = prompt.match(/結果ファイル:\s*`([^`]+)`/);
  if (!target) throw new Error('missing job result path');
  const job = target[1].match(/review-job-([^/\\]+)-review-/);
  event({ kind: 'job', id: job ? job[1] : 'unknown' });
  fs.writeFileSync(target[1], '[]');
}
setTimeout(() => process.exit(0), 700);
