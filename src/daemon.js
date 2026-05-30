'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const POLL_INTERVAL_MS = 30_000;
const WORKERS_PATH = path.join(__dirname, '..', 'workers.json');
const PID_FILE = path.join(__dirname, '..', '.daemon.pid');

let activeChild = null;

function loadWorkers() {
  return JSON.parse(fs.readFileSync(WORKERS_PATH, 'utf8'));
}

function gh(args) {
  return JSON.parse(execSync(`gh ${args}`, { encoding: 'utf8' }));
}

function ghSilent(args) {
  execSync(`gh ${args}`, { stdio: 'pipe' });
}

function addLabel(number, label) {
  ghSilent(`issue edit ${number} --add-label "${label}"`);
}

function removeLabel(number, label) {
  ghSilent(`issue edit ${number} --remove-label "${label}"`);
}

function poll() {
  if (activeChild) return;

  const workers = loadWorkers();
  const triggerLabels = Object.keys(workers);

  let issues;
  try {
    issues = gh('issue list --state open --json number,labels --limit 100');
  } catch (err) {
    console.error('[daemon] gh issue list failed:', err.message);
    return;
  }

  for (const issue of issues) {
    const labels = issue.labels.map(l => l.name);

    if (labels.includes('in-progress')) continue;

    const trigger = triggerLabels.find(l => labels.includes(l));
    if (!trigger) continue;

    const command = workers[trigger];
    console.log(`[daemon] #${issue.number}: ${trigger} → ${command}`);

    try {
      addLabel(issue.number, 'in-progress');
    } catch (err) {
      console.error(`[daemon] Failed to add in-progress to #${issue.number}:`, err.message);
      continue;
    }

    const [cmd, ...args] = command.split(' ');
    activeChild = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, GH_ISSUE: String(issue.number) },
    });

    activeChild.on('exit', (code, signal) => {
      console.log(`[daemon] #${issue.number}: exit code=${code} signal=${signal}`);
      activeChild = null;

      try {
        removeLabel(issue.number, 'in-progress');
      } catch (err) {
        console.error(`[daemon] Failed to remove in-progress from #${issue.number}:`, err.message);
      }

      if (code !== 0 && signal !== 'SIGTERM') {
        try {
          addLabel(issue.number, 'human-escalation');
          console.log(`[daemon] #${issue.number}: escalated to human`);
        } catch (err) {
          console.error(`[daemon] Failed to add human-escalation to #${issue.number}:`, err.message);
        }
      }

      setImmediate(poll);
    });

    break; // one agent at a time globally
  }
}

// PM2 custom message (Windows)
process.on('message', (packet) => {
  if (packet === 'poll' || packet?.topic === 'poll') {
    console.log('[daemon] Immediate poll via PM2 message');
    poll();
  }
});

// SIGUSR1 (Linux)
if (process.platform !== 'win32') {
  process.on('SIGUSR1', () => {
    console.log('[daemon] Immediate poll via SIGUSR1');
    poll();
  });
}

// PID file for Linux signal-daemon
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
});

// Auth check on startup
try {
  execSync('gh auth status', { stdio: 'pipe' });
} catch {
  console.error('[daemon] gh auth check failed. Run: gh auth login');
  process.exit(1);
}

console.log(`[daemon] Started (PID ${process.pid}). Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
poll();
setInterval(poll, POLL_INTERVAL_MS);
