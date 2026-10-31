#!/usr/bin/env node
'use strict';

// config.js
// gh-maestro agent configuration CLI.
//
// Subcommands:
//   use <profile>   Apply a named profile's skillAgentMap to ~/.gh-maestro/config.json
//   doctor          Validate config structure
//
// Profile semantics: a profile's skillAgentMap is a DIFFERENTIAL — only the skills
// to change relative to agent-defaults.json defaults. The resolver merges:
//   defaults → global skillAgentMap → workspace skillAgentMap
//
// All agent ID validation is against agent-defaults.json agents[].id plus any
// custom agents defined in config.json's agents section.
//
// This module does NOT modify resolve-config.js — it is a pure writer/reader
// of config.json, using resolve-config.js as the SSOT loader.

const fs = require('fs');
const path = require('path');

const { loadDefaults, resolveAgentConfig, resolveSkillAgentMap, resolveExtends, isValidAgentConfig, resolveCouncilConfig } = require('./shared/resolve-config');
const { isPlainObject } = require('./shared/object');

const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const CONFIG_PATH = path.resolve(HOMEDIR, '.gh-maestro', 'config.json');

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Load a JSON file. Returns parsed object, null if file doesn't exist,
 * or { _parseError: string } on parse/type failure.
 * @param {string} filePath
 * @returns {object|null}
 */
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { _parseError: '(cannot read file)' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      return parsed;
    }
    return { _parseError: 'root value is not an object' };
  } catch (e) {
    return { _parseError: e.message };
  }
}

/**
 * Write data to config.json, creating the directory if needed.
 * @param {object} data
 */
