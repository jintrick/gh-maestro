#!/usr/bin/env node
// spawn-worker.js
// worktreeを準備し、ワーカーをheadless（画面なし）で起動する
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
// 標準出力: ワーカー名（例: issue-5-coder-implement）

const { spawnSync } = require('./child-process');
const { existsSync, mkdirSync, readFileSync, writeFileSync,
        lstatSync, rmdirSync, rmSync, readdirSync } = require('fs');
const { resolve, relative } = require('path');
// link-node-modules は常に同一ディレクトリに同居する（リポジトリの scripts/ もインストール先 ~/.gh-maestro/scripts/ も）。
const { linkNodeModules } = require('./link-node-modules');
const { normalizeWorkerEntry } = require('./worker-entry');
const { buildAgentCommandArgs } = require('./agent-launch');
const { checkAgentExists } = require('./agent-exec');
const { launchAgentHeadless } = require('./shared/headless-launch');
const { buildNormalWorkerLaunchSpec } = require('./shared/worker-factory');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { createNormalWorkerStore, acquireLease: acquireWorkerLease,
        activateLease: activateWorkerLease, releaseLease: releaseWorkerLease,
        isLeaseLive } = require('./shared/worker-lease');
const { killProcessTree } = require('./kill-tree');
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

const USAGE = `spawn-worker.js — worktreeを準備し、ワーカーをheadless（画面なし）で起動する

Usage: node spawn-worker.js --skill <skill-name> --issue <N> --description <desc> --repo <owner/repo>
                            [--short-prompt <text> | --prompt-file <path>] [--workspace <path>]
                            [--base-branch <branch>] [--agent <id>] [--execution-id <id>]

Arguments:
  --skill <name>          起動するワーカースキル名
  --issue <N>             ワーカーのアンカー Issue（正の整数）
  --description <desc>    ワーカーの説明。workerName（worktreeディレクトリ名・gitブランチ名・
                          workers.jsonのキー）の一部として issue-<N>-<role>-<desc> の形で使われる。
                          role はスキルから導出される（例: coder, senior-coder, explorer）。
	                          英数字・ハイフン・アンダースコアのみ、1〜50文字（例: explore-auth）。
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
  ワーカー名（例: issue-5-coder-implement）

ワーカーは画面を持たないバックグラウンドプロセスとして起動し、標準出力/標準エラーは
<workspace>/.gh-maestro/worker-logs/<worker>.log へ実行中から逐次書き込まれる。`;

/**
 * ワーカーエントリをworkers.jsonから除去すべき（stale）か判定する。
 *
 * プロセスが生存していれば除去しない。生存していなくても、エージェント設定が解決できる限り
 * 除去しない——全エージェントはセッション再開方式であり、プロセス不在は1ターン完了ごとの
 * 正常な休止状態だからである（tryResumeAndDeliverの判定条件と同一）。
 * 除去するのは agentId が解決できないエントリ（設定破損・削除済みエージェント）だけで、
 * これは resume 経路が二度と成立しないことを意味する。
 *
 * @param {object} entry workers.json のエントリ
 * @param {(agentId: string) => object|null} resolveAgent
 * @param {(entry: object) => boolean} [aliveFn=isWorkerAlive] テスト用の注入口
 * @returns {boolean}
 */
