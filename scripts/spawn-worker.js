#!/usr/bin/env node
// spawn-worker.js
// ワーカーペインを作成し、worktreeを準備してエージェントを起動する
//
// ⚠️  このファイルでフロー変更（環境変数・自動前処理・プロンプト配信方法）をコミットするとき、
//    コミット前に /audit-worker-skills を実行すること（CLAUDE.md「スキルとスクリプトの整合性ルール」参照）
//
// Usage:
//   node spawn-worker.js \
//     --skill <skill-name> \
//     [--short-prompt "<short-message>" | --prompt-file <path>]  # gh-maestro-base は --prompt-file 必須
//     --issue <N> \               # 必須。ワーカーのアンカー Issue
//     --description <desc> \
//     --repo <owner/repo> \
//     --workspace <path> \
//     [--base-branch <branch>] \
//     [--agent <id>]              # エージェントID。config.json > agent-defaults.json で解決（省略時はスキルに応じたデフォルト）
//     [--execution-id <id>]       # 外部成果物と紐付ける実行ID
//
// 任意の指示は必ず --prompt-file で渡す。--short-prompt は、改行・シェル特殊文字を含まない
// 短い補足メッセージだけの例外であり、--prompt-file と同時指定不可。
//
// 標準出力: ワーカー名（例: issue-5-implement）

const { spawnSync } = require('./child-process');
const { existsSync, mkdirSync, readFileSync, writeFileSync,
        lstatSync, rmdirSync, rmSync, readdirSync } = require('fs');
const { resolve, relative } = require('path');
// link-node-modules は常に同一ディレクトリに同居する（リポジトリの scripts/ もインストール先 ~/.gh-maestro/scripts/ も）。
const { linkNodeModules } = require('./link-node-modules');
const { normalizeWorkerEntry } = require('./worker-entry');
const { buildAgentCommandArgs } = require('./agent-launch');
const { checkAgentExists } = require('./agent-exec');
const { launchAgentInPane, killPaneQuiet } = require('./shared/pane-launch');
const { worktreeAdd, worktreeRemove, worktreePrune } = require('./git-worktree');
const { resolveAgentConfig, resolveSkillAgentMap } = require('./shared/resolve-config');
const { ensureInboxSupervisorRunning } = require('./shared/ensure-inbox-supervisor');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');
const { resolveTextInput } = require('./shared/text-input');
const { toWinPath } = require('./win-path');
const { startExecution, markLaunchFailure } = require('./shared/execution-registry');

const SPAWN_WORKER_VALUE_FLAGS = [
  '--skill', '--short-prompt', '--prompt-file', '--issue', '--description',
  '--repo', '--workspace', '--base-branch', '--agent',
  '--execution-id',
];

const USAGE = `spawn-worker.js — ワーカーペインを作成し、worktreeを準備してエージェントを起動する

Usage: node spawn-worker.js --skill <skill-name> --issue <N> --description <desc> --repo <owner/repo>
                            [--short-prompt <text> | --prompt-file <path>] [--workspace <path>]
                            [--base-branch <branch>] [--agent <id>] [--execution-id <id>]

Arguments:
  --skill <name>          起動するワーカースキル名
  --issue <N>             ワーカーのアンカー Issue（正の整数）
  --description <desc>    ワーカーの説明（worker名の一部になる）
  --repo <owner/repo>     対象リポジトリ
  --prompt-file <path>    任意の役割・作業指示をファイルで指定する。
                          gh-maestro-base 使用時は必須。--short-prompt と同時指定不可。
  --short-prompt <text>   例外的な短い補足メッセージ。1行・200文字以内で、文字・数字・空白と
                          . _ : / - のみ使用可能。任意の指示には --prompt-file を使用する。
  --workspace <path>      ワークスペースパス（省略時は CWD）
  --base-branch <branch>  worktree のベースブランチ
  --agent <id>            エージェントID（省略時はスキルに応じたデフォルト）
  --execution-id <id>     外部成果物と紐付ける実行ID。指定時だけ実行状態を追跡する。

Output (stdout):
  ワーカー名（例: issue-5-implement）`;