function saveConfig(data) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Collect all valid agent IDs (from defaults + config's agents section).
 * @param {object} defaults
 * @param {object|null} config
 * @returns {Set<string>}
 */
function collectValidAgentIds(defaults, config) {
  const ids = new Set();
  for (const agent of defaults.agents) {
    if (agent.id) ids.add(agent.id);
  }
  if (config && config.agents && !config._parseError) {
    for (const id of Object.keys(config.agents)) {
      ids.add(id);
    }
  }
  return ids;
}


/**
 * Find the closest matching known skill key for a given unknown key.
 * Uses longest common prefix matching.
 * Returns the closest match or null if no reasonable match.
 *
 * @param {string} key Unknown skill key
 * @param {string[]} knownKeys Array of known skill keys
 * @returns {string|null}
 */
function closestKnownSkillKey(key, knownKeys) {
  if (!knownKeys || knownKeys.length === 0) return null;

  // Calculate the common prefix shared by ALL known keys (e.g. "gh-maestro-").
  // A match that only reaches this prefix length doesn't differentiate between
  // individual skills — we need actual name-part overlap to make a suggestion.
  let commonPrefixLen = 0;
  if (knownKeys.length > 1) {
    const first = knownKeys[0];
    for (let i = 0; i < first.length; i++) {
      if (knownKeys.every(k => k[i] === first[i])) {
        commonPrefixLen = i + 1;
      } else {
        break;
      }
    }
  }

  let best = null;
  let bestLen = 0;
  for (const known of knownKeys) {
    let i = 0;
    while (i < key.length && i < known.length && key[i] === known[i]) i++;
    // Only consider matches that extend beyond the shared prefix
    // (meaning the individual skill-name portion actually matches)
    if (i > commonPrefixLen && i > bestLen) {
      bestLen = i;
      best = known;
    }
  }
  return best; // null if no match beyond the common prefix
}

/**
 * Get known skill keys from agent defaults.
 * Shared helper for cmdUse and validateConfig.
 *
 * @param {object} defaults
 * @returns {string[]}
 */
function getKnownSkillKeys(defaults) {
  return Object.keys(defaults.skillAgentMap || {});
}

/**
 * Detect skill keys not present in knownSkillKeys, each paired with a
 * "did you mean" hint string (empty string if no reasonable suggestion).
 * Shared detection+formatting helper for cmdUse and validateConfig
 * — unifies the four previously-duplicated unknown-skill-key warning loops.
 *
 * @param {string[]} skillKeys
 * @param {string[]} knownSkillKeys
 * @returns {{skill: string, hint: string}[]}
 */
function findUnknownSkillKeys(skillKeys, knownSkillKeys) {
  const unknown = [];
  for (const skill of skillKeys) {
    if (!knownSkillKeys.includes(skill)) {
      const suggestion = closestKnownSkillKey(skill, knownSkillKeys);
      unknown.push({ skill, hint: suggestion ? ` (did you mean "${suggestion}"?)` : '' });
    }
  }
  return unknown;
}

// ── subcommand: use ────────────────────────────────────────────────────────────

/**
 * Apply a named profile. Writes the profile's skillAgentMap to the top-level
 * skillAgentMap key in ~/.gh-maestro/config.json.
 *
 * @param {string} profileName
 */
function cmdUse(profileName) {
  const config = loadJSON(CONFIG_PATH) || {};

  if (config._parseError) {
    console.error(`Error: cannot parse ${CONFIG_PATH}: ${config._parseError}`);
    process.exit(1);
  }

  // 壊れた skillAgentMap を {} で上書きすると、人間が書いた設定が黙って消える。
  // 書き換えず、箇所を示して止まる（ADR 0053）。
  if (config.skillAgentMap !== undefined && !isPlainObject(config.skillAgentMap)) {
    console.error(
      `Error: skillAgentMap in ${CONFIG_PATH} is not an object ` +
      `(found ${Array.isArray(config.skillAgentMap) ? 'array' : typeof config.skillAgentMap}). ` +
      'The file was not changed. Fix it by hand, then run again.',
    );
    process.exit(1);
  }

  const profiles = config.profiles || {};
  if (!profiles[profileName]) {
    const available = Object.keys(profiles);
    console.error(`Error: profile "${profileName}" not found.`);
    if (available.length > 0) {
      console.error(`Available profiles: ${available.join(', ')}`);
    } else {
      console.error('No profiles defined in config.json.');
    }
    process.exit(1);
  }

  const profileMap = profiles[profileName].skillAgentMap;
  if (!isPlainObject(profileMap) || Object.keys(profileMap).length === 0) {
    console.error(`Error: profile "${profileName}" has no valid skillAgentMap.`);
    process.exit(1);
  }

  // Validate all agent IDs in the profile map
  const defaults = loadDefaults();
  const validAgentIds = collectValidAgentIds(defaults, config);
  const defaultAgentIds = new Set(defaults.agents.map(a => a.id));

  // Warn about unknown skill keys BEFORE agent ID validation (so the warning
  // is visible even if agent ID errors cause early exit)
  const knownSkillKeys = getKnownSkillKeys(defaults);
  for (const { skill, hint } of findUnknownSkillKeys(Object.keys(profileMap), knownSkillKeys)) {
    console.error(`[WARN] Profile "${profileName}": unknown skill key "${skill}"${hint}.`);
  }

  for (const [skill, agentId] of Object.entries(profileMap)) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      console.error(`Error: profile "${profileName}": empty agent ID for skill "${skill}".`);
      process.exit(1);
    }
    if (!validAgentIds.has(agentId)) {
      console.error(
        `Error: agent ID "${agentId}" (for skill "${skill}") not found in ` +
        'agent-defaults.json or config agents.',
      );
      process.exit(1);
    }
    // Config-only agents (not in defaults) must pass isValidAgentConfig.
    // Incomplete custom agents (missing command/promptDelivery) would cause
    // resolveAgentConfig() to return null at worker-launch time.
    // "extends" must be checked regardless of whether agentId already has a default
    // entry — resolveAgentConfig() treats an override's "extends" as a full
    // replacement of any existing default for that id, so even a built-in id
    // (e.g. "codex") re-pointed at a broken extends target would break at
    // worker-launch time despite defaultAgentIds.has(agentId) being true
    // (PR #170 review: this branch previously only checked ids absent from defaults).
    const customAgent = config.agents && config.agents[agentId];
    if (customAgent && customAgent.extends) {
      const resolved = resolveExtends(customAgent, defaults.agents);
      if (!isValidAgentConfig(resolved)) {
        console.error(
          `Error: agent "${agentId}" (for skill "${skill}") extends "${customAgent.extends}", but ` +
          'the resolved config is missing required fields (command + promptDelivery). ' +
          `"${customAgent.extends}" must exist in agent-defaults.json.`,
        );
        process.exit(1);
      }
    } else if (!defaultAgentIds.has(agentId)) {
      if (!isValidAgentConfig(customAgent)) {
        console.error(
          `Error: agent "${agentId}" (for skill "${skill}") is a custom agent ` +
          'missing required fields (command + promptDelivery).',
        );
        process.exit(1);
      }
    }
  }

  // Write: merge top-level skillAgentMap with the profile's map (stacking behavior)
  const baseMap = isPlainObject(config.skillAgentMap) ? config.skillAgentMap : {};
  config.skillAgentMap = { ...baseMap, ...profileMap };
  saveConfig(config);

  // Display result
  const maxSkillLen = Math.max(...Object.keys(profileMap).map(s => s.length), 6);
  console.log(`Profile "${profileName}" applied.\n`);
  console.log(`${'Skill'.padEnd(maxSkillLen)}  Agent`);
  console.log('-'.repeat(maxSkillLen + 8));
  for (const [skill, agentId] of Object.entries(profileMap).sort()) {
    console.log(`${skill.padEnd(maxSkillLen)}  ${agentId}`);
  }
}

