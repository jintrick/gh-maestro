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
//     --orchestrator-pane-id <id> \
//     --repo <owner/repo> \
//     --workspace <path> \
//     [--direction right|bottom|left|top] \
//     [--pane-id <split-from-pane-id>]
//
// 標準出力: 新しいペインのpane-id

const { execSync, spawnSync } = require('child_process');
const { existsSync, mkdirSync, copyFileSync, appendFileSync, readFileSync } = require('fs');
const { resolve } = require('path');

// --- 引数パース ---
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const skill       = get('--skill');
const prompt      = get('--prompt');
const issue       = get('--issue');
const description = get('--description');
const orchPaneId  = get('--orchestrator-pane-id');
const repo        = get('--repo');
const workspace   = get('--workspace') ?? process.cwd();
const direction   = get('--direction') ?? 'right';
const splitPaneId = get('--pane-id');

// --- バリデーション ---
const fail = (msg) => { console.error(`spawn-worker: ${msg}`); process.exit(1); };
if (!skill)       fail('--skill が必要です');
if (!issue)       fail('--issue が必要です');
if (!description) fail('--description が必要です');
if (!orchPaneId)  fail('--orchestrator-pane-id が必要です');
if (!repo)        fail('--repo が必要です');
if (skill === 'gh-maestro-base' && !prompt) fail('gh-maestro-base を使う場合は --prompt が必要です');

// --- パス定義 ---
const worktreeName = `issue-${issue}-${description}`;
const worktreeDir  = resolve(workspace, '.gh-maestro', 'worktrees', worktreeName);
const scriptsDir   = resolve(workspace, '.gh-maestro', 'scripts');
const sendPaneDst  = resolve(scriptsDir, 'send-pane.js');
const gitignore    = resolve(workspace, '.gitignore');

// --- .gitignore に .gh-maestro/ を追記（初回のみ） ---
const entry = '.gh-maestro/';
const alreadyIgnored = existsSync(gitignore) &&
  readFileSync(gitignore, 'utf8').split('\n').some(l => l.trim() === entry);
if (!alreadyIgnored) appendFileSync(gitignore, `\n${entry}\n`, 'utf8');

// --- .gh-maestro/scripts/ を作成して send-pane.js をコピー ---
mkdirSync(scriptsDir, { recursive: true });
copyFileSync(resolve(__dirname, 'send-pane.js'), sendPaneDst);

// --- worktree を作成 ---
mkdirSync(resolve(workspace, '.gh-maestro', 'worktrees'), { recursive: true });
execSync(`git worktree add "${worktreeDir}" -b "${worktreeName}"`, {
  cwd: workspace,
  stdio: 'inherit',
});

// --- 初期プロンプトを組み立てる ---
const context = [
  `ORCHESTRATOR_PANE_ID=${orchPaneId}`,
  `REPO=${repo}`,
  `WORKSPACE=${workspace}`,
  `WORKTREE=${worktreeDir}`,
  `ISSUE=${issue}`,
].join('\n');
const extra = prompt ? `\n${prompt}` : '';
const initialPrompt = `${context}${extra}\n\n/${skill}`;

// --- WezTerm ペイン分割 ---
const splitArgs = ['cli', 'split-pane', `--${direction}`, '--cwd', worktreeDir];
if (splitPaneId) splitArgs.push('--pane-id', splitPaneId);

const split = spawnSync('wezterm', splitArgs, { encoding: 'utf8' });
if (split.status !== 0) fail(`wezterm split-pane 失敗\n${split.stderr}`);
const newPaneId = split.stdout.trim();

// --- agy を起動 ---
const send = (text) => {
  spawnSync('wezterm', ['cli', 'send-text', '--pane-id', newPaneId, text], { encoding: 'utf8' });
  spawnSync('wezterm', ['cli', 'send-text', '--pane-id', newPaneId, '--no-paste', '\r'], { encoding: 'utf8' });
};

send(`agy --dangerously-skip-permissions -i ${JSON.stringify(initialPrompt)}`);

// --- 新しいペインIDを出力（orchestratorが受け取る） ---
console.log(newPaneId);
