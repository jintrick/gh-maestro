'use strict';
// resolve-config.js
// エージェント設定のSSOTローダー。
//
// 解決順序（一方向に固定）:
//   workspace/.gh-maestro/config.json > ~/.gh-maestro/config.json > agent-defaults.json
//
// エージェントIDの選択（--agent フラグ > skillAgentMap > フォールバック 'agy'）は
// 呼び出し元（spawn-worker.js）の責務。このモジュールは与えられた agentId の設定を
// 上記順序でマージして返すことだけを行う。
//
// agent-defaults.json は常にこのファイルの ../agent-defaults.json に同居する。
// リポジトリ実行時: scripts/shared/ → scripts/agent-defaults.json
// インストール先実行時: ~/.gh-maestro/scripts/shared/ → ~/.gh-maestro/scripts/agent-defaults.json
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { existsSync, readFileSync } = require('fs');
const { resolve, join } = require('path');

const { isPlainObject } = require('./object');

// workspace/.gh-maestro/config.json からの上書きを許さない実行系フィールド。
// command/extraArgs に加え、execArgs も同じ扱いとする（PR #103 Review Manager指摘:
// execArgsだけ除外対象から漏れると、workspace configで--sandbox/--skip-git-repo-check等の
// 安全設定を欠いたコマンドラインに差し替えられてしまう）。
// extendsも同じ扱いが必要: workspace configがextendsで既存エージェント（claude等）の
// command/extraArgsを丸ごと引き込めてしまうと、上記の個別フィールド除外が意味を成さなくなる。
// resolveAgentConfig と config.js（cmdStatusの警告表示）の両方から参照する単一のSSOT。
const EXEC_SENSITIVE_FIELDS = ['command', 'extraArgs', 'execArgs', 'execPromptDelivery', 'execPromptFlag', 'resumeCommand', 'extends'];

// ── デフォルト読み込み ──────────────────────────────────────────────────────

const DEFAULTS_PATH = resolve(__dirname, '..', 'agent-defaults.json');

function loadDefaults() {
  return JSON.parse(readFileSync(DEFAULTS_PATH, 'utf8'));
}

// ── config.json 読み込み ────────────────────────────────────────────────────

/**
 * config.json を読み込む。存在しない／パース失敗時は空オブジェクトを返す。
 * @param {string} configPath
 * @returns {object}
 */