// ── council 設定検証（Issue #230） ─────────────────────────────────────────────

/**
 * council 設定の「マージ前の1ファイル分」の形式検証警告を収集する。
 *
 * この関数は形式チェック（構造・型・空配列・重複・エージェントIDの解決可能性）に限定する。
 * `default` グループ必須は global + workspace をマージした結果でしか正しく判定できない
 * （global に default があり workspace が groups を追加する分割設定は、単独ファイルでは
 * false positive の ERROR になる。review指摘 #4）。マージ後の検証は validateCouncilMerged が担う。
 * エージェント解決は workspace を含めて行う（workspace のみに定義されたカスタムエージェントを
 * 誤って unknown にしない。review指摘 #5）。
 *
 * @param {string} label    'global' or 'workspace'
 * @param {*} council       config.json の council セクション
 * @param {object} [ctx]    { workspace, homedir }。エージェント解決に使うコンテクスト
 * @returns {string[]}
 */
function validateCouncilConfig(label, council, ctx = {}) {
  const issues = [];
  const agentResolveOpts = { homedir: ctx.homedir || HOMEDIR, workspace: ctx.workspace };

  // council は任意キー。未設定なら検証対象外。
  if (council === undefined) return issues;

  if (!isPlainObject(council)) {
    issues.push(`[ERROR] ${label}: council must be an object.`);
    return issues;
  }

  // council.groups
  if (council.groups === undefined) {
    issues.push(`[WARN] ${label} council.groups: missing (no participant groups defined).`);
  } else if (!isPlainObject(council.groups)) {
    issues.push(`[ERROR] ${label} council.groups: must be an object.`);
  } else {
    for (const [groupName, group] of Object.entries(council.groups)) {
      if (!isPlainObject(group)) {
        issues.push(`[ERROR] ${label} council.groups["${groupName}"]: must be an object.`);
        continue;
      }
      if (!Array.isArray(group.agents) || group.agents.length === 0) {
        issues.push(`[ERROR] ${label} council.groups["${groupName}"].agents: must be a non-empty array.`);
        continue;
      }
      const seen = new Set();
      for (const agentId of group.agents) {
        if (typeof agentId !== 'string' || agentId.length === 0) {
          issues.push(`[ERROR] ${label} council.groups["${groupName}"].agents: contains empty agent ID.`);
          continue;
        }
        if (seen.has(agentId)) {
          issues.push(`[WARN] ${label} council.groups["${groupName}"].agents: duplicate agent ID "${agentId}".`);
          continue;
        }
        seen.add(agentId);
        if (!resolveAgentConfig(agentId, agentResolveOpts)) {
          issues.push(`[WARN] ${label} council.groups["${groupName}"].agents: unknown/unresolvable agent ID "${agentId}".`);
        }
      }
    }
  }

  // council.investigationAgent
  if (council.investigationAgent !== undefined) {
    if (typeof council.investigationAgent !== 'string' || council.investigationAgent.length === 0) {
      issues.push(`[ERROR] ${label} council.investigationAgent: must be a non-empty string.`);
    } else if (!resolveAgentConfig(council.investigationAgent, agentResolveOpts)) {
      issues.push(`[WARN] ${label} council.investigationAgent: unknown/unresolvable agent ID "${council.investigationAgent}".`);
    }
  }

  return issues;
}

