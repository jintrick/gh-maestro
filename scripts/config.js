#!/usr/bin/env node
'use strict';

// config.js
// gh-maestro agent configuration CLI.
//
// Subcommands:
//   use <profile>   Apply a named profile's skillAgentMap to ~/.gh-maestro/config.json
//   status          Show resolved skillAgentMap with sources and agent connectivity
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

const { loadDefaults, resolveAgentConfig, resolveSkillAgentMap, isValidAgentConfig } = require('./shared/resolve-config');
const { checkAgentExists } = require('./agent-exec');

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
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
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
 * Build a resolved skillAgentMap with source annotations.
 * Returns { map, sources } where sources maps skill → 'default'|'global'|'workspace'.
 *
 * @param {object} defaults
 * @param {object|null} globalConfig
 * @param {object|null} wsConfig
 * @returns {{ map: Record<string,string>, sources: Record<string,string> }}
 */
function resolveSkillAgentMapWithSources(defaults, globalConfig, wsConfig) {
  const map = { ...defaults.skillAgentMap };
  const sources = {};
  for (const skill of Object.keys(map)) {
    sources[skill] = 'default';
  }

  if (globalConfig && globalConfig.skillAgentMap && !globalConfig._parseError) {
    for (const [skill, agentId] of Object.entries(globalConfig.skillAgentMap)) {
      map[skill] = agentId;
      sources[skill] = 'global';
    }
  }

  if (wsConfig && wsConfig.skillAgentMap && !wsConfig._parseError) {
    for (const [skill, agentId] of Object.entries(wsConfig.skillAgentMap)) {
      map[skill] = agentId;
      sources[skill] = 'workspace';
    }
  }

  return { map, sources };
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
  if (!profileMap || typeof profileMap !== 'object' || Array.isArray(profileMap) || Object.keys(profileMap).length === 0) {
    console.error(`Error: profile "${profileName}" has no valid skillAgentMap.`);
    process.exit(1);
  }

  // Validate all agent IDs in the profile map
  const defaults = loadDefaults();
  const validAgentIds = collectValidAgentIds(defaults, config);
  const defaultAgentIds = new Set(defaults.agents.map(a => a.id));

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
    if (!defaultAgentIds.has(agentId)) {
      const customAgent = config.agents && config.agents[agentId];
      if (!isValidAgentConfig(customAgent)) {
        console.error(
          `Error: agent "${agentId}" (for skill "${skill}") is a custom agent ` +
          'missing required fields (command + promptDelivery).',
        );
        process.exit(1);
      }
    }
  }

  // Warn about unknown skill keys (not an error — profiles may add custom keys)
  const knownSkillKeys = Object.keys(defaults.skillAgentMap);
  for (const skill of Object.keys(profileMap)) {
    if (!knownSkillKeys.includes(skill)) {
      const suggestion = closestKnownSkillKey(skill, knownSkillKeys);
      const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
      console.error(`[WARN] Profile "${profileName}": unknown skill key "${skill}"${hint}.`);
    }
  }

  // Write: merge top-level skillAgentMap with the profile's map (stacking behavior)
  const baseMap = (config.skillAgentMap && typeof config.skillAgentMap === 'object' && !Array.isArray(config.skillAgentMap))
    ? config.skillAgentMap
    : {};
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

// ── subcommand: status ─────────────────────────────────────────────────────────

/**
 * Show the resolved skillAgentMap with source annotations and agent connectivity.
 *
 * @param {string|null} workspacePath
 */
