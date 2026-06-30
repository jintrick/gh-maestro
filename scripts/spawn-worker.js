#!/usr/bin/env node
// spawn-worker.js
// ワーカーペインを作成し、worktreeを準備してエージェントを起動する
//
// ⚠️  このファイルをコミットに含めるとき、コミット前に /audit-worker-skills を実行すること
//    （CLAUDE.md「スキルとスクリプトの整合性ルール」参照）
//
// Usage:
//   node spawn-worker.js \
//     --skill <skill-name> \
//     [--prompt "<role-prompt>"]  # gh-maestro-base 使用時は必須
//     [--issue <N>] \             # 省略可。省略時は --prompt の内容が TASK として渡される
//     --description <desc> \
//     --repo <owner/repo> \
//     --workspace <path> \
//     [--base-branch <branch>] \
//     [--agent <id>]              # ~/.gh-maestro/agents.json のエージェントID（省略時は agy）
//
// 標準出力: ワーカー名（例: issue-5-implement / task-investigate-auth）

const { execSync, spawn, spawnSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync,
        lstatSync, rmdirSync, rmSync } = require('fs');
const { resolve, relative } = require('path');
// link-node-modules は常に同一ディレクトリに同居する（リポジトリの scripts/ もインストール先 ~/.gh-maestro/scripts/ も）。
const { linkNodeModules } = require('./link-node-modules');

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
const agentId     = get('--agent') ?? 'agy';