/**
 * global + workspace をマージした council 設定の検証（doctor 用）。
 *
 * resolveCouncilConfig は「default グループ必須・各グループの agents が非空/重複なし/
 * 解決可能・investigationAgent が指定されていれば解決可能」を満たせないと null を返す
 * （fail-closed）。マージ後に破綻している場合を単一の ERROR として報告する。ファイル単位の
 * validateCouncilConfig が形式チェックに限定されたため、破綻設定が静かに通らないよう
 * doctor の exit 1 を保つ責務はここが担う（review指摘 #4/#5）。
 *
 * 呼び出し側は「global か workspace の少なくとも一方に council が存在する場合」に限定する
 * こと（council は任意設定であり、未設定を ERROR にしない）。
 *
 * @param {object} opts { workspace?, homedir? }
 * @returns {string[]}
 */
function validateCouncilMerged(opts) {
  const resolved = resolveCouncilConfig({ workspace: opts.workspace, homedir: opts.homedir || HOMEDIR });
  if (resolved === null) {
    return ['[ERROR] council (merged global+workspace): failed to resolve. The merged config must define a "default" group with non-empty, non-duplicate, resolvable agents; if investigationAgent is set, it must resolve too.'];
  }
  return [];
}

// ── subcommand: doctor ─────────────────────────────────────────────────────────

/**
 * Validate a single config and return a list of human-readable issue strings.
 *
 * @param {string} label       'global' or 'workspace'
 * @param {string} configPath  absolute path for error messages
 * @param {object} config      parsed config (may have _parseError)
 * @param {object} defaults
 * @param {object} [ctx]       { workspace, homedir }。council 検証のエージェント解決に使う
 * @returns {string[]}
 */