/**
 * ワーカーエントリをworkers.jsonから除去すべき（stale）か判定する。
 *
 * ペインが生存していれば除去しない。ペインが生存していなくても、セッション再開系
 * エージェント（sessionResume:true かつ asynchronousNotification:false。reasonix/agy/
 * codex等）であれば、それは1ターン完了ごとの正常な休止状態であり除去しない
 * （tryResumeAndDeliverの判定条件と同一）。それ以外（claude系等、常駐し続ける設計の
 * ためペイン不在が本当に異常＝放棄を意味する）のみ除去対象とする。
 *
 * @param {{paneId: string|null, agentId: string|null}} entry
 * @param {Set<string>} alivePaneIds
 * @param {(agentId: string) => object|null} resolveAgent
 * @returns {boolean}
 */
function shouldPruneStaleWorker(entry, alivePaneIds, resolveAgent) {
  if (alivePaneIds.has(entry.paneId)) return false;
  let agentConfig;
  try {
    agentConfig = entry.agentId ? resolveAgent(entry.agentId) : null;
  } catch {
    agentConfig = null;
  }
  if (agentConfig && agentConfig.sessionResume && !agentConfig.asynchronousNotification) return false;
  return true;
}

module.exports = { shouldPruneStaleWorker };

if (require.main === module) {

// --- 引数パース ---
const argv = process.argv.slice(2);
const { values, rest, exitFlagMiss } = parseFlags(argv, SPAWN_WORKER_VALUE_FLAGS);

// exitFlagMiss（値欠落）を先に判定する。値欠落は常にエラー優先（フェイルクローズ）とし、
// help 判定より先に確定させる（他スクリプトと同様のパターン。argv-parsing-pitfalls参照）。
if (exitFlagMiss) {
  console.error(USAGE);
  process.exit(1);
}

if (hasHelpFlag(rest)) {
  console.log(USAGE);
  process.exit(0);
}

if (rest.length > 0) {
  console.error(`spawn-worker: 未知の引数です: ${rest.join(' ')}`);
  console.error(USAGE);
  process.exit(1);
}

const skill       = values['--skill'];
const shortPromptText = values['--short-prompt'];
const promptFileArg   = values['--prompt-file'];
const issue       = values['--issue'];
const description = values['--description'];
const repo        = values['--repo'];
const workspace   = values['--workspace'] ?? process.cwd();
const baseBranch  = values['--base-branch'];
const explicitAgentId = values['--agent'];
const executionId = values['--execution-id'] || null;

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
if (shortPromptText != null && promptFileArg != null) fail('--short-prompt と --prompt-file は同時に指定できません');
if (shortPromptText != null && !/^[\p{L}\p{N}\p{M}\p{Zs}._:/-]{1,200}$/u.test(shortPromptText)) {
  fail('--short-prompt は1行・200文字以内で、文字・数字・空白と . _ : / - のみ使用できます。任意の指示はファイルに書き出し、--prompt-file <path> を使用してください');
}
let prompt;
try {
  prompt = resolveTextInput({ inlineValue: shortPromptText ?? null, filePath: promptFileArg ? toWinPath(promptFileArg) : null });
} catch (e) {
  fail(`--prompt-file の読み込みに失敗しました: ${e.message}`);
}
if (skill === 'gh-maestro-base' && !promptFileArg) fail('gh-maestro-base を使う場合は --prompt-file が必要です。任意の役割指示をファイルに書き出して指定してください');
if (!issue) fail('--issue が必要です（ワーカーのアンカー Issue）');
if (!/^[1-9][0-9]*$/.test(issue)) fail('--issue は正の整数である必要があります');

// --- エージェントID決定（--agent フラグ > skillAgentMap > フォールバック 'agy'） ---
const skillMap = resolveSkillAgentMap({ workspace });
const agentId = explicitAgentId ?? skillMap[skill] ?? 'agy';

const orchPaneId = process.env.WEZTERM_PANE;
if (!orchPaneId)  fail('WEZTERM_PANE が設定されていません');

// --- エージェント設定を解決（config.json > agent-defaults.json） ---
const homedir = process.env.HOME || process.env.USERPROFILE || '';
let agentConfig = resolveAgentConfig(agentId, { workspace, homedir });
if (!agentConfig) {
  if (explicitAgentId) {
    fail(`エージェント "${agentId}" が設定に見つかりません。~/.gh-maestro/config.json または <workspace>/.gh-maestro/config.json で定義されているか確認してください。`);
  }
  // フォールバック 'agy' も見つからないのは設定破損
  fail(`エージェント "${agentId}" の設定を解決できません。agent-defaults.json が破損していないか確認してください。`);
}

// --- エージェントがログインシェルで解決可能か確認 ---
// 実起動と同じ解決方法（ログインシェル経由）で存在確認を行う。
// PATH 実行ファイル・pwsh 関数・シェルエイリアスのいずれでも一貫して判定する。
if (!checkAgentExists(agentConfig.command)) {
  fail(`エージェント "${agentId}" のコマンド "${agentConfig.command}" が見つかりません。CLIがインストールされているか、pwsh関数/シェルエイリアスが定義されているか確認してください。`);
}

// --- [レガシーガード] pwsh -Command 経由エージェントの空白パスガード ---
// 新しい agent-exec.js は -EncodedCommand（Windows）/ exec "$@"（Unix）を使用するため
// 引数内の空白は安全に扱える。ただし、extraArgs に -Command を含む旧来のカスタム設定が
// config.json に残っている場合のためにこのガードを残す（新構成では発動しない想定）。
if (agentConfig.extraArgs?.includes('-Command') && /\s/.test(workspace)) {
  console.error(`spawn-worker: ワークスペースのパスに空白が含まれています: "${workspace}"`);
  console.error(`  エージェント "${agentId}" は pwsh -Command 経由で起動するため、空白を含むパスは`);
  console.error(`  PowerShell の再パースで引数が分割され、起動が壊れます。`);
  console.error(`  → 空白を含まないパスにワークスペースを移すか、argv をそのまま渡すエージェント（claude / agy 等）を使ってください。`);
  process.exit(1);
}

// --- パス定義 ---
const workerName   = `issue-${issue}-${description}`;
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
  workers.orchestrator = { paneId: orchPaneId, agentId: null };
}

