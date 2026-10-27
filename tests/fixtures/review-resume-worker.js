'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const promptArg = process.argv.find(arg => /^Read .+ and execute it\.$/.test(arg));
if (!promptArg) throw new Error('missing prompt');
const prompt = fs.readFileSync(promptArg.slice(5, -16), 'utf8');
const fixture = process.env.REVIEW_RESUME_FIXTURE;
const events = path.join(fixture, 'events.jsonl');
function event(value) { fs.appendFileSync(events, JSON.stringify(value) + '\n'); }
if (prompt.includes('レビューの計画（フェーズ1）')) {
  event({ kind: 'phase1' });
  const destination = prompt.match(/実行manifestを (.+?) に書き出すこと/)[1];
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const plan = JSON.parse(fs.readFileSync(path.join(fixture, 'plan.json'), 'utf8'));
  plan.headRefOid = head;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(plan));
} else if (prompt.includes('レビュー結果の統合（フェーズ2）')) {
  event({ kind: 'phase2' });
  const results = prompt.match(/^RESULTS=(.+)$/m)[1];
  fs.copyFileSync(results, path.join(fixture, 'observed-results.json'));
  const workspace = prompt.match(/^WORKSPACE=(.+)$/m)[1];
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