function cmdStatus(workspacePath) {
  const defaults = loadDefaults();
  const config = loadJSON(CONFIG_PATH);

  // Load workspace config
  let wsConfig = null;
  if (workspacePath) {
    const wsConfigPath = path.resolve(workspacePath, '.gh-maestro', 'config.json');
    wsConfig = loadJSON(wsConfigPath);
  }

  // Resolve skillAgentMap with sources
  const { map, sources } = resolveSkillAgentMapWithSources(defaults, config, wsConfig);

  // Warn about workspace command/extraArgs overrides (silently ignored by resolver)
  if (wsConfig && wsConfig.agents && !wsConfig._parseError) {
    for (const [agentId, override] of Object.entries(wsConfig.agents)) {
      if (override && typeof override === 'object' &&
          (override.command !== undefined || override.extraArgs !== undefined)) {
        const suppressed = [];
        if (override.command !== undefined) suppressed.push('command');
        if (override.extraArgs !== undefined) suppressed.push('extraArgs');
        console.log(
          `[!] Workspace overrides ${suppressed.join('/')} for agent "${agentId}" — ` +
          'IGNORED (security: workspace cannot override execution fields).',
        );
      }
    }
  }



  // Display table with agent connectivity
  const entries = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    console.log('(no skill-agent mappings)');
    return;
  }

  const maxSkillLen = Math.max(...entries.map(([s]) => s.length), 5);
  const maxAgentLen = Math.max(...entries.map(([, a]) => a.length), 5);

  // Header
  const header = `${'Skill'.padEnd(maxSkillLen)}  ${'Agent'.padEnd(maxAgentLen)}  Source      OK`;
  console.log(header);
  console.log('-'.repeat(header.length));

  // Cache both resolveAgentConfig and checkAgentExists results.
  // resolveAgentConfig can be expensive (npm root -g for reasonix etc.),
  // and checkAgentExists spawns a login shell per unique command.
  // Caching by agentId prevents DoS via malicious workspace configs
  // with thousands of fake skill keys mapping to the same agent.
  const resolvedCache = new Map();
  const existsCache = new Map();

  for (const [skill, agentId] of entries) {
    // Resolve the agent config (cached)
    let resolved;
    if (resolvedCache.has(agentId)) {
      resolved = resolvedCache.get(agentId);
    } else {
      resolved = resolveAgentConfig(agentId, {
        homedir: HOMEDIR,
        workspace: workspacePath || undefined,
      });
      resolvedCache.set(agentId, resolved);
    }

    let ok = '✗';
    if (resolved) {
      if (!existsCache.has(resolved.command)) {
        existsCache.set(resolved.command, checkAgentExists(resolved.command));
      }
      ok = existsCache.get(resolved.command) ? '✓' : '✗';
    }

    const srcLabel = sources[skill] || '?';
    console.log(
      `${skill.padEnd(maxSkillLen)}  ${agentId.padEnd(maxAgentLen)}  ${srcLabel.padEnd(11)} ${ok}`,
    );
  }

  // Warn about unknown skill keys in global config sources
  if (config && !config._parseError) {
    const knownSkillKeys = Object.keys(defaults.skillAgentMap);
    if (config.skillAgentMap && typeof config.skillAgentMap === 'object' && !Array.isArray(config.skillAgentMap)) {
      for (const skill of Object.keys(config.skillAgentMap)) {
        if (!knownSkillKeys.includes(skill)) {
          const suggestion = closestKnownSkillKey(skill, knownSkillKeys);
          const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
          console.log(`\n[!] Unknown skill key "${skill}" in global config${hint}.`);
        }
      }
    }
    if (config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles)) {
      for (const [profileName, profile] of Object.entries(config.profiles)) {
        if (profile && profile.skillAgentMap && typeof profile.skillAgentMap === 'object') {
          for (const skill of Object.keys(profile.skillAgentMap)) {
            if (!knownSkillKeys.includes(skill)) {
              const suggestion = closestKnownSkillKey(skill, knownSkillKeys);
              const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
              console.log(`\n[!] Unknown skill key "${skill}" in profile "${profileName}"${hint}.`);
            }
          }
        }
      }
    }
  }
}

// ── subcommand: doctor ─────────────────────────────────────────────────────────

/**
 * Validate a single config and return a list of human-readable issue strings.
 *
 * @param {string} label       'global' or 'workspace'
 * @param {string} configPath  absolute path for error messages
 * @param {object} config      parsed config (may have _parseError)
 * @param {object} defaults
 * @returns {string[]}
 */