// --- 生存確認: staleなpane_idをworkers.jsonから除去 ---
const getAlivePaneIds = () => {
  const r = spawnSync('wezterm', ['cli', '--no-auto-start', 'list', '--format', 'json'], { encoding: 'utf8', timeout: 6000 });
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
    if (k === 'orchestrator') continue;
    const entry = normalizeWorkerEntry(v);
    if (!shouldPruneStaleWorker(entry, alivePanes, (id) => resolveAgentConfig(id, { workspace, homedir }))) continue;

    console.warn(`spawn-worker: stale worker "${k}" (pane_id ${entry.paneId}) を workers.json から除去します`);
    delete workers[k];
    dirty = true;
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
  splitFromPaneId = normalizeWorkerEntry(workers[existingWorkers[existingWorkers.length - 1]]).paneId;
}

// --- baseBranch をリモートと同期（worktreeが常に最新ベースから分岐するよう保証） ---
// spawnSync の引数配列でシェル注入を回避する
if (baseBranch) {
  try {
    // -- でブランチ名が - 始まりでもオプション扱いされないようにする（引数注入対策）
    const fetchR = spawnSync('git', ['fetch', 'origin', '--', baseBranch], { cwd: workspace, stdio: 'pipe' });
    if (fetchR.status !== 0) {
      throw new Error(`git fetch origin ${baseBranch} 失敗: ${(fetchR.stderr || '').toString().trim()}`);
    }
    const curR = spawnSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8' });
    const cur = (curR.stdout || '').trim();
    if (cur === baseBranch) {
      try {
        const mergeR = spawnSync('git', ['merge', '--ff-only', '--', `origin/${baseBranch}`], { cwd: workspace, stdio: 'pipe' });
        if (mergeR.status !== 0) throw new Error(`merge failed: ${(mergeR.stderr || '').toString().trim()}`);
      } catch (_) { console.warn(`spawn-worker: ローカル ${baseBranch} のff-only更新失敗 — worktreeはorigin/${baseBranch}から分岐します`); }
    }
  } catch (e) {
    console.warn(`spawn-worker: git fetch origin ${baseBranch} 失敗（続行します）: ${e.message.split('\n')[0]}`);
  }
}

