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
// nonInteractiveTokensも同じ扱い（Issue #163 Review Manager指摘）: 単なる宣言フィールドでは
// なく安全ガードそのものであり、workspace config（信頼できないclone元からの入力として扱う）
// が agents.<id>.nonInteractiveTokens: [] を指定するだけで、グローバル設定側の
// extraArgs/execArgs 欠落検出を無効化できてしまう。カスタムエージェントで宣言したい場合は
// ~/.gh-maestro/config.json（グローバル・信頼された設定）でのみ可能。
// resolveAgentConfig と config.js（cmdStatusの警告表示）の両方から参照する単一のSSOT。
const EXEC_SENSITIVE_FIELDS = ['command', 'extraArgs', 'execArgs', 'execPromptDelivery', 'execPromptFlag', 'resumeCommand', 'extends', 'nonInteractiveTokens'];

// テスト宣言は agent 設定とは別のセクションで解決する。agent 設定の command 等を
// workspace 段から除去する既存の境界を変更せず、テスト宣言については組み込み既定値、
// global、workspace の順に明示的にマージする。
const TEST_SCOPES = new Set(['full', 'partial']);
const TEST_LAYER_NAME_RE = /^[^\x00-\x1f/\\]+$/;
const TEST_MAPPING_PLACEHOLDER = '<name>';

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

/**
 * テスト層解決用に config.json の読み込み結果を保持する。
 *
 * agent 設定の既存ローダーは、壊れた config.json を空設定として扱う契約を
 * 持つため変更しない。テスト層宣言は未宣言と不正設定を区別する必要があるため、
 * この経路だけは JSON 構文とトップレベル型の失敗を呼び出し元へ返す。
 * @param {string} configPath
 * @returns {{ok:true,config:object}|{ok:false,error:string}}
 */
function loadTestConfigFile(configPath) {
  if (!existsSync(configPath)) return { ok: true, config: {} };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      return { ok: false, error: 'config.json must be a JSON object' };
    }
    return { ok: true, config: parsed };
  } catch (error) {
    return { ok: false, error: `config.json could not be parsed: ${error.message}` };
  }
}

function isSafeTestLayerName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && value !== '__proto__'
    && value !== 'constructor'
    && value !== 'prototype'
    && TEST_LAYER_NAME_RE.test(value);
}

function validateTestArgv(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((arg) => (
    typeof arg !== 'string' || arg.includes('\0')
  ))) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  if (!value[0].trim()) return { ok: false, error: `${field}[0] must be a non-empty executable` };
  return { ok: true, value: [...value] };
}

function validateTestFileArgs(value) {
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return { ok: false, error: 'test layer fileArgs must be an array of strings' };
  }
  return { ok: true, value: [...value] };
}

function validateTestFilePatterns(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'test layer defaultTestFiles must be an array' };
  }
  const patterns = [];
  for (const pattern of value) {
    const validated = validateTestPathPattern(pattern, 'test layer defaultTestFiles');
    if (!validated.ok) return validated;
    patterns.push(validated.value);
  }
  return { ok: true, value: patterns };
}

function validateTestPathPattern(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[\r\n]/.test(value)) {
    return { ok: false, error: `${field} must be a non-empty relative path pattern` };
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return { ok: false, error: `${field} must be relative to the worktree` };
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !segment)) {
    return { ok: false, error: `${field} must not contain empty or traversal path segments` };
  }
  const placeholders = normalized.split(TEST_MAPPING_PLACEHOLDER).length - 1;
  if (placeholders > 1) return { ok: false, error: `${field} may contain at most one ${TEST_MAPPING_PLACEHOLDER} placeholder` };
  return { ok: true, value: normalized };
}

function validateTestMapping(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'test layer mapping must be an array' };
  const mapping = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return { ok: false, error: 'test layer mapping entries must be objects' };
    const changed = validateTestPathPattern(entry.changed, 'test layer mapping.changed');
    if (!changed.ok) return changed;
    const test = validateTestPathPattern(entry.test, 'test layer mapping.test');
    if (!test.ok) return test;
    mapping.push({ changed: changed.value, test: test.value });
  }
  return { ok: true, value: mapping };
}

