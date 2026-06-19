#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const AGENTS_YAML = path.join(SKILLS_DIR, 'agents.yaml');

// ── Minimal YAML parser for agents.yaml ──────────────────────────────────────

function parseAgentsYaml(content) {
  const agents = {};
  let currentAgent = null;
  let inSubstitutions = false;
  let blockKey = null;
  let blockIndent = null;
  let blockLines = [];

  function flushBlock() {
    if (blockKey && currentAgent) {
      while (blockLines.length && !blockLines[blockLines.length - 1].trim()) blockLines.pop();
      agents[currentAgent].substitutions[blockKey] = blockLines.join('\n');
    }
    blockKey = null;
    blockIndent = null;
    blockLines = [];
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();

    if (blockKey !== null) {
      if (!line.trim()) { blockLines.push(''); continue; }
      const lineIndent = line.length - line.trimStart().length;
      if (blockIndent === null) blockIndent = lineIndent;
      if (lineIndent >= blockIndent) { blockLines.push(line.slice(blockIndent)); continue; }
      flushBlock();
    }

    if (!line || line.trimStart().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (indent === 2 && !value) {
      currentAgent = key;
      agents[key] = { substitutions: {} };
      inSubstitutions = false;
    } else if (indent === 4 && currentAgent) {
      if (key === 'skill_markdown_template_placeholder_substitutions') {
        inSubstitutions = true;
      } else if (key === 'skill_files_install_destination_directory') {
        agents[currentAgent].dest = value;
        inSubstitutions = false;
      }
    } else if (indent === 6 && currentAgent && inSubstitutions) {
      if (value === '|') {
        blockKey = key;
        blockIndent = null;
        blockLines = [];
      } else {
        agents[currentAgent].substitutions[key] = value;
      }
    }
  }

  flushBlock();
  return agents;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function expandHome(p) {
  return p.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
}

function syncDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const srcNames = new Set(fs.readdirSync(src));
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (!srcNames.has(entry.name)) {
      const stale = path.join(dest, entry.name);
      if (entry.isDirectory()) fs.rmSync(stale, { recursive: true, force: true });
      else fs.unlinkSync(stale);
    }
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) syncDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function applySubstitutions(content, substitutions) {
  let result = content;
  let prev;
  do {
    prev = result;
    for (const [key, value] of Object.entries(substitutions)) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
  } while (result !== prev);
  return result;
}

function stripFrontmatter(content) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

function step(msg) { console.log(`\x1b[36m[gh-maestro-install] ${msg}\x1b[0m`); }
function ok(msg)   { console.log(`  \x1b[32mv ${msg}\x1b[0m`); }
function fail(msg) { console.error(`  \x1b[31mx ${msg}\x1b[0m`); process.exit(1); }

module.exports = { parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter };

if (require.main !== module) return;

// ── Main ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(AGENTS_YAML)) fail('skills/agents.yaml not found');
const agents = parseAgentsYaml(fs.readFileSync(AGENTS_YAML, 'utf8'));

const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name);

for (const [agentName, config] of Object.entries(agents)) {
  const dest = expandHome(config.dest);
  step(`Installing skills for ${agentName}...`);
  fs.mkdirSync(dest, { recursive: true });

  // リポジトリに存在しない stale スキルディレクトリを削除する
  if (fs.existsSync(dest)) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (entry.isDirectory() && !skillDirs.includes(entry.name)) {
        fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
        ok(`removed stale skill: ${entry.name}`);
      }
    }
  }

  // SCRIPTS_PATH はインストール先から絶対パスで計算する
  const substitutions = Object.assign({}, config.substitutions, {
    SCRIPTS_PATH: path.join(dest, 'gh-maestro-orchestrator', 'scripts'),
  });

  for (const skill of skillDirs) {
    const templatePath = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(templatePath)) continue;

    const destSkill = path.join(dest, skill);
    fs.mkdirSync(destSkill, { recursive: true });

    const template = fs.readFileSync(templatePath, 'utf8');
    const content = applySubstitutions(template, substitutions);
    fs.writeFileSync(path.join(destSkill, 'SKILL.md'), content, 'utf8');

    const scriptsSrc = path.join(SKILLS_DIR, skill, 'scripts');
    if (fs.existsSync(scriptsSrc)) {
      syncDir(scriptsSrc, path.join(destSkill, 'scripts'));
    }

    ok(`${skill} -> ${destSkill}`);
  }
}

// ── Base scripts を全スキルに配布 ────────────────────────────────────────────

step('Distributing base scripts to all skills...');
const baseScripts = ['send-pane.js'];
const baseScriptsSrc = path.join(SKILLS_DIR, 'gh-maestro-base', 'scripts');
const recipientSkills = skillDirs.filter(skill => {
  if (skill === 'gh-maestro-base') return false;
  const skillMd = path.join(SKILLS_DIR, skill, 'SKILL.md');
  return fs.existsSync(skillMd) &&
    fs.readFileSync(skillMd, 'utf8').includes('{{SCRIPTS_PATH}}');
});

for (const [, config] of Object.entries(agents)) {
  const dest = expandHome(config.dest);
  for (const skill of recipientSkills) {
    for (const script of baseScripts) {
      const src = path.join(baseScriptsSrc, script);
      if (!fs.existsSync(src)) { fail(`${src} not found`); }
      const destDir = path.join(dest, skill, 'scripts');
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, script));
    }
    ok(`send-pane.js -> ${path.join(dest, skill, 'scripts')}`);
  }
}

// ── Shared scripts & assets ───────────────────────────────────────────────────