// --- worktree を作成（staleな残骸があれば先に除去してリトライ） ---
mkdirSync(resolve(workspace, '.gh-maestro', 'worktrees'), { recursive: true });
try {
  worktreeAdd(worktreeDir, workerName, baseBranch || null, workspace);
} catch (e) {
  console.warn(`spawn-worker: worktree作成失敗: ${e.message.split('\n')[0]} — 残骸を除去してリトライします`);
  // 残骸除去（各ステップの失敗を個別にログ）
  try { worktreeRemove(worktreeDir, workspace); }
  catch (e2) { console.warn(`  git worktree remove: ${e2.message.split('\n')[0]}`); }
  try { worktreePrune(workspace); }
  catch (e2) { console.warn(`  git worktree prune: ${e2.message.split('\n')[0]}`); }
  try { rmSync(worktreeDir, { recursive: true, force: true }); }
  catch (e2) { console.warn(`  rmSync: ${e2.message.split('\n')[0]}`); }
  try {
    const delR = spawnSync('git', ['branch', '-D', '--', workerName], { cwd: workspace, stdio: 'pipe' });
    if (delR.status !== 0) throw new Error(`git branch -D 失敗: ${(delR.stderr || '').toString().trim()}`);
  } catch (e2) { console.warn(`  git branch -D: ${e2.message.split('\n')[0]}`); }
  // リトライ
  try {
    worktreeAdd(worktreeDir, workerName, baseBranch || null, workspace);
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

  try { worktreeRemove(worktreeDir, workspace); }
  catch (e) {
    console.warn(`  rollback: git worktree remove 失敗: ${e.message.split('\n')[0]}`);
    try { worktreePrune(workspace); }
    catch (e2) { console.warn(`  rollback: git worktree prune 失敗: ${e2.message.split('\n')[0]}`); }
    try { rmSync(worktreeDir, { recursive: true, force: true }); }
    catch (e2) { console.warn(`  rollback: rmSync 失敗: ${e2.message.split('\n')[0]}`); }
  }
  try {
    const delR = spawnSync('git', ['branch', '-d', '--', workerName], { cwd: workspace, stdio: 'pipe' });
    if (delR.status !== 0) throw new Error(`git branch -d 失敗: ${(delR.stderr || '').toString().trim()}`);
  } catch (e) { console.warn(`  rollback: git branch -d 失敗: ${e.message.split('\n')[0]}`); }
};

// --- 初期プロンプトをファイルに書き出す ---
// WindowsのspawnSyncは改行を含むargvを正しく渡せないため、argvではなく
// --append-system-prompt-file でファイル経由で渡す（claude/claude-ds向け）。
// agyは -i フラグでargv経由（agyが stdin からの読み取りをサポートしていないため）。
const toUnix = (p) => p.replace(/\\/g, '/');
const contextLines = [
  `WORKER_NAME=${workerName}`,
  `WORKER_ROLE=${skill}`,
  `REPO=${repo}`,
  `WORKSPACE=${toUnix(workspace)}`,
  `WORKTREE=${toUnix(worktreeDir)}`,
];
if (executionId) contextLines.push(`EXECUTION_ID=${executionId}`);
contextLines.push(`ISSUE=${issue}`);
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

// --- プロンプト配送メカニズム ---
// エージェントごとの起動argv組み立ては、agent-defaults.json の promptDelivery（宣言的データ）で選び、
// 実装（この4パターン）だけを spawn-worker.js に集約する。エージェント追加時に触るのは
// agent-defaults.json 側のデータだけで済み、ここに新しい if 分岐を足す必要は無いのが望ましい状態。
// docs/agent-launch-mechanism-plan.md 参照。
let agentCmdArgs;
try {
  agentCmdArgs = buildAgentCommandArgs(agentConfig, {
    promptFile,
    shortPrompt,
    systemPromptText: `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。`,
  });
} catch (e) {
  fail(`エージェント "${agentConfig.id}" の起動引数を組み立てられません: ${e.message}`);
}

// --- WezTerm ペイン分割 + エージェント起動（ログインシェル経由） ---
// 全エージェントをログインシェル経由にラップする（scripts/shared/pane-launch.js に集約）。
// これにより PATH 実行ファイル・pwsh 関数・エイリアスのすべてが起動可能になる。
// argv の完全性は各プラットフォームのエンコード方式で保証される（agent-exec.js 参照）。
// send-text-after-launch方式（起動argvにプロンプトを渡せないエージェント向けの後方互換経路。
// 現状どのエージェントも使っていない — reasonix/agy/codexは全て非対話1回実行モードの
// argv直接渡しに統一済み）向けの初期プロンプト注入も launchAgentInPane が担う
// （TUI初期化待ち: agent-defaults.json の sendTextDelayMs、既定2000ms）。
let newPaneId;
let afterLaunchTextSent;
let execution;
try {
  if (executionId) {
    execution = startExecution(workspace, { executionId, issue, workerName, skill });
    if (execution.status === 'completed') {
      fail(`実行 "${executionId}" は既に完了しています（${execution.commentUrl}）。同じ成果物は再投稿しません`);
    }
  }
  ({ paneId: newPaneId, afterLaunchTextSent } = launchAgentInPane({
    argv: agentCmdArgs,
    worktreeDir,
    splitFromPaneId,
    orchPaneId,
    direction,
    afterLaunchText: agentConfig.promptDelivery === 'send-text-after-launch' ? shortPrompt : null,
    sendTextDelayMs: agentConfig.sendTextDelayMs ?? 2000,
    enterTerminator: agentConfig.enterSequence ?? '\r',
    onExit: executionId ? {
      command: process.execPath,
      args: [resolve(__dirname, 'record-execution-exit.js'), workspace, executionId],
    } : null,
  }));
} catch (e) {
  if (executionId) {
    try { markLaunchFailure(workspace, executionId, e.message); } catch (_) {}
  }
  rollbackWorktree();
  fail(e.message);
}
if (agentConfig.promptDelivery === 'send-text-after-launch') {
  if (afterLaunchTextSent) {
    console.warn(`spawn-worker: 初期プロンプトをsend-textで送信しました (pane ${newPaneId})`);
  } else {
    console.warn(`spawn-worker: send-text失敗 (pane ${newPaneId})`);
  }
}

// --- workers.json にワーカーを登録（失敗時はペインもロールバック） ---
try {
  workers[workerName] = normalizeWorkerEntry({ paneId: newPaneId, agentId: agentConfig.id, issue });
  writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
  console.warn(`spawn-worker: worker "${workerName}" を pane ${newPaneId} として workers.json に登録しました`);
} catch (e) {
  killPaneQuiet(newPaneId);
  rollbackWorktree();
  fail(`workers.json への書き込みに失敗しました: ${e.message}`);
}

// --- inbox-supervisor.js の自動起動保証（best-effort） ---
// エージェント種別を問わず毎回試みる。稼働中なら inbox-supervisor.js 自身のロックが検知して
// 即exitするため二重起動にはならない（ensure-inbox-supervisor.js 参照）。orchestrator が
// 手動起動を忘れても配送経路が失われないようにする。
ensureInboxSupervisorRunning({ workspace, scriptsPath: __dirname });

// --- ワーカー名を出力（orchestratorが受け取る） ---
console.log(workerName);

} // require.main === module
