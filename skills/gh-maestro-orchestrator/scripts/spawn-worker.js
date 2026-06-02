#!/usr/bin/env node
// spawn-worker.js
// ワーカーペインを作成し、worktreeを準備してagyを起動する
//
// Usage:
//   node spawn-worker.js \
//     --skill <skill-name> \
//     [--prompt "<role-prompt>"]  # gh-maestro-base 使用時は必須
//     --issue <N> \
//     --description <desc> \
//     --repo <owner/repo> \
//     --workspace <path> \
//     [--base-branch <branch>]
//
// 標準出力: ワーカー名（例: issue-5-implement）

const { execSync, spawnSync } = require('child_process');
const { existsSync, mkdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

// --- 引数パース ---
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const skill       = get('--skill');
const prompt      = get('--prompt');
const issue       = get('--issue');
const description = get('--description');
const repo        = get('--repo');
const workspace   = get('--workspace') ?? process.cwd();
const baseBranch  = get('--base-branch');

// --- バリデーション ---
const fail = (msg) => { console.error(`spawn-worker: ${msg}`); process.exit(1); };
if (!skill)       fail('--skill が必要です');
if (!issue)       fail('--issue が必要です');
if (!description) fail('--description が必要です');
if (!repo)        fail('--repo が必要です');
if (skill === 'gh-maestro-base' && !prompt) fail('gh-maestro-base を使う場合は --prompt が必要です');

const orchPaneId = process.env.WEZTERM_PANE;
if (!orchPaneId)  fail('WEZTERM_PANE が設定されていません');

// --- パス定義 ---
const workerName   = `issue-${issue}-${description}`;
const worktreeDir  = resolve(workspace, '.gh-maestro', 'worktrees', workerName);
const scriptsDir   = resolve(workspace, '.gh-maestro', 'scripts');
const sendPaneDst  = resolve(scriptsDir, 'send-pane.js');
const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
const gitignore    = resolve(workspace, '.gitignore');

// --- .gitignore に .gh-maestro/ を追記（初回のみ） ---
const entry = '.gh-maestro/';
const alreadyIgnored = existsSync(gitignore) &&
  readFileSync(gitignore, 'utf8').split('\n').some(l => l.trim() === entry);
if (!alreadyIgnored) appendFileSync(gitignore, `\n${entry}\n`, 'utf8');

// --- .gh-maestro/scripts/ を作成して send-pane.js をコピー ---
mkdirSync(scriptsDir, { recursive: true });
copyFileSync(resolve(__dirname, 'send-pane.js'), sendPaneDst);

// --- workers.json を読み込み（なければ初期化） ---
let workers = {};
if (existsSync(workersJson)) {
  workers = JSON.parse(readFileSync(workersJson, 'utf8'));
}
if (!workers.orchestrator) {
  workers.orchestrator = orchPaneId;
}

// --- レイアウト決定（WezTermの詳細はここに閉じ込める） ---
const existingWorkers = Object.keys(workers).filter(k => k !== 'orchestrator');
let direction, splitFromPaneId;
if (existingWorkers.length === 0) {
  direction = 'right';
  splitFromPaneId = orchPaneId;
} else {
  direction = 'bottom';
  splitFromPaneId = workers[existingWorkers[existingWorkers.length - 1]];
}

// --- worktree を作成 ---
mkdirSync(resolve(workspace, '.gh-maestro', 'worktrees'), { recursive: true });
execSync(`git worktree add "${worktreeDir}" -b "${workerName}"`, {
  cwd: workspace,
  stdio: 'inherit',
});

// --- WezTerm ペイン分割 ---
const splitArgs = ['cli', 'split-pane', `--${direction}`, '--cwd', worktreeDir, '--pane-id', splitFromPaneId];
const split = spawnSync('wezterm', splitArgs, { encoding: 'utf8' });
if (split.status !== 0) fail(`wezterm split-pane 失敗\n${split.stderr}`);
const newPaneId = split.stdout.trim();

// --- workers.json にワーカーを登録 ---
workers[workerName] = newPaneId;
writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');

// --- 初期プロンプトを組み立てる ---
const contextLines = [
  `WORKER_NAME=${workerName}`,
  `REPO=${repo}`,
  `WORKSPACE=${workspace}`,
  `WORKTREE=${worktreeDir}`,
  `ISSUE=${issue}`,
];
if (baseBranch) contextLines.push(`BASE_BRANCH=${baseBranch}`);
const extra = prompt ? `\n${prompt}` : '';
const initialPrompt = `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。${extra}\n\n以下の変数が与えられています：\n${contextLines.join('\n')}`;

// --- agy を起動 ---
const send = (text) => {
  spawnSync('wezterm', ['cli', 'send-text', '--pane-id', newPaneId, text], { encoding: 'utf8' });
  spawnSync('wezterm', ['cli', 'send-text', '--pane-id', newPaneId, '--no-paste', '\r'], { encoding: 'utf8' });
};

const escaped = initialPrompt.replace(/'/g, "'\\''");
send(`agy --dangerously-skip-permissions -i '${escaped}'`);

// --- ワーカー名を出力（orchestratorが受け取る） ---
console.log(workerName);