/**
 * テスト層の設定片を検証する。ここではカスケード途中の層も扱うため command は
 * 必須にしないが、指定された command/fileArgs は常に argv 配列として検証する。
 * @param {unknown} raw
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateTestLayerOverride(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'test layer must be a JSON object' };
  const value = {};

  if (raw.shell !== undefined) {
    return { ok: false, error: 'test layer shell execution is not supported; use an argv command' };
  }

  if (raw.scope !== undefined) {
    if (typeof raw.scope !== 'string' || !TEST_SCOPES.has(raw.scope)) {
      return { ok: false, error: 'test layer scope must be full or partial' };
    }
    value.scope = raw.scope;
  }
  if (raw.command !== undefined) {
    const command = validateTestArgv(raw.command, 'test layer command');
    if (!command.ok) return command;
    value.command = command.value;
  }
  if (raw.fileArgs !== undefined) {
    const fileArgs = validateTestFileArgs(raw.fileArgs);
    if (!fileArgs.ok) return fileArgs;
    value.fileArgs = fileArgs.value;
  }
  if (raw.defaultTestFiles !== undefined) {
    const defaultTestFiles = validateTestFilePatterns(raw.defaultTestFiles);
    if (!defaultTestFiles.ok) return defaultTestFiles;
    value.defaultTestFiles = defaultTestFiles.value;
  }
  if (raw.testFilePattern !== undefined) {
    const testFilePattern = validateTestPathPattern(raw.testFilePattern, 'test layer testFilePattern');
    if (!testFilePattern.ok) return testFilePattern;
    value.testFilePattern = testFilePattern.value;
  }
  if (raw.displayCommand !== undefined) {
    if (typeof raw.displayCommand !== 'string' || !raw.displayCommand.trim()
        || raw.displayCommand.includes('\0') || /[\r\n]/.test(raw.displayCommand)) {
      return { ok: false, error: 'test layer displayCommand must be a non-empty string' };
    }
    value.displayCommand = raw.displayCommand;
  }
  if (raw.mapping !== undefined) {
    const mapping = validateTestMapping(raw.mapping);
    if (!mapping.ok) return mapping;
    value.mapping = mapping.value;
  }

  return { ok: true, value };
}

function readTestLayers(config) {
  if (!Object.prototype.hasOwnProperty.call(config, 'test')) return { ok: true, defined: false };
  if (!isPlainObject(config.test)) return { ok: false, error: 'test config must be a JSON object' };
  if (!Object.prototype.hasOwnProperty.call(config.test, 'layers')) return { ok: true, defined: false };
  if (!isPlainObject(config.test.layers)) return { ok: false, error: 'test.layers must be a JSON object' };
  return { ok: true, defined: true, layers: config.test.layers };
}

function mergeTestLayerOverrides(base, overrides) {
  const result = { ...base };
  for (const [layerName, rawLayer] of Object.entries(overrides)) {
    if (!isSafeTestLayerName(layerName)) {
      return { ok: false, error: `invalid test layer name: ${layerName}` };
    }
    const layer = validateTestLayerOverride(rawLayer);
    if (!layer.ok) return layer;
    result[layerName] = {
      ...(result[layerName] || {}),
      ...layer.value,
    };
  }
  return { ok: true, value: result };
}

function createBuiltinTestConfig() {
  return {
    source: 'builtin',
    layers: {
      full: {
        scope: 'full',
        command: [process.execPath, '--require', './tests/_env-setup.js', '--test'],
        defaultTestFiles: ['tests/*.test.js'],
        displayCommand: 'npm test',
      },
      slow: {
        scope: 'partial',
        command: [process.execPath, '--require', './tests/_env-setup.js', '--test'],
        defaultTestFiles: ['tests/slow/*.test.js'],
        testFilePattern: 'tests/slow/<name>.test.js',
        displayCommand: 'npm run test:slow',
        mapping: [{ changed: 'scripts/<name>.js', test: 'tests/slow/<name>.test.js' }],
      },
    },
  };
}

function validateResolvedTestLayers(layers) {
  if (!isPlainObject(layers) || Object.keys(layers).length === 0) {
    return { ok: false, error: 'test.layers must contain at least one layer' };
  }
  const resolved = {};
  for (const [layerName, rawLayer] of Object.entries(layers)) {
    if (!isSafeTestLayerName(layerName)) return { ok: false, error: `invalid test layer name: ${layerName}` };
    const layer = validateTestLayerOverride(rawLayer);
    if (!layer.ok) return layer;
    if (!layer.value.command) return { ok: false, error: `test layer command is required: ${layerName}` };
    resolved[layerName] = {
      scope: layer.value.scope || 'full',
      ...layer.value,
    };
  }
  return { ok: true, value: resolved };
}

/**
 * テスト宣言を組み込み既定値 → global → workspace の順で解決する。
 * `test.layers` が最初に現れた時点で、プロジェクトが宣言した層集合を使う。
 * これにより、分離側を宣言しないプロジェクトへ gh-maestro 固有の slow 層を推測して
 * 追加しない。後段の config は同名層のフィールドを上書きできる。
 *
 * @param {object} [opts]
 * @param {string} [opts.workspace]
 * @param {string} [opts.homedir]
 * @returns {{source:'builtin'|'declared', layers:object}|null}
 */
