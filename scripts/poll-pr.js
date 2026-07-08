#!/usr/bin/env node
// Usage: node poll-pr.js <ISSUE> [--workspace <path>] [--session-pid <pid>] [INTERVAL_SECONDS]
// Polls until a PR for the given issue is found, then launches the reviewer and prints:
//   PR_DETECTED:<number>
//   REVIEW_MANAGER_STARTED:<number> | REVIEW_MANAGER_ALREADY_RUNNING:<number>
'use strict';

const { spawnSync } = require('./child-process');
const { startReviewManager } = require('./start-review-manager');
const { resolveWorkspace } = require('./shared/workspace');
const {
  resolveSessionPid,
  createDeadManSwitch,
  registerProcess,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');

const USAGE = `poll-pr.js — Issue に対応する PR を検出し、検出時にレビュアーを起動する

Usage: node poll-pr.js <ISSUE> [--workspace <path>] [--session-pid <pid>] [INTERVAL_SECONDS]

Arguments:
  <ISSUE>             対象の Issue 番号（必須）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Options:
  --workspace <path>   ワークスペースパス（省略時は環境変数またはCWDから解決）
  --session-pid <pid>  監視対象のセッションPID（dead-man's switch用。省略時は自動検出）

Output (stdout):
  PR_DETECTED:<PR>                     PR を検出した
  REVIEW_MANAGER_STARTED:<PR>          Review Manager を起動した
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>  Review Manager は既に稼働中

PR が見つかるまでブロックし、見つけたら Review Manager(start-review-manager.js)を起動して終了する。
ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
消滅時はPID registryを解除して自動exitする。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

// 簡易フラグパース（poll-pr.js は単純な引数構造のため parseFlags を使わず直接パース）
const getFlag = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };
const workspaceArg = getFlag('--workspace');
const sessionPidArg = getFlag('--session-pid');

// フラグとその値を除去した位置引数
const flagSet = new Set(['--workspace', '--session-pid']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (flagSet.has(argv[i])) { i++; continue; }
  positional.push(argv[i]);
}

const [issue, intervalArg] = positional;
const interval = parseInt(intervalArg || '30') * 1000;

if (!issue) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(workspaceArg);
if (!workspace) {
  console.error('poll-pr: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  { encoding: 'utf8', cwd: workspace }).stdout.trim();

// ── ライフサイクル管理 ─────────────────────────────────────────────────

const sessionPid = resolveSessionPid(sessionPidArg);
const checkParent = createDeadManSwitch(sessionPid);

// PID registry に自己登録
registerProcess(workspace, { script: 'poll-pr.js' });

// cleanup: registry 解除 + exit
function cleanup() {
  lifecycleCleanup(workspace);
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

function findPR() {
  let r = spawnSync('gh', ['pr', 'list', '--repo', repo,
    '--search', `head:issue-${issue}`, '--state', 'open',
    '--json', 'number', '-q', '.[0].number'], { encoding: 'utf8' });
  const pr = r.stdout.trim();
  if (pr) return pr;

  r = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open',
    '--json', 'number,body', '-q',
    `.[] | select(.body | strings | contains("#${issue}")) | .number`],
    { encoding: 'utf8' });
  return r.stdout.trim().split('\n').find(s => s.trim()) || '';
}

(async () => {
  while (true) {
    // dead-man's switch: 親セッション生存確認
    if (!checkParent()) {
      console.error(`poll-pr: parent session (pid ${sessionPid}) is dead — exiting`);
      cleanup();
      return; // unreachable（cleanup が process.exit する）
    }

    const pr = findPR();
    if (pr) {
      // PR 検出のついでにReview Managerを起動するが、その起動結果も併せて報告する。
      // これにより orchestrator は「レビューが起動済みである」ことを把握できる。
      const reviewStatus = startReviewManager(pr, repo, workspace);
      process.stdout.write(`PR_DETECTED:${pr}\n`);
      process.stdout.write(`${reviewStatus}:${pr}\n`);
      cleanup();
      return; // unreachable
    }
    await new Promise(r => setTimeout(r, interval));
  }
})();