function validateConfig(label, configPath, config, defaults, ctx = {}) {
  const issues = [];

  if (config === null) {
    return issues; // no file — not an error
  }

  if (config._parseError) {
    issues.push(`[ERROR] ${label} (${configPath}): ${config._parseError}`);
    return issues;
  }

  const defaultAgentIds = new Set(defaults.agents.map(a => a.id));
  const configAgentIds = isPlainObject(config.agents)
    ? Object.keys(config.agents) : [];
  const allKnownIds = new Set([...defaultAgentIds, ...configAgentIds]);

  // Check top-level skillAgentMap
  if (config.skillAgentMap !== undefined) {
    if (!isPlainObject(config.skillAgentMap)) {
      issues.push(`[ERROR] ${label}: skillAgentMap must be an object.`);
    } else {
      const knownSkillKeys = getKnownSkillKeys(defaults);
      const unknownHints = new Map(
        findUnknownSkillKeys(Object.keys(config.skillAgentMap), knownSkillKeys)
          .map(({ skill, hint }) => [skill, hint]),
      );
      for (const [skill, agentId] of Object.entries(config.skillAgentMap)) {
        if (typeof agentId !== 'string' || agentId.length === 0) {
          issues.push(`[ERROR] ${label} skillAgentMap["${skill}"]: empty agent ID.`);
        } else if (!allKnownIds.has(agentId)) {
          issues.push(
            `[WARN] ${label} skillAgentMap["${skill}"]: unknown agent ID "${agentId}".`,
          );
        }
        if (unknownHints.has(skill)) {
          issues.push(`[WARN] ${label} skillAgentMap: unknown skill key "${skill}"${unknownHints.get(skill)}.`);
        }
      }
    }
  }

  // Check agents section
  if (config.agents !== undefined) {
    if (!isPlainObject(config.agents)) {
      issues.push(`[ERROR] ${label}: agents must be an object.`);
    } else {
      for (const [agentId, override] of Object.entries(config.agents)) {
        if (!isPlainObject(override)) {
          issues.push(`[ERROR] ${label} agents["${agentId}"]: must be an object.`);
          continue;
        }
        // "extends" changes resolveAgentConfig()'s behavior into a full replacement
        // (it ignores any existing default for this agentId and rebuilds from the
        // extends target instead — see resolveAgentConfig's comment). So an override
        // with "extends" must be checked here regardless of whether agentId already
        // has a default entry — an existing agent (e.g. "codex") re-pointed at a
        // broken extends target is just as broken as a brand-new custom agent with
        // one (PR #170 review: this branch previously only ran for agentIds absent
        // from defaults, silently missing "codex" being overridden with a bad extends).
        // "extends" only resolves against agent-defaults.json's own agents — it cannot
        // chain to another custom agent defined only in config.json.
        if (override.extends) {
          const resolved = resolveExtends(override, defaults.agents);
          if (!isValidAgentConfig(resolved)) {
            issues.push(
              `[ERROR] ${label} agents["${agentId}"]: extends "${override.extends}", but the ` +
              'resolved config is missing required fields (command + promptDelivery). ' +
              `"${override.extends}" must exist in agent-defaults.json (extends cannot chain to ` +
              'another config.json-only custom agent).',
            );
          }
        } else if (!defaultAgentIds.has(agentId)) {
          // If the agent is not in defaults, it's a brand-new custom agent — must be complete.
          if (!isValidAgentConfig(override)) {
            issues.push(
              `[ERROR] ${label} agents["${agentId}"]: custom agent missing ` +
              'required fields (command + promptDelivery).',
            );
          }
        }
      }
    }
  }

  // Check profiles section
  if (config.profiles !== undefined) {
    if (!isPlainObject(config.profiles)) {
      issues.push(`[ERROR] ${label}: profiles must be an object.`);
    } else {
      const knownSkillKeys = getKnownSkillKeys(defaults);
      for (const [name, profile] of Object.entries(config.profiles)) {
        if (!isPlainObject(profile)) {
          issues.push(`[ERROR] ${label} profiles["${name}"]: must be an object.`);
          continue;
        }
        if (!isPlainObject(profile.skillAgentMap) ||
            Object.keys(profile.skillAgentMap).length === 0) {
          issues.push(
            `[ERROR] ${label} profiles["${name}"]: missing or empty skillAgentMap.`,
          );
          continue;
        }
        const unknownHints = new Map(
          findUnknownSkillKeys(Object.keys(profile.skillAgentMap), knownSkillKeys)
            .map(({ skill, hint }) => [skill, hint]),
        );
        for (const [skill, agentId] of Object.entries(profile.skillAgentMap)) {
          if (typeof agentId !== 'string' || agentId.length === 0) {
            issues.push(
              `[ERROR] ${label} profiles["${name}"].skillAgentMap["${skill}"]: empty agent ID.`,
            );
          } else if (!allKnownIds.has(agentId)) {
            issues.push(
              `[WARN] ${label} profiles["${name}"].skillAgentMap["${skill}"]: ` +
              `unknown agent ID "${agentId}".`,
            );
          }
          if (unknownHints.has(skill)) {
            issues.push(
              `[WARN] ${label} profiles["${name}"].skillAgentMap: unknown skill key "${skill}"${unknownHints.get(skill)}.`,
            );
          }
        }
      }
    }
  }

  // Check council section (Issue #230)
  if (config.council !== undefined) {
    issues.push(...validateCouncilConfig(label, config.council, ctx));
  }

  return issues;
}