// --- バリデーション ---
const resetCmd = `node "${resolve(__dirname, 'reset-session.js')}" --workspace "${workspace}"`;
const fail = (msg) => {
  console.error(`spawn-worker: ${msg}`);
  console.error(`  → セッション状態が壊れている可能性があります。次のコマンドでリセットしてください:`);
  console.error(`    ${resetCmd}`);
  process.exit(1);
};
if (!skill)       fail('--skill が必要です');
if (!description) fail('--description が必要です');
if (!repo)        fail('--repo が必要です');
if (skill === 'gh-maestro-base' && !prompt) fail('gh-maestro-base を使う場合は --prompt が必要です');
if (prompt && /['`]/.test(prompt)) {
  console.error("spawn-worker: --prompt にシングルクォート(')またはバッククォート(`)を含めることはできません。");
  console.error("  → 実装詳細はIssueに記述し、--prompt にはIssue番号と役割のみ記載してください。");
  process.exit(1);
}

const orchPaneId = process.env.WEZTERM_PANE;
if (!orchPaneId)  fail('WEZTERM_PANE が設定されていません');

// --- agents.json からエージェント設定を解決 ---
const homedir = process.env.HOME || process.env.USERPROFILE || '';
const agentsJsonPath = resolve(homedir, '.gh-maestro', 'agents.json');
let agentConfig = null;
if (existsSync(agentsJsonPath)) {
  try {
    const agents = JSON.parse(readFileSync(agentsJsonPath, 'utf8'));
    agentConfig = agents.find(a => a.id === agentId) ?? null;
  } catch (e) {
    console.warn(`spawn-worker: agents.json のパースに失敗しました: ${e.message}`);
  }
}
if (!agentConfig) {
  const explicit = process.argv.includes('--agent');
  if (explicit) {
    fail(`エージェント "${agentId}" が ~/.gh-maestro/agents.json に見つかりません。手動で追加するか、node scripts/install.js を実行してください。`);
  }
  // --agent 未指定のデフォルトフォールバック
  agentConfig = { id: 'agy', label: 'Antigravity', command: 'agy', extraArgs: ['--dangerously-skip-permissions'], promptFlag: '-i' };
}

// --- エージェントバイナリが PATH 上に存在するか確認 ---
{
  const whichCmd = process.platform === 'win32' ? 'where' : 'command';
  const whichArgs = process.platform === 'win32' ? [agentConfig.command] : ['-v', agentConfig.command];
  const which = spawnSync(whichCmd, whichArgs, { encoding: 'utf8', stdio: 'pipe' });
  if (which.status !== 0) {
    fail(`エージェント "${agentId}" のコマンド "${agentConfig.command}" が PATH に見つかりません。CLIがインストールされているか確認してください。`);
  }
}

// --- pwsh -Command 経由エージェントの空白パスガード ---
// pwsh -Command は文字列を再パースするため、起動引数に渡すパス（worktree 配下の
// prompt.md 等）に空白があるとトークン分割されて壊れる。worktree は workspace 配下に
// 作られるので、workspace に空白があれば起動が確実に壊れる。早期に明確なエラーで止める。
// （claude 直起動や agy は argv がそのまま渡るため空白でも壊れず、この制約の対象外）
if (agentConfig.extraArgs?.includes('-Command') && /\s/.test(workspace)) {
  console.error(`spawn-worker: ワークスペースのパスに空白が含まれています: "${workspace}"`);
  console.error(`  エージェント "${agentId}" は pwsh -Command 経由で起動するため、空白を含むパスは`);
  console.error(`  PowerShell の再パースで引数が分割され、起動が壊れます。`);
  console.error(`  → 空白を含まないパスにワークスペースを移すか、argv をそのまま渡すエージェント（claude / agy 等）を使ってください。`);
  process.exit(1);
}

// --- パス定義 ---
const workerName   = issue ? `issue-${issue}-${description}` : `task-${description}`;
const worktreeDir  = resolve(workspace, '.gh-maestro', 'worktrees', workerName);
const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');

// --- workers.json を読み込み（なければ初期化、破損時は空として扱う） ---
let workers = {};
if (existsSync(workersJson)) {
  try {
    const parsed = JSON.parse(readFileSync(workersJson, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      workers = parsed;
    } else {
      console.warn(`spawn-worker: workers.json の内容が不正です（型: ${typeof parsed}）。空として扱います。`);
    }
  } catch (e) {
    console.warn(`spawn-worker: workers.json のパースに失敗しました: ${e.message}。空として扱います。`);
  }
}
if (!workers.orchestrator) {
  workers.orchestrator = orchPaneId;
}

// --- 生存確認: staleなpane_idをworkers.jsonから除去 ---
const getAlivePaneIds = () => {
  const r = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8', timeout: 6000 });
  if (r.error?.code === 'ETIMEDOUT') {
    console.warn('spawn-worker: wezterm cli list がタイムアウト — stale除去をスキップします');
    return null;
  }
  if (r.status !== 0) {
    console.warn(`spawn-worker: wezterm cli list 失敗: ${r.stderr.trim()} — stale除去をスキップします`);
    return null;
  }
  try {
    return new Set(JSON.parse(r.stdout).map(p => String(p.pane_id)));
  } catch (e) {
    console.warn(`spawn-worker: wezterm cli list の出力パース失敗: ${e.message} — stale除去をスキップします`);
    return null;
  }
};

const alivePanes = getAlivePaneIds();
if (alivePanes !== null) {
  let dirty = false;
  for (const [k, v] of Object.entries(workers)) {
    if (k !== 'orchestrator' && !alivePanes.has(String(v))) {
      console.warn(`spawn-worker: stale worker "${k}" (pane_id ${v}) を workers.json から除去します`);
      delete workers[k];
      dirty = true;
    }
  }
  if (dirty) writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
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

// --- baseBranch をリモートと同期（worktreeが常に最新ベースから分岐するよう保証） ---
if (baseBranch) {
  try {
    execSync(`git fetch origin ${baseBranch}`, { cwd: workspace, stdio: 'pipe' });
    const cur = execSync('git branch --show-current', { cwd: workspace, encoding: 'utf8' }).trim();
    if (cur === baseBranch) {
      try { execSync(`git merge --ff-only origin/${baseBranch}`, { cwd: workspace, stdio: 'pipe' }); }
      catch (_) { console.warn(`spawn-worker: ローカル ${baseBranch} のff-only更新失敗 — worktreeはorigin/${baseBranch}から分岐します`); }
    }
  } catch (e) {
    console.warn(`spawn-worker: git fetch origin ${baseBranch} 失敗（続行します）: ${e.message.split('\n')[0]}`);
  }
}

// --- worktree を作成（staleな残骸があれば先に除去してリトライ） ---
mkdirSync(resolve(workspace, '.gh-maestro', 'worktrees'), { recursive: true });
const worktreeStart = baseBranch ? ` "origin/${baseBranch}"` : '';
try {
  execSync(`git worktree add "${worktreeDir}" -b "${workerName}"${worktreeStart}`, { cwd: workspace, stdio: 'inherit' });
} catch (e) {
  console.warn(`spawn-worker: worktree作成失敗: ${e.message.split('\n')[0]} — 残骸を除去してリトライします`);
  // 残骸除去（各ステップの失敗を個別にログ）
  try { execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: workspace, stdio: 'pipe' }); }
  catch (e2) { console.warn(`  git worktree remove: ${e2.message.split('\n')[0]}`); }
  try { execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' }); }
  catch (e2) { console.warn(`  git worktree prune: ${e2.message.split('\n')[0]}`); }
  try { rmSync(worktreeDir, { recursive: true, force: true }); }
  catch (e2) { console.warn(`  rmSync: ${e2.message.split('\n')[0]}`); }
  try { execSync(`git branch -D "${workerName}"`, { cwd: workspace, stdio: 'pipe' }); }
  catch (e2) { console.warn(`  git branch -D: ${e2.message.split('\n')[0]}`); }
  // リトライ
  try {
    execSync(`git worktree add "${worktreeDir}" -b "${workerName}"${worktreeStart}`, { cwd: workspace, stdio: 'inherit' });
  } catch (e2) {
    fail(`git worktree の作成に失敗しました（残骸除去後もリトライ失敗）: ${e2.message.split('\n')[0]}`);
  }
}

// --- node_modules junctionを作成（最大3階層） ---
const nmResult = linkNodeModules(worktreeDir, workspace);
for (const p of nmResult.linked)   console.warn(`spawn-worker: junction作成: ${p}`);
for (const p of nmResult.missing)  console.warn(`spawn-worker: [要対応] junction作成に失敗しました: ${p}`);

// --- worktree のロールバック関数（以降の処理が失敗したときに使う） ---
const rollbackWorktree = () => {
  console.warn('spawn-worker: worktreeをロールバックします...');
  // junction除去
  (function unlinkJunctions(dir) {
    if (!existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir); } catch (e) {
      console.warn(`  rollback: readdirSync 失敗: ${dir} — ${e.message}`); return;
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry);
      try {
        const st = lstatSync(fullPath);
        if (st.isSymbolicLink()) rmdirSync(fullPath);
        else if (st.isDirectory()) unlinkJunctions(fullPath);
      } catch (e) {
        console.warn(`  rollback: junction除去失敗: ${fullPath} — ${e.message}`);
      }
    }
  })(worktreeDir);

  try { execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: workspace, stdio: 'pipe' }); }
  catch (e) {
    console.warn(`  rollback: git worktree remove 失敗: ${e.message.split('\n')[0]}`);
    try { execSync('git worktree prune', { cwd: workspace, stdio: 'pipe' }); }
    catch (e2) { console.warn(`  rollback: git worktree prune 失敗: ${e2.message.split('\n')[0]}`); }
    try { rmSync(worktreeDir, { recursive: true, force: true }); }
    catch (e2) { console.warn(`  rollback: rmSync 失敗: ${e2.message.split('\n')[0]}`); }
  }
  try { execSync(`git branch -d "${workerName}"`, { cwd: workspace, stdio: 'pipe' }); }
  catch (e) { console.warn(`  rollback: git branch -d 失敗: ${e.message.split('\n')[0]}`); }
};