function validateConfig(label, configPath, config, defaults) {
  const issues = [];

  if (config === null) {
    return issues; // no file — not an error
  }

  if (config._parseError) {
    issues.push(`[ERROR] ${label} (${configPath}): ${config._parseError}`);
    return issues;
  }

  const defaultAgentIds = new Set(defaults.agents.map(a => a.id));
  const configAgentIds = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)
    ? Object.keys(config.agents) : [];
  const allKnownIds = new Set([...defaultAgentIds, ...configAgentIds]);

  // Check top-level skillAgentMap
  if (config.skillAgentMap !== undefined) {
    if (typeof config.skillAgentMap !== 'object' || config.skillAgentMap === null || Array.isArray(config.skillAgentMap)) {
      issues.push(`[ERROR] ${label}: skillAgentMap must be an object.`);
    } else {
      for (const [skill, agentId] of Object.entries(config.skillAgentMap)) {
        if (typeof agentId !== 'string' || agentId.length === 0) {
          issues.push(`[ERROR] ${label} skillAgentMap["${skill}"]: empty agent ID.`);
        } else if (!allKnownIds.has(agentId)) {
          issues.push(
            `[WARN] ${label} skillAgentMap["${skill}"]: unknown agent ID "${agentId}".`,
          );
        }
      }

      // Check for unknown skill keys (not in agent-defaults.json's skillAgentMap)
      const knownSkillKeys = Object.keys(defaults.skillAgentMap);
      for (const skill of Object.keys(config.skillAgentMap)) {
        if (!knownSkillKeys.includes(skill)) {
          const suggestion = closestKnownSkillKey(skill, knownSkillKeys);
          const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
          issues.push(`[WARN] ${label} skillAgentMap: unknown skill key "${skill}"${hint}.`);
        }
      }
    }
  }

  // Check agents section
  if (config.agents !== undefined) {
    if (typeof config.agents !== 'object' || config.agents === null || Array.isArray(config.agents)) {
      issues.push(`[ERROR] ${label}: agents must be an object.`);
    } else {
      for (const [agentId, override] of Object.entries(config.agents)) {
        if (typeof override !== 'object' || override === null || Array.isArray(override)) {
          issues.push(`[ERROR] ${label} agents["${agentId}"]: must be an object.`);
          continue;
        }
        // If the agent is not in defaults, it's a custom agent — must be complete
        if (!defaultAgentIds.has(agentId)) {
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
    if (typeof config.profiles !== 'object' || config.profiles === null || Array.isArray(config.profiles)) {
      issues.push(`[ERROR] ${label}: profiles must be an object.`);
    } else {
      for (const [name, profile] of Object.entries(config.profiles)) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          issues.push(`[ERROR] ${label} profiles["${name}"]: must be an object.`);
          continue;
        }
        if (!profile.skillAgentMap || typeof profile.skillAgentMap !== 'object' || Array.isArray(profile.skillAgentMap) ||
            Object.keys(profile.skillAgentMap).length === 0) {
          issues.push(
            `[ERROR] ${label} profiles["${name}"]: missing or empty skillAgentMap.`,
          );
          continue;
        }
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
        }

        // Check for unknown skill keys in profile
        const knownSkillKeys = Object.keys(defaults.skillAgentMap);
        for (const skill of Object.keys(profile.skillAgentMap)) {
          if (!knownSkillKeys.includes(skill)) {
            const suggestion = closestKnownSkillKey(skill, knownSkillKeys);
            const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
            issues.push(
              `[WARN] ${label} profiles["${name}"].skillAgentMap: unknown skill key "${skill}"${hint}.`,
            );
          }
        }
      }
    }
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

  // Global config
  const config = loadJSON(CONFIG_PATH);
  allIssues.push(...validateConfig('global', CONFIG_PATH, config, defaults));

  // Workspace config
  if (workspacePath) {
    const wsConfigPath = path.resolve(workspacePath, '.gh-maestro', 'config.json');
    const wsConfig = loadJSON(wsConfigPath);
    if (wsConfig !== null) {
      allIssues.push(...validateConfig('workspace', wsConfigPath, wsConfig, defaults));
    }
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

Manage skill→agent mappings via named profiles, inspect resolved configuration,
and validate config file integrity.

Profile semantics:
  A profile's skillAgentMap is a DIFFERENTIAL — only the skills to change
  relative to agent-defaults.json defaults. The resolver merges:
    defaults → global skillAgentMap → workspace skillAgentMap

Usage:
  node scripts/config.js <subcommand> [options]

Subcommands:
  use <profile>     Apply a named profile's skillAgentMap to config.json
  status            Show resolved skillAgentMap with connectivity checks
  doctor            Validate config structure and report issues

Options:
  --workspace <path>  Workspace path (for status: include workspace config;
                      for doctor: also validate workspace config)
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
    case 'status':
      cmdStatus(workspacePath);
      break;
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
  resolveSkillAgentMapWithSources,
  validateConfig,
  USAGE,
};