function shouldPruneStaleWorker(entry, resolveAgent, aliveFn = isWorkerAlive) {
  if (aliveFn(entry)) return false;
  let agentConfig;
  try {
    agentConfig = entry.agentId ? resolveAgent(entry.agentId) : null;
  } catch {
    agentConfig = null;
  }
  if (agentConfig) return false;
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
let fail = (msg) => {
  console.error(`spawn-worker: ${msg}`);
  console.error(`  → セッション状態が壊れている可能性があります。次のコマンドでリセットしてください:`);
  console.error(`    ${resetCmd}`);
  process.exit(1);
};
if (!skill)       fail('--skill が必要です');
if (!description) fail('--description が必要です');
if (description && !/^[A-Za-z0-9_-]{1,50}$/.test(description)) {
  fail('--description は英数字・ハイフン・アンダースコアのみ、1〜50文字である必要があります（例: explore-auth）。この値は worktreeディレクトリ名・gitブランチ名にそのまま使われるため、スペース・スラッシュ・ドット等は使用できません');
}
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

// --- send-text-after-launch は headless では実現できない（フェイルクローズ） ---
// この方式は起動argvにプロンプトを渡せないエージェント向けの後方互換経路で、画面への
// 入力注入を前提としている。黙ってプロンプト無しで起動するとワーカーが指示を受け取れない
// まま走り出すため拒否する。worktree作成・プロンプト書き出しより前に落として副作用を残さない。
if (agentConfig.promptDelivery === 'send-text-after-launch') {
  fail(
    `エージェント "${agentConfig.id}" の promptDelivery が "send-text-after-launch" ですが、` +
    `この方式は画面への入力注入を前提としており headless 実行では使えません。` +
    `agent-defaults.json / config.json で flag・positional・system-prompt-file のいずれかに変更してください。`
  );
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

// --- 起動仕様をfactoryから確定（Phase 3: 共通パイプライン） ---
// workerName・worktreeキー・ブランチ名・ログキーの一貫性を保証するため、
// scripts/shared/worker-factory.js の buildNormalWorkerLaunchSpec に一元化する。
// これにより「識別子がファイルごとに別々に手書きされる」不具合パターンを防ぐ。
const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
let spec;
try {
  spec = buildNormalWorkerLaunchSpec({ skill, issue, description, repo, workspace });
} catch (e) {
  fail(`起動仕様の生成に失敗しました: ${e.message}`);
}
const workerName   = spec.workerName;
const worktreeDir  = spec.worktreeDir;
const logPath      = spec.logPath;

// --- 移行安全策: 旧形式（issue-<issue>-<description>、role無し）のワーカー重複チェック ---
// Phase 3 で workerName 形式が issue-<issue>-<role>-<description> に変わった。
// 更新前に旧形式で起動され生存中のワーカーは、新しい lease キーと照合されないため
// 重複起動を許してしまう。旧形式の lease と workers.json も確認して防ぐ。
// このチェックは旧形式が不要になった時点で削除できる（移行期間限定）。
{
  const oldKey = `issue-${issue}-${description}`;
  if (oldKey !== workerName) {
    // 旧形式 lease チェック（Phase 2 以降のワーカーは全員 lease を持つ）
    const leaseStoreForCheck = createNormalWorkerStore(workspace);
    const oldLease = leaseStoreForCheck.read(oldKey);
    if (oldLease && isLeaseLive(oldLease)) {
      fail(
        `旧形式（role無し）のワーカー "${oldKey}" が既に稼働中です（pid ${oldLease.pid}）。` +
        `このワーカーを停止してから再試行してください。` +
        `識別子形式が issue-<issue>-<role>-<description> へ変更されたための移行措置です。`
      );
    }
    // 旧形式 workers.json チェック（Phase 2 以前の lease 非保持ワーカー向け）
    if (existsSync(workersJson)) {
      try {
        const parsed = JSON.parse(readFileSync(workersJson, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && parsed[oldKey]) {
          const oldEntry = normalizeWorkerEntry(parsed[oldKey]);
          if (isWorkerAlive(oldEntry)) {
            fail(
              `旧形式（role無し）のワーカー "${oldKey}" が workers.json に登録され生存中です（pid ${oldEntry.pid}）。` +
              `このワーカーを停止してから再試行してください。`
            );
          }
        }
      } catch { /* workers.json が読めなければスキップ（後続の本処理で改めて読む） */ }
    }
  }
}

// --- リース獲得（重複起動防止。Phase 2: 通常ワーカーのみ） ---
// lease獲得はworktreeの除去・再作成より先に行う。
// live lease（生存中のワーカー）があれば起動を明示的に拒否する。
// stale leaseの場合だけ回収して起動を継続する。
// workers.json（resume台帳）とは責務を分離。
const leaseStore = createNormalWorkerStore(workspace);
let leaseAcquired = false;
try {
  const leaseResult = acquireWorkerLease(leaseStore, workerName, {
    pid: process.pid,
    startTime: null,
    workerName,
  });
  leaseAcquired = true;
  if (leaseResult.staleReclaimed) {
    console.warn(`spawn-worker: stale lease を回収しました: "${workerName}"`);
  }
} catch (e) {
  fail(`起動を拒否しました: ${e.message}`);
}

// 以降の fail 呼び出しではリースも解放する
const _originalFail = fail;
fail = (msg) => {
  if (leaseAcquired) {
    try { releaseWorkerLease(leaseStore, workerName, { pid: process.pid }); } catch {}
  }
  _originalFail(msg);
};

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
  // orchestrator エントリ自体はワーカー走査時に一律スキップされる予約キー。
  // WezTerm脱却によりペインIDを持たなくなったため、存在だけを保持する。
  workers.orchestrator = { agentId: null };
}

// --- 生存確認: 死んだワーカーのエントリをworkers.jsonから除去 ---
{
  let dirty = false;
  for (const [k, v] of Object.entries(workers)) {
    if (k === 'orchestrator') continue;
    const entry = normalizeWorkerEntry(v);
    if (!shouldPruneStaleWorker(entry, (id) => resolveAgentConfig(id, { workspace, homedir }))) continue;

    console.warn(`spawn-worker: stale worker "${k}" (pid ${entry.pid ?? '-'}) を workers.json から除去します`);
    delete workers[k];
    dirty = true;
  }
  if (dirty) writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
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

// スキル本文の受け渡しは、全エージェント共通でinstall.js（skill_files_install_destination_directory）
// による事前インストール済みコピーをエージェント自身のネイティブなスキル発見機構に読ませる方式に統一する。
// reasonixもこの一覧に含まれ（skills/agents.yaml参照）、ワーカー起動のたびにworktreeへ
// スキル文書を書き出す専用処理は持たない（過去、reasonixだけAGENTS.mdへ手動合成しており
// --prompt-file/--short-promptの内容が届かないバグの温床だった）。

const shortPrompt = `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。詳細は ${toUnix(promptFile)} を参照してください。`;

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

// --- headless 起動（画面を使わず、標準出力は専用ログファイルへ直接リダイレクト） ---
// 全エージェントをログインシェル経由にラップする（scripts/shared/headless-launch.js に集約）。
// これにより PATH 実行ファイル・pwsh 関数・エイリアスのすべてが起動可能になる。
// argv の完全性は各プラットフォームのエンコード方式で保証される（agent-exec.js 参照）。
//
let launched;
let execution;
try {
  if (executionId) {
    execution = startExecution(workspace, { executionId, issue, workerName, skill });
    if (execution.status === 'completed') {
      fail(`実行 "${executionId}" は既に完了しています（${execution.commentUrl}）。同じ成果物は再投稿しません`);
    }
  }
  launched = launchAgentHeadless({
    argv: agentCmdArgs,
    cwd: worktreeDir,
    logPath,
    // ワーカー識別を「環境の事実」として渡す。msg-send.js はこれを見て自分がワーカーだと判定し、
    // 送信元を自動確定して orchestrator 専用の宛先指定機構（--skill）を拒否する（成りすまし・誤配送の防止）。
    env: { GH_MAESTRO_WORKER: workerName, GH_MAESTRO_WORKSPACE: workspace },
    // 全ワーカーに終了フックを付ける。非ゼロ終了（起動失敗・クラッシュ）を orchestrator へ通知し、
    // サイレント失敗（orchestratorが人間に言われるまで気づけない）を潰す。executionId が無い
    // ワーカーは空文字を渡す（execution記録はスキップされ、異常終了通知だけが働く）。
    onExit: {
      command: process.execPath,
      args: [resolve(__dirname, 'worker-exit-hook.js'), workspace, executionId ?? ''],
    },
  });
} catch (e) {
  if (executionId) {
    try { markLaunchFailure(workspace, executionId, e.message); } catch (_) {}
  }
  rollbackWorktree();
  fail(e.message);
}

// --- リースを実際のワーカーPIDでアクティベート ---
// 予約リース（launcher PID）を実際のワーカープロセス情報に更新する。
try {
  activateWorkerLease(leaseStore, workerName, { pid: launched.pid, startTime: launched.startTime });
} catch (e) {
  console.warn(`spawn-worker: リースアクティベートに失敗しました: ${e.message}`);
  // ワーカー本体は起動済みのためロールバックしない（リースは予約状態のまま残るが、
  // launcher終了後にstale判定されるため次回起動時に回収される）。
}

// --- workers.json にワーカーを登録（失敗時はプロセスもロールバック） ---
try {
  workers[workerName] = normalizeWorkerEntry({
    pid: launched.pid,
    startTime: launched.startTime,
    logPath: launched.logPath,
    agentId: agentConfig.id,
    issue,
    skill,
  });
  writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
  console.warn(`spawn-worker: worker "${workerName}" を pid ${launched.pid} として workers.json に登録しました`);
  console.warn(`spawn-worker: 実行ログ: ${launched.logPath}`);
} catch (e) {
  // 登録できなかったワーカーは誰からも追跡・終了できなくなるため、プロセスごと落とす。
  // 中継シム配下にログインシェルとエージェント本体がぶら下がるのでツリー全体を対象にする。
  try { killProcessTree(launched.pid); } catch (_) {}
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