// --- 初期プロンプトをファイルに書き出す ---
// WindowsのspawnSyncは改行を含むargvを正しく渡せないため、argvではなく
// --append-system-prompt-file でファイル経由で渡す（claude/claude-ds向け）。
// agyは -i フラグでargv経由（agyが stdin からの読み取りをサポートしていないため）。
const toUnix = (p) => p.replace(/\\/g, '/');
const contextLines = [
  `WORKER_NAME=${workerName}`,
  `REPO=${repo}`,
  `WORKSPACE=${toUnix(workspace)}`,
  `WORKTREE=${toUnix(worktreeDir)}`,
];
if (issue) contextLines.push(`ISSUE=${issue}`);
if (!issue && prompt) contextLines.push(`TASK=${prompt}`);
if (baseBranch) contextLines.push(`BASE_BRANCH=${baseBranch}`);
const extra = prompt ? `\n${prompt}` : '';

const initialPrompt = `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。${extra}\n\n以下の変数が与えられています：\n${contextLines.join('\n')}\n\nこの件に関する質問・報告はチャットに出力せず、orchestratorまでお願いします。「～を実装します」「着手しました」などの着手報告も不要です。`;

const promptDir = resolve(worktreeDir, '.gh-maestro');
mkdirSync(promptDir, { recursive: true });
const promptFile = resolve(promptDir, 'prompt.md');
writeFileSync(promptFile, initialPrompt, 'utf8');
console.warn(`spawn-worker: プロンプトを ${promptFile} に書き出しました`);

// --- skillsViaMd: SKILL.md + 変数を AGENTS.md としてworktreeに書き出す ---
// スキルシステムを持たないエージェント（reasonix 等）向け。
// AGENTS.md をworktreeルートに置くことでエージェントがプロジェクト記憶として自動ロードする。
if (agentConfig.skillsViaMd) {
  const sharedSkillMd = resolve(homedir, '.gh-maestro', 'skills', skill, 'SKILL.md');
  let skillContent = '';
  if (existsSync(sharedSkillMd)) {
    const raw = readFileSync(sharedSkillMd, 'utf8');
    // frontmatter を除去
    skillContent = raw.startsWith('---\n')
      ? raw.slice(raw.indexOf('\n---\n', 4) + 5)
      : raw;
  } else {
    console.warn(`spawn-worker: 共有スキルファイルが見つかりません: ${sharedSkillMd}`);
  }
  const agentsMd = `${skillContent}\n## セッション変数\n\n${contextLines.join('\n')}\n`;
  writeFileSync(resolve(worktreeDir, 'AGENTS.md'), agentsMd, 'utf8');
  console.warn(`spawn-worker: AGENTS.md を書き出しました`);
}