function loadConfigFile(configPath) {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (isPlainObject(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

// ── reasonix 動的コマンド解決 ──────────────────────────────────────────────

/**
 * reasonix のコマンドを動的解決する。
 *
 * npm root -g でグローバルインストールパスを取得し、reasonix.js が存在すれば
 * node + 絶対パスで起動する（shell wrapper が無い環境でも直接起動できる）。
 * 見つからなければ reasonix コマンドにフォールバック。
 *
 * この解決は install 時ではなくローダー呼び出し時に行う（Issue #41 設計）。
 *
 * @returns {{ command: string, prependArgs: string[] } | null}
 */
function resolveReasonixCommand() {
  try {
    const { execSync } = require('child_process');
    const npmRoot = execSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (!npmRoot) return null;
    const rxJsPath = join(npmRoot, 'reasonix', 'bin', 'reasonix.js');
    if (existsSync(rxJsPath)) {
      return { command: 'node', prependArgs: [rxJsPath] };
    }
  } catch {
    // npm root -g 失敗時はフォールバック
  }
  return null;
}

/**
 * dynamicCommand を持つエージェントのコマンドを解決する。
 * agent-defaults.json を直接変更せず、解決時に動的に command / extraArgs を置き換える。
 *
 * @param {object} agent - agent-defaults.json のエージェントエントリ
 * @returns {object} 解決済みエージェント（コピー）
 */
function resolveDynamicCommand(agent) {
  if (!agent.dynamicCommand) return agent;

  // 現時点では reasonix の npm-reasonix パターンのみ。
  // 将来的に他の動的解決パターンが出た場合はここに分岐を追加する。
  const resolved = resolveReasonixCommand();
  if (resolved) {
    return {
      ...agent,
      command: resolved.command,
      extraArgs: [...resolved.prependArgs, ...(agent.extraArgs || [])],
      execArgs: agent.execArgs ? [...resolved.prependArgs, ...agent.execArgs] : agent.execArgs,
    };
  }
  // 動的解決が失敗しても、元の command でフォールバックする
  return agent;
}

// ── 設定マージ ──────────────────────────────────────────────────────────────

/**
 * エージェント設定をマージする。
 * base（デフォルト）に override（config.json）を上書きする。
 * 配列フィールド（extraArgs 等）は override 側が完全に置き換える。
 * base が null の場合は override だけで新しいエージェントを作る。
 *
 * @param {object|null} base      デフォルトのエージェント設定、または null
 * @param {object}      override  config.json の差分
 * @returns {object} マージ済み設定
 */
function mergeAgentConfig(base, override) {
  if (!override || Object.keys(override).length === 0) return base;
  const result = base ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * "extends" フィールドを再帰的に解決する。
 *
 * claude-ds / claude-ds-pro が claude と、codex-pro が codex と実質的に同一設定
 * （command以外の全フィールド）であるように、「4種のCLIランタイム（claude/codex/agy/
 * reasonix）以外は、既存エージェントのモデル違いのラッパーに過ぎない」という運用上の
 * 実態に、設定の重複無しで対応するための機構。agent-defaults.json自身のエントリにも、
 * config.json（グローバルのみ。ワークスペースはEXEC_SENSITIVE_FIELDSで除外）で定義する
 * カスタムエージェントにも使える。
 *
 * @param {object} entry        extends を含みうるエントリ（agent-defaults.json の要素、
 *                               またはconfig.json の agents[id] オーバーライド）
 * @param {object[]} agentsArray  extends先を探す agent-defaults.json の agents 配列
 * @param {Set<string>} [seen]  循環参照検出用（呼び出し元は指定不要）
 * @returns {object} extends を解決・除去した結果
 */
function resolveExtends(entry, agentsArray, seen = new Set()) {
  if (!entry || !entry.extends) return entry;

  const baseId = entry.extends;
  const { extends: _drop, ...rest } = entry;

  if (seen.has(baseId)) {
    // 循環参照（フェイルクローズ: 無限再帰を避け、extends無しの不完全な状態を返す。
    // 不完全な結果は呼び出し元の isValidAgentConfig / validateAgentDefaults が検出する）。
    return rest;
  }

  const base = Array.isArray(agentsArray) ? agentsArray.find(a => a && a.id === baseId) : null;
  const resolvedBase = base ? resolveExtends(base, agentsArray, new Set([...seen, baseId])) : null;

  return mergeAgentConfig(resolvedBase, rest);
}

/**
 * 解決済みエージェント設定が起動に必要な最小フィールドを持っているか検証する。
 * config.json のみで定義されたカスタムエージェントが不完全な状態で使われるのを防ぐ。
 *
 * @param {object} agent  解決済みエージェント設定
 * @returns {boolean} 有効なら true
 */
function isValidAgentConfig(agent) {
  if (!agent || typeof agent !== 'object') return false;
  // command と promptDelivery が無いと起動できない
  if (typeof agent.command !== 'string' || agent.command.length === 0) return false;
  if (typeof agent.promptDelivery !== 'string' || agent.promptDelivery.length === 0) return false;
  return true;
}

// ── 公開API ─────────────────────────────────────────────────────────────────

/**
 * 指定された agentId の設定を解決順序でマージして返す。
 *
 * マージ挙動には非対称性がある: 通常のフィールド（`command`・`enterSequence`等）の
 * オーバーライドは既存設定に対する**フィールド単位のマージ**だが、オーバーライドが
 * `extends: "<baseId>"` を持つ場合は、そのagentIdの既存デフォルトの有無に関わらず、
 * extends解決結果を新しいbaseとした**総入れ替え**になる（既存デフォルト固有の
 * フィールドは暗黙に失われる）。組み込みのagentId（例: "codex"）を`extends`付きで
 * 上書きする場合も同じ規則が適用される。
 *
 * @param {string} agentId        エージェントID
 * @param {object} [opts={}]
 * @param {string} [opts.workspace]  ワークスペース絶対パス
 * @param {string} [opts.homedir]    ホームディレクトリ（省略時: HOME/USERPROFILE env）
 * @returns {object|null} 解決済みエージェント設定。agentId が defaults にも config にも無ければ null。
 */
function resolveAgentConfig(agentId, opts = {}) {
  if (!agentId) return null;

  const homedir = opts.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const defaults = loadDefaults();

  // 1. デフォルトからベースを探す（extends があれば解決する）
  const rawDefaultAgent = defaults.agents.find(a => a.id === agentId) || null;
  const defaultAgent = rawDefaultAgent ? resolveExtends(rawDefaultAgent, defaults.agents) : null;

  // 2. ~/.gh-maestro/config.json の agents セクション
  const globalConfig = loadConfigFile(resolve(homedir, '.gh-maestro', 'config.json'));
  const globalOverride = (globalConfig.agents && globalConfig.agents[agentId]) || {};

  // 3. workspace/.gh-maestro/config.json の agents セクション
  // セキュリティ: workspace config は実行コマンド（EXEC_SENSITIVE_FIELDS）を上書きできない。
  // 悪意あるリポジトリを clone しただけで任意コマンド実行されるのを防ぐ。
  // execArgs は run-review-manager.js のような exec 系起動（--sandbox / --skip-git-repo-check 等の
  // 安全設定を含む）で command/extraArgs の代わりに使われるため、同じ扱いが必要
  // （execArgsだけ上書き可能だとサンドボックス設定を欠いた危険なコマンドラインに差し替えられる。PR #103 Review Manager指摘）。
  // 実行系フィールドの上書きは ~/.gh-maestro/config.json（ユーザーが明示的に編集したもの）のみ許可。
  let workspaceOverride = {};
  if (opts.workspace) {
    const wsConfig = loadConfigFile(resolve(opts.workspace, '.gh-maestro', 'config.json'));
    const rawWsOverride = (wsConfig.agents && wsConfig.agents[agentId]) || {};
    workspaceOverride = { ...rawWsOverride };
    for (const field of EXEC_SENSITIVE_FIELDS) delete workspaceOverride[field];
  }

  // マージ: default → global → workspace（後勝ち）
  // defaultAgent が無くても config.json だけで定義されたカスタムエージェントを解決できる。
  let merged = defaultAgent;

  // dynamicCommand 解決はオーバーライドマージの後に行う（Issue #124）。
  // ユーザーが config.json で extraArgs を上書きすると配列ごと置換されてしまうため、
  // 先に解決すると動的解決で付与したスクリプトパスが消えてしまう。
  // マージ後に解決することで、override 後の extraArgs にスクリプトパスを付与できる。
  const hasGlobal = Object.keys(globalOverride).length > 0;
  const hasWorkspace = Object.keys(workspaceOverride).length > 0;

  // override 自身が extends を持つ場合（config.json だけで定義するカスタムエージェント。
  // 例: codex-terra が codex を extends する）、defaultAgent の有無に関わらず
  // extends解決結果を新しいbaseとして使う（通常のフィールド単位マージではなく総入れ替え）。
  if (hasGlobal || hasWorkspace) {
    if (hasGlobal) {
      merged = globalOverride.extends
        ? resolveExtends(globalOverride, defaults.agents)
        : mergeAgentConfig(merged, globalOverride);
    }
    if (hasWorkspace) {
      merged = workspaceOverride.extends
        ? resolveExtends(workspaceOverride, defaults.agents)
        : mergeAgentConfig(merged, workspaceOverride);
    }
  }

  // ユーザーが global config で command を明示的に上書きしている場合は
  // dynamicCommand 解決をスキップする（PR #129 レビュー指摘）。
  // ユーザー指定の command（カスタムラッパー等）が動的解決で上書きされるのを防ぐ。
  const userOverrodeCommand = hasGlobal && globalOverride.command !== undefined;
  if (merged && !userOverrodeCommand) {
    merged = resolveDynamicCommand(merged);
  }

  // 解決結果が起動可能な設定を持っているか検証
  if (!isValidAgentConfig(merged)) return null;

  // id は常に呼び出し元が要求した agentId に固定する。extends 解決結果は継承元の id
  // （例: codex-terra が codex を extends した場合の "codex"）を引きずっているため、
  // ここで上書きしないと workers.json に誤った agentId が記録され、resumeで別の
  // エージェント（継承元そのもの）を起動してしまう（spawn-worker.js の
  // `agentId: agentConfig.id` 経由）。
  merged.id = agentId;

  return merged;
}

/**
 * skillAgentMap を解決順序でマージして返す。
 *
 * @param {object} [opts={}]
 * @param {string} [opts.workspace]
 * @param {string} [opts.homedir]
 * @returns {object} マージ済み skillAgentMap
 */
function resolveSkillAgentMap(opts = {}) {
  const homedir = opts.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const defaults = loadDefaults();

  let map = { ...defaults.skillAgentMap };

  const globalConfig = loadConfigFile(resolve(homedir, '.gh-maestro', 'config.json'));
  if (globalConfig.skillAgentMap) {
    Object.assign(map, globalConfig.skillAgentMap);
  }

  if (opts.workspace) {
    const wsConfig = loadConfigFile(resolve(opts.workspace, '.gh-maestro', 'config.json'));
    if (wsConfig.skillAgentMap) {
      Object.assign(map, wsConfig.skillAgentMap);
    }
  }

  return map;
}

module.exports = {
  resolveAgentConfig,
  resolveSkillAgentMap,
  resolveExtends,
  loadDefaults,
  isValidAgentConfig,
  EXEC_SENSITIVE_FIELDS,
};