function resolveTestConfig(opts = {}) {
  const homedir = opts.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const builtin = createBuiltinTestConfig();
  let layers = builtin.layers;
  let declared = false;

  const configs = [
    loadConfigFile(resolve(homedir, '.gh-maestro', 'config.json')),
    opts.workspace ? loadConfigFile(resolve(opts.workspace, '.gh-maestro', 'config.json')) : {},
  ];

  for (const config of configs) {
    const read = readTestLayers(config);
    if (!read.ok) return null;
    if (!read.defined) continue;
    if (!declared) {
      // 最初の宣言が既定層の一部を上書きする場合は、その同名層の未指定フィールドを
      // 既定値から継承する。一方、宣言されなかった既定層（例: 外部プロジェクトが
      // every だけ宣言した場合の gh-maestro 固有 slow）は持ち込まない。
      layers = Object.fromEntries(Object.keys(read.layers)
        .filter(layerName => Object.prototype.hasOwnProperty.call(builtin.layers, layerName))
        .map(layerName => [layerName, builtin.layers[layerName]]));
      declared = true;
    }
    const merged = mergeTestLayerOverrides(layers, read.layers);
    if (!merged.ok) return null;
    layers = merged.value;
  }

  const validated = validateResolvedTestLayers(layers);
  if (!validated.ok) return null;
  return {
    source: declared ? 'declared' : 'builtin',
    layers: validated.value,
  };
}

/**
 * テスト層宣言の有無を、resolveTestConfig() のカスケード結果から判定する。
 *
 * `missing` は組み込み既定値だけが使われている状態であり、対象プロジェクトが
 * test.layers を宣言していないことを表す。`invalid` は宣言の読み取り・マージ・
 * 検証に失敗した状態で、呼び出し元はセッション初期化を止めずに人間へ知らせる。
 * @param {object} [opts]
 * @returns {'declared'|'missing'|'invalid'}
 */