const shortPrompt = agentConfig.skillsViaMd
  ? `orchestratorです。AGENTS.mdの指示に従って作業を開始してください。`
  : `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。詳細は ${toUnix(promptFile)} を参照してください。`;

const agentCmdArgs = (() => {
  if (agentConfig.skillsViaMd && !agentConfig.promptFlag) {
    // reasonix等: positional argは未サポート。起動後にsend-textで注入する
    return [agentConfig.command, ...agentConfig.extraArgs];
  }
  if (agentConfig.promptFlag) {
    // agy: -i フラグでargv経由（改行なしの短い参照プロンプトを渡す）
    return [agentConfig.command, ...agentConfig.extraArgs, agentConfig.promptFlag, shortPrompt];
  }
  // claude/claude-ds: --append-system-prompt-file でファイル経由
  return [
    agentConfig.command,
    ...agentConfig.extraArgs,
    '--append-system-prompt-file', promptFile,
    `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。`,
  ];
})();

// --- WezTerm ペイン分割 + エージェント直接起動（シェルを介さずargvで渡すことで改行等のエスケープ問題を回避） ---
const splitArgs = ['cli', 'split-pane', `--${direction}`, '--cwd', worktreeDir, '--pane-id', splitFromPaneId, '--', ...agentCmdArgs];
const split = spawnSync('wezterm', splitArgs, { encoding: 'utf8' });
if (split.status !== 0 && splitFromPaneId !== orchPaneId) {
  console.warn(`spawn-worker: ペイン分割失敗: ${split.stderr.trim()} — orchestratorペイン(${orchPaneId})にフォールバックします`);
  const fallbackArgs = ['cli', 'split-pane', '--bottom', '--cwd', worktreeDir, '--pane-id', orchPaneId, '--', ...agentCmdArgs];
  const split2 = spawnSync('wezterm', fallbackArgs, { encoding: 'utf8' });
  if (split2.status === 0) {
    split.status = 0;
    split.stdout = split2.stdout;
  } else {
    rollbackWorktree();
    fail(`WezTermペインの分割に失敗しました（フォールバックも失敗）: ${split2.stderr.trim()}`);
  }
} else if (split.status !== 0) {
  rollbackWorktree();
  fail(`WezTermペインの分割に失敗しました: ${split.stderr.trim()}`);
}
const newPaneId = (split.stdout ?? '').trim();
if (!newPaneId) {
  console.error(`spawn-worker: wezterm split-pane が pane-id を返しませんでした`);
  console.error(`  stdout: ${JSON.stringify(split.stdout)}`);
  console.error(`  stderr: ${split.stderr?.trim()}`);
  rollbackWorktree();
  fail('wezterm split-pane の pane-id を取得できませんでした（ペインが作成された可能性があります）');
}

// --- workers.json にワーカーを登録（失敗時はペインもロールバック） ---
try {
  workers[workerName] = newPaneId;
  writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
  console.warn(`spawn-worker: worker "${workerName}" を pane ${newPaneId} として workers.json に登録しました`);
} catch (e) {
  spawnSync('wezterm', ['cli', 'kill-pane', '--pane-id', newPaneId], { encoding: 'utf8' });
  rollbackWorktree();
  fail(`workers.json への書き込みに失敗しました: ${e.message}`);
}

// --- skillsViaMd + promptFlagなし（reasonix等）: 起動後にsend-textでプロンプトを注入 ---
// positional argはreasonixのインタラクティブモードで未サポートのため、
// TUI初期化待ち後にwezterm cli send-textでプロンプトを送る。
if (agentConfig.skillsViaMd && !agentConfig.promptFlag) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  const sendResult = spawnSync('wezterm', ['cli', 'send-text', '--pane-id', newPaneId, '--no-paste', shortPrompt + '\n'], { encoding: 'utf8' });
  if (sendResult.status !== 0) {
    console.warn(`spawn-worker: send-text失敗 (pane ${newPaneId}): ${sendResult.stderr?.trim()}`);
  } else {
    console.warn(`spawn-worker: 初期プロンプトをsend-textで送信しました (pane ${newPaneId})`);
  }
}

// --- コーダー起動時はPRポーリングを自動開始 ---
if (skill === 'gh-maestro-coder' && issue) {
  const notifier = spawn(process.execPath, [
    resolve(__dirname, 'poll-and-notify.js'),
    issue,
    '--workspace', workspace,
  ], {
    cwd: workspace,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  notifier.unref();
  console.warn(`spawn-worker: poll-and-notify を起動しました (issue=${issue})`);
}

// --- ワーカー名を出力（orchestratorが受け取る） ---
console.log(workerName);