/**
 * Validate config structure and report issues.
 *
 * @param {string|null} workspacePath
 */
function cmdDoctor(workspacePath) {
  const defaults = loadDefaults();
  const allIssues = [];
  const ctx = { workspace: workspacePath || undefined, homedir: HOMEDIR };

  // Global config
  const config = loadJSON(CONFIG_PATH);
  allIssues.push(...validateConfig('global', CONFIG_PATH, config, defaults, ctx));

  // Workspace config
  let wsConfig = null;
  if (workspacePath) {
    const wsConfigPath = path.resolve(workspacePath, '.gh-maestro', 'config.json');
    wsConfig = loadJSON(wsConfigPath);
    if (wsConfig !== null) {
      allIssues.push(...validateConfig('workspace', wsConfigPath, wsConfig, defaults, ctx));
    }
  }

  // council はマージ後（global + workspace）の形で検証する。分割設定（global に default、
  // workspace が groups を追加）の false positive を避けつつ、マージ結果として破綻して
  // いる場合に exit 1 を保つ（review指摘 #4/#5）。どこにも council が無ければ任意設定なので検証しない。
  const councilConfigured = (config && !config._parseError && config.council !== undefined)
    || (wsConfig && !wsConfig._parseError && wsConfig.council !== undefined);
  if (councilConfigured) {
    allIssues.push(...validateCouncilMerged(ctx));
  }

  if (allIssues.length === 0) {
    console.log('OK — no issues found.');
  } else {
    for (const issue of allIssues) {
      console.log(issue);
    }
    process.exitCode = 1;
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const USAGE = `config.js — gh-maestro agent configuration CLI

Manage skill→agent mappings via named profiles and validate config file integrity.

Profile semantics:
  A profile's skillAgentMap is a DIFFERENTIAL — only the skills to change
  relative to agent-defaults.json defaults. The resolver merges:
    defaults → global skillAgentMap → workspace skillAgentMap

Agent launch arguments:
  Set agents.<id>.extraArgs for arguments shared by normal and headless launches.
  Do not set agents.<id>.execArgs in config.json; it is reserved for built-in
  route-specific arguments such as --cd {workspace}.

Usage:
  node scripts/config.js <subcommand> [options]

Subcommands:
  use <profile>     Apply a named profile's skillAgentMap to config.json.
                    Exits 1 without changing the file when config.json cannot
                    be parsed or its skillAgentMap is not an object.
  doctor            Validate config structure and report issues

Options:
  --workspace <path>  Workspace path for doctor validation
  --help, -h          Show this help message`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (argv[i] === '--workspace') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags.workspace = path.resolve(argv[++i]);
      } else {
        flags.workspace = null;
      }
    } else {
      rest.push(argv[i]);
    }
  }

  return { flags, rest };
}

// ── entry point ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const subcommand = rest[0];

  if (!subcommand) {
    console.error(USAGE);
    process.exit(1);
  }

  // Only resolve workspace when --workspace is explicitly provided.
  // Do NOT auto-detect from CWD/env for config inspection commands.
  const workspacePath = flags.workspace !== undefined ? flags.workspace : undefined;

  switch (subcommand) {
    case 'use': {
      const profileName = rest[1];
      if (!profileName) {
        console.error('Error: profile name required.');
        console.error('Usage: node scripts/config.js use <profile>');
        process.exit(1);
      }
      cmdUse(profileName);
      break;
    }
    case 'doctor':
      cmdDoctor(workspacePath);
      break;
    default:
      console.error(`Error: unknown subcommand "${subcommand}".`);
      console.error('');
      console.error(USAGE);
      process.exit(1);
  }
}

// ── exports (for testing) ──────────────────────────────────────────────────────

module.exports = {
  loadJSON,
  saveConfig,
  collectValidAgentIds,
  closestKnownSkillKey,
  getKnownSkillKeys,
  findUnknownSkillKeys,
  validateConfig,
  validateCouncilConfig,
  validateCouncilMerged,
  USAGE,
};
