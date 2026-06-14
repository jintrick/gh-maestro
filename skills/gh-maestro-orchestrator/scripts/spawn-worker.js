#!/usr/bin/env node
// spawn-worker.js
// ワーカーペインを作成し、worktreeを準備してagyを起動する
//
// Usage:
//   node spawn-worker.js \
//     --skill <skill-name> \
//     [--prompt "<role-prompt>"]  # gh-maestro-base 使用時は必須
//     [--issue <N>] \             # 省略可。省略時は --prompt の内容が TASK として渡される
//     --description <desc> \
//     --repo <owner/repo> \
//     --workspace <path> \
//     [--base-branch <branch>]
//
// 標準出力: ワーカー名（例: issue-5-implement / task-investigate-auth）

const { execSync, spawnSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync,
        readdirSync, statSync, lstatSync, rmdirSync, rmSync } = require('fs');
const { resolve, relative } = require('path');

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

// --- worktree を作成（staleな残骸があれば先に除去してリトライ） ---
mkdirSync(resolve(workspace, '.gh-maestro', 'worktrees'), { recursive: true });
try {
  execSync(`git worktree add "${worktreeDir}" -b "${workerName}"`, { cwd: workspace, stdio: 'inherit' });
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
    execSync(`git worktree add "${worktreeDir}" -b "${workerName}"`, { cwd: workspace, stdio: 'inherit' });
  } catch (e2) {
    fail(`git worktree の作成に失敗しました（残骸除去後もリトライ失敗）: ${e2.message.split('\n')[0]}`);
  }
}

// --- node_modules junctionを作成（最大3階層） ---
(function linkNodeModules(dir, depth) {
  if (depth > 3) return;
  const pkgJson = resolve(dir, 'package.json');
  if (existsSync(pkgJson)) {
    const relPath = relative(worktreeDir, dir);
    const srcModules  = resolve(workspace, relPath, 'node_modules');
    const destModules = resolve(dir, 'node_modules');
    if (existsSync(srcModules) && !existsSync(destModules)) {
      try {
        symlinkSync(srcModules, destModules, 'junction');
      } catch (e) {
        console.warn(`spawn-worker: junction作成スキップ: ${destModules} — ${e.message}`);
      }
    }
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.warn(`spawn-worker: readdirSync 失敗: ${dir} — ${e.message}`);
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const child = resolve(dir, entry);
    try {
      if (statSync(child).isDirectory()) linkNodeModules(child, depth + 1);
    } catch (e) {
      console.warn(`spawn-worker: statSync 失敗: ${child} — ${e.message}`);
    }
  }
})(worktreeDir, 0);

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

// --- 初期プロンプトを組み立てる ---
const contextLines = [
  `WORKER_NAME=${workerName}`,
  `REPO=${repo}`,
  `WORKSPACE=${workspace}`,
  `WORKTREE=${worktreeDir}`,
];
if (issue) contextLines.push(`ISSUE=${issue}`);
if (!issue && prompt) contextLines.push(`TASK=${prompt}`);
if (baseBranch) contextLines.push(`BASE_BRANCH=${baseBranch}`);
const extra = prompt ? `\n${prompt}` : '';

const initialPrompt = `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。${extra}\n\n以下の変数が与えられています：\n${contextLines.join('\n')}\n\nこの件に関する質問・報告はチャットに出力せず、orchestratorまでお願いします。「～を実装します」「着手しました」などの着手報告も不要です。`;

// --- WezTerm ペイン分割 + agy 直接起動（シェルを介さずargvで渡すことで改行等のエスケープ問題を回避） ---
const agyCmdArgs = ['agy', '--dangerously-skip-permissions', '-i', initialPrompt];
const splitArgs = ['cli', 'split-pane', `--${direction}`, '--cwd', worktreeDir, '--pane-id', splitFromPaneId, '--', ...agyCmdArgs];
const split = spawnSync('wezterm', splitArgs, { encoding: 'utf8' });
if (split.status !== 0 && splitFromPaneId !== orchPaneId) {
  console.warn(`spawn-worker: ペイン分割失敗: ${split.stderr.trim()} — orchestratorペイン(${orchPaneId})にフォールバックします`);
  const fallbackArgs = ['cli', 'split-pane', '--bottom', '--cwd', worktreeDir, '--pane-id', orchPaneId, '--', ...agyCmdArgs];
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

// --- ワーカー名を出力（orchestratorが受け取る） ---
console.log(workerName);