function getTestLayerDeclarationStatus(opts = {}) {
  try {
    const homedir = opts.homedir || process.env.HOME || process.env.USERPROFILE || '';
    const configPaths = [resolve(homedir, '.gh-maestro', 'config.json')];
    if (opts.workspace) configPaths.push(resolve(opts.workspace, '.gh-maestro', 'config.json'));
    if (configPaths.some(configPath => !loadTestConfigFile(configPath).ok)) return 'invalid';

    const resolved = resolveTestConfig(opts);
    if (!resolved) return 'invalid';
    return resolved.source === 'declared' ? 'declared' : 'missing';
  } catch {
    return 'invalid';
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
 * base が null の場合は override だけで新しいエージェントを作る。
 *
 * 配列フィールドの扱いはモードで分かれる（Issue #235）:
 * - 既定（appendArrays=false）: 配列フィールド（extraArgs 等）は override 側が完全に置き換える。
 *   非extendsの通常上書き経路（global/workspace override）はこのモード。
 * - appendArrays=true: 対象の配列フィールド（APPEND_ARRAY_FIELDS: extraArgs / execArgs /
 *   nonInteractiveTokens）は base の配列内容の末尾に override の内容を連結する
 *   （継承元の内容が失われない）。extends 解決（resolveExtends）専用のモード。
 *   resumeCommand は対象外（従来どおり完全置換。末尾要素をセッション参照で置換する
 *   createSessionResumeAdapter.resume() の契約と整合させるため。PR #236 レビュー指摘）。
 *   配列でない値は従来どおり置換する（不正値の扱いを変えない）。
 *
 * @param {object|null} base      デフォルトのエージェント設定、または null
 * @param {object}      override  config.json の差分
 * @param {object}      [opts]
 * @param {boolean}     [opts.appendArrays=false]  true なら APPEND_ARRAY_FIELDS の配列を末尾に連結
 * @returns {object} マージ済み設定
 */
// extends 解決で追記される配列フィールド（Issue #235）。
// extraArgs / execArgs は起動時の引数列で、継承元の内容を失わずに積み増すのが自然。
// nonInteractiveTokens は順序に意味のないトークン集合であり、消費者
// （validateNonInteractiveTokens 等）は集合メンバーシップ検証しか行わないため、
// 追記しても継承元トークンの欠落を防ぐ方向にしか働かない（fail-closed 方向で安全）。
// resumeCommand は対象外（従来どおり完全置換）。createSessionResumeAdapter.resume() が
// resumeCommand の末尾要素をセッション参照で置換する契約のため、追記すると置換対象が
// ずれて再開が壊れる（PR #236 レビュー指摘）。
const APPEND_ARRAY_FIELDS = new Set(['extraArgs', 'execArgs', 'nonInteractiveTokens']);

function mergeAgentConfig(base, override, opts = {}) {
  if (!override || Object.keys(override).length === 0) return base;
  const result = base ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (opts.appendArrays && APPEND_ARRAY_FIELDS.has(key) && Array.isArray(value)) {
      const inherited = Array.isArray(result[key]) ? result[key] : [];
      result[key] = [...inherited, ...value];
    } else {
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
 * 対象の配列フィールド（APPEND_ARRAY_FIELDS: extraArgs / execArgs / nonInteractiveTokens）は、
 * 「継承（extends）＝継承元を土台に積み増す」という意味に合わせ、継承元の配列内容に
 * 自分の内容を末尾追記する（Issue #235）。追記は appendArrays モードの mergeAgentConfig
 * で実現する。resumeCommand は追記対象外（従来どおり完全置換）。末尾要素をセッション参照で
 * 置換する createSessionResumeAdapter.resume() の契約と整合させるため（PR #236 レビュー指摘）。
 * 非extendsの通常上書き経路（global/workspace override）は従来どおり配列を
 * 完全置換する（追記/置換の非対称性）。
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

  // extends 経由のマージは配列を追記する（継承元の内容を失わない）
  return mergeAgentConfig(resolvedBase, rest, { appendArrays: true });
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

/**
 * 解決済みエージェントの起動引数が非対話化トークンを保持しているか検証する。
 *
 * agent-defaults.json の `nonInteractiveTokens`（宣言フィールド）に列挙されたトークン
 * （claude系: --print、reasonix: run、codex系: exec 等）は、headless 起動時に画面・標準入力が
 * 無い環境で対話モードに入らず1回実行で終了させるために必須。config.json の extraArgs/execArgs
 * 上書きは配列ごと置換されるため、うっかりトークンを欠落させた設定がそのまま有効化されてしまい、
 * 起動がハングしても誰にも気づけない（Issue #163）。
 *
 * この関数は「指定された引数配列がトークンを保持しているか」を直接見る。欠落検出は呼び出し元
 * （spawn-worker.js の起動ブロック・run-review-manager.js / run-review-jobs.js の起動ブロック・
 * config.js status の警告）が行う。
 *
 * @param {object} agent     解決済みエージェント設定（nonInteractiveTokens を読む）
 * @param {string[]} [argsArray]  検証対象の引数配列。省略時は agent.extraArgs。
 *   Review Manager系（run-review-manager.js / run-review-jobs.js）は
 *   agentConfig.execArgs ?? agentConfig.extraArgs を渡す。execArgs だけを対話モードになる形に
 *   上書きすると extraArgs は既定のまま残り、extraArgs だけ見る検証をすり抜けてしまうため、
 *   実際に起動に使われる配列を検証対象にしなければならない（Issue #163 Review Manager指摘）。
 * @returns {{ valid: boolean, missing: string[] }}
 *   valid: 非対話化トークンをすべて保持していれば true
 *   missing: 欠落しているトークンの配列（valid なら空）
 */
function validateNonInteractiveTokens(agent, argsArray) {
  const tokens = agent && Array.isArray(agent.nonInteractiveTokens) ? agent.nonInteractiveTokens : [];
  // 宣言フィールドが無いエージェント（agy 等。非対話性は promptFlag 選択に依存）は
  // 検証対象外として常に valid（欠落検出の誤検知を避ける）。
  if (tokens.length === 0) return { valid: true, missing: [] };
  const args = argsArray !== undefined ? argsArray : (agent && agent.extraArgs);
  // 検証対象が配列でない（undefined 等）場合はトークン保持を確認できないため、
  // 欠落として扱う（フェイルクローズ: 安全と確認できない場合は起動を止める側に倒す）。
  const argsList = Array.isArray(args) ? args : [];
  const missing = tokens.filter(token => !argsList.includes(token));
  return { valid: missing.length === 0, missing };
}

// ── 公開API ─────────────────────────────────────────────────────────────────

/**
 * 指定された agentId の設定を解決順序でマージして返す。
 *
 * マージ挙動には非対称性がある:
 * - 通常のオーバーライド（`extends` なし）: フィールド単位のマージ。配列フィールド
 *   （`extraArgs`等）は override 側が完全に置き換える。
 * - `extends: "<baseId>"` を持つオーバーライド: そのagentIdの既存デフォルトの有無に
 *   関わらず、extends解決結果を新しいbaseとした**総入れ替え**になる（既存デフォルト固有の
 *   フィールドは暗黙に失われる）。さらに、エントリ自身の配列フィールドのうち
 *   `extraArgs` / `execArgs` / `nonInteractiveTokens` は継承元の配列に**末尾追記**される
 *   （Issue #235）。`resumeCommand` は追記対象外（従来どおり完全置換）。組み込みのagentId
 *   （例: "codex"）を`extends`付きで上書きする場合も同じ規則が適用される。
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

/**
 * council（複数モデル議論）設定を解決・検証する。
 *
 * `config.json` の上位キー `council`（`agents` / `profiles` / `skillAgentMap` と並ぶ
 * 独立セクション。Issue #230）を読み、以下の両方を解決する:
 *   - `council.groups`: 参加者グループ定義。**`default` キーを必須**とし、各グループの
 *     `agents`（`resolveAgentConfig` で解決可能なエージェントID）が空配列・重複・
 *     解決不能でないことを検証する。`category` は任意。
 *   - `council.investigationAgent`: 調査ジョブに使うエージェントID。**指定されていて
 *     解決不能な場合はフェイルクローズ**。未指定（undefined）は「調査ジョブなし」として
 *     許容し null を返す（調査の要不要は orchestrator のその都度判断のため）。
 *
 * マージ順序は resolveSkillAgentMap と同じ global → workspace（後勝ち）。
 * council 設定は実行コマンドを含まないため EXEC_SENSITIVE_FIELDS の対象外。
 *
 * @param {object} [opts={}]
 * @param {string} [opts.workspace]
 * @param {string} [opts.homedir]
 * @returns {{ groups: Record<string, { agents: string[], category?: string }>, investigationAgent: string|null } | null}
 *   解決・検証に失敗した場合は null（fail-closed。呼び出し元は終了コード2等で停止する）
 */
function resolveCouncilConfig(opts = {}) {
  const homedir = opts.homedir || process.env.HOME || process.env.USERPROFILE || '';

  const globalConfig = loadConfigFile(resolve(homedir, '.gh-maestro', 'config.json'));
  const globalCouncil = isPlainObject(globalConfig.council) ? globalConfig.council : {};

  let workspaceCouncil = {};
  if (opts.workspace) {
    const wsConfig = loadConfigFile(resolve(opts.workspace, '.gh-maestro', 'config.json'));
    workspaceCouncil = isPlainObject(wsConfig.council) ? wsConfig.council : {};
  }

  // global → workspace 後勝ちのシャローコピー。
  // groups は「グループ全体の置き換え」ではなくグループキー単位でマージする
  // （workspace が定義したキーは後勝ち、global のみのキーは維持される。
  //  各グループ内の agents は配列ごと置換。ドキュメント記載のマージ契約）。
  const merged = { ...globalCouncil, ...workspaceCouncil };
  if (isPlainObject(globalCouncil.groups) && isPlainObject(workspaceCouncil.groups)) {
    merged.groups = { ...globalCouncil.groups, ...workspaceCouncil.groups };
  }

  // ── investigationAgent ──
  let investigationAgent = null;
  if (merged.investigationAgent !== undefined) {
    if (typeof merged.investigationAgent !== 'string' || merged.investigationAgent.length === 0) {
      return null;
    }
    if (!resolveAgentConfig(merged.investigationAgent, { workspace: opts.workspace, homedir })) {
      return null; // 指定されているのに解決不能 → fail-closed
    }
    investigationAgent = merged.investigationAgent;
  }

  // ── groups ──
  if (!isPlainObject(merged.groups)) {
    return null; // 未定義・不正（配列等） → fail-closed
  }
  if (!Object.prototype.hasOwnProperty.call(merged.groups, 'default')) {
    return null; // default 必須 → fail-closed
  }

  const groups = {};
  for (const [groupName, group] of Object.entries(merged.groups)) {
    if (!isPlainObject(group) || !Array.isArray(group.agents) || group.agents.length === 0) {
      return null; // 空配列・不正なグループ → fail-closed
    }
    const seen = new Set();
    const agents = [];
    for (const agentId of group.agents) {
      if (typeof agentId !== 'string' || agentId.length === 0) return null;
      if (seen.has(agentId)) return null; // 重複 → fail-closed
      seen.add(agentId);
      if (!resolveAgentConfig(agentId, { workspace: opts.workspace, homedir })) {
        return null; // 解決不能 → fail-closed
      }
      agents.push(agentId);
    }
    const category = typeof group.category === 'string' && group.category.length > 0
      ? group.category
      : undefined;
    groups[groupName] = category ? { agents, category } : { agents };
  }

  return { groups, investigationAgent };
}

module.exports = {
  resolveAgentConfig,
  resolveTestConfig,
  getTestLayerDeclarationStatus,
  createBuiltinTestConfig,
  validateTestLayerOverride,
  validateTestMapping,
  resolveSkillAgentMap,
  resolveCouncilConfig,
  resolveExtends,
  loadDefaults,
  isValidAgentConfig,
  validateNonInteractiveTokens,
  EXEC_SENSITIVE_FIELDS,
};