step('Installing shared scripts...');
const sharedDest = expandHome('~/.gh-maestro/scripts');
fs.mkdirSync(sharedDest, { recursive: true });
const scriptsDir = path.join(ROOT, 'scripts');
const INSTALL_EXCLUDE = new Set(['install.js']);
const assetScripts = new Set(
  fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js') && !INSTALL_EXCLUDE.has(f))
);
// stale ファイルを削除
for (const f of fs.readdirSync(sharedDest)) {
  if (!assetScripts.has(f)) {
    fs.unlinkSync(path.join(sharedDest, f));
    ok(`removed stale script: ${f}`);
  }
}
for (const script of assetScripts) {
  fs.copyFileSync(path.join(scriptsDir, script), path.join(sharedDest, script));
  ok(`${script} -> ${sharedDest}`);
}

step('Installing caller template workflows...');
const callerTemplateSrc = path.join(ROOT, 'workflows', 'caller-template');
const callerTemplateDest = expandHome('~/.gh-maestro/workflows/caller-template');
syncDir(callerTemplateSrc, callerTemplateDest);
ok(`workflows/caller-template -> ${callerTemplateDest}`);

step('Installing reviewer workflow files...');
const workflowsSrc = path.join(ROOT, 'workflows');
const workflowsDest = expandHome('~/.gh-maestro/workflows');
for (const f of fs.readdirSync(workflowsSrc)) {
  if (!f.endsWith('.lock.yml') && !f.endsWith('.md')) continue;
  const src = path.join(workflowsSrc, f);
  const dest = path.join(workflowsDest, f);
  fs.mkdirSync(workflowsDest, { recursive: true });
  fs.copyFileSync(src, dest);
  ok(`workflows/${f} -> ${workflowsDest}`);
}

step('Installing default review policy...');
const reviewPolicySrc = path.join(ROOT, 'assets', 'review-policy.md');
if (!fs.existsSync(reviewPolicySrc)) fail('assets/review-policy.md not found');
const reviewPolicyDest = expandHome('~/.gh-maestro/review-policy.md');
const reviewPolicyContent = stripFrontmatter(fs.readFileSync(reviewPolicySrc, 'utf8'));
fs.writeFileSync(reviewPolicyDest, reviewPolicyContent, 'utf8');
ok(`review-policy.md -> ${expandHome('~/.gh-maestro')}`);

step('Installing default agents config...');
const agentsConfigPath = expandHome('~/.gh-maestro/agents.json');
if (!fs.existsSync(agentsConfigPath)) {
  const defaultAgents = [
    { id: 'claude',    label: 'Claude Code (Anthropic)', command: 'claude',    extraArgs: ['--dangerously-skip-permissions'], promptFlag: null },
    { id: 'claude-ds', label: 'Claude Code (DeepSeek)',  command: 'claude-ds', extraArgs: ['--dangerously-skip-permissions'], promptFlag: null },
    { id: 'agy',       label: 'Antigravity',             command: 'agy',       extraArgs: ['--dangerously-skip-permissions'], promptFlag: '-i' },
  ];
  fs.writeFileSync(agentsConfigPath, JSON.stringify(defaultAgents, null, 2) + '\n', 'utf8');
  ok(`agents.json -> ${expandHome('~/.gh-maestro')}`);
} else {
  ok(`agents.json already exists — skipping`);
}

// ── UserPromptExpansion hook を ~/.claude/settings.json に登録 ────────────────

step('Registering UserPromptExpansion hook in ~/.claude/settings.json...');

const userSettingsPath = expandHome('~/.claude/settings.json');
let userSettings = {};
if (fs.existsSync(userSettingsPath)) {
  try {
    userSettings = JSON.parse(fs.readFileSync(userSettingsPath, 'utf8'));
  } catch (e) {
    fail(`Cannot parse ${userSettingsPath}: ${e.message}`);
  }
}

if (!userSettings.hooks) userSettings.hooks = {};
if (!userSettings.hooks.UserPromptExpansion) userSettings.hooks.UserPromptExpansion = [];

// 既存の gh-maestro エントリを除去（重複防止）
userSettings.hooks.UserPromptExpansion =
  userSettings.hooks.UserPromptExpansion.filter(g => !/gh-maestro/.test(g.matcher ?? ''));

// orchestratorスクリプトのパス（$HOME相対でシェル展開に任せる）
const claudeSkillsRelToHome = path.relative(
  process.env.HOME || process.env.USERPROFILE || '',
  expandHome(agents['claude'] ? agents['claude'].dest : '~/.claude/skills')
).replace(/\\/g, '/');
const orchScripts = `$HOME/${claudeSkillsRelToHome}/gh-maestro-orchestrator/scripts`;

// フックを追加
userSettings.hooks.UserPromptExpansion.push({
  matcher: '^gh-maestro$',
  hooks: [
    {
      type: 'command',
      command: 'node "$HOME/.gh-maestro/scripts/gh-maestro-setup.js"',
      statusMessage: 'gh-maestro 前提条件チェック中...',
    },
    {
      type: 'command',
      command: `node "${orchScripts}/reset-session.js" --workspace "$(pwd)" --quiet`,
      statusMessage: 'セッションリセット中...',
    },
    {
      type: 'command',
      command: `node "${orchScripts}/get-context.js"`,
    },
  ],
});

fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
fs.writeFileSync(userSettingsPath, JSON.stringify(userSettings, null, 2) + '\n', 'utf8');
ok(`UserPromptExpansion hook -> ${userSettingsPath}`);

console.log('\ngh-maestro installed.\n');
console.log('Usage:');
console.log('  1. Open wezterm and navigate to your project root');
console.log('  2. Start claude or agy');
console.log('  3. Type: /gh-maestro\n');
