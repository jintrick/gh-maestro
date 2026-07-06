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
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
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
 *
 * @param {object} base  デフォルトのエージェント設定
 * @param {object} override  config.json の差分
 * @returns {object} マージ済み設定
 */
function mergeAgentConfig(base, override) {
  if (!override || Object.keys(override).length === 0) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
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
  let workspaceOverride = {};
  if (opts.workspace) {
    const wsConfig = loadConfigFile(resolve(opts.workspace, '.gh-maestro', 'config.json'));
    workspaceOverride = (wsConfig.agents && wsConfig.agents[agentId]) || {};
  }

  // マージ: default → global → workspace（後勝ち）
  let merged = defaultAgent;
  if (merged) {
    merged = resolveDynamicCommand(merged);
    if (Object.keys(globalOverride).length > 0) {
      merged = mergeAgentConfig(merged, globalOverride);
    }
    if (Object.keys(workspaceOverride).length > 0) {
      merged = mergeAgentConfig(merged, workspaceOverride);
    }
  }

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

module.exports = { resolveAgentConfig, resolveSkillAgentMap, loadDefaults };
