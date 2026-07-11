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
// resolveAgentConfig と config.js（cmdStatusの警告表示）の両方から参照する単一のSSOT。
const EXEC_SENSITIVE_FIELDS = ['command', 'extraArgs', 'execArgs'];

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

  // 1. デフォルトからベースを探す
  const defaultAgent = defaults.agents.find(a => a.id === agentId) || null;

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
  if (merged) {
    merged = resolveDynamicCommand(merged);
  }

  const hasGlobal = Object.keys(globalOverride).length > 0;
  const hasWorkspace = Object.keys(workspaceOverride).length > 0;

  if (hasGlobal || hasWorkspace) {
    if (hasGlobal) {
      merged = mergeAgentConfig(merged, globalOverride);
    }
    if (hasWorkspace) {
      merged = mergeAgentConfig(merged, workspaceOverride);
    }
  }

  // 解決結果が起動可能な設定を持っているか検証
  if (!isValidAgentConfig(merged)) return null;

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

/**
 * Review Managerの実行を可視ペインで行うかどうかを解決する。
 * 解決順序: workspace/.gh-maestro/config.json > ~/.gh-maestro/config.json > false（既定）。
 * 非boolean値は無視する（fail-closed: 誤設定で意図せず可視化されないようにする）。
 *
 * @param {object} [opts={}]
 * @param {string} [opts.workspace]
 * @param {string} [opts.homedir]
 * @returns {boolean}
 */
function resolveReviewManagerVisible(opts = {}) {
  const homedir = opts.homedir || process.env.HOME || process.env.USERPROFILE || '';

  const globalConfig = loadConfigFile(resolve(homedir, '.gh-maestro', 'config.json'));
  if (opts.workspace) {
    const wsConfig = loadConfigFile(resolve(opts.workspace, '.gh-maestro', 'config.json'));
    if (typeof wsConfig.reviewManagerVisible === 'boolean') {
      return wsConfig.reviewManagerVisible;
    }
  }
  if (typeof globalConfig.reviewManagerVisible === 'boolean') {
    return globalConfig.reviewManagerVisible;
  }
  return false;
}

module.exports = {
  resolveAgentConfig,
  resolveSkillAgentMap,
  resolveReviewManagerVisible,
  loadDefaults,
  isValidAgentConfig,
  EXEC_SENSITIVE_FIELDS,
};
