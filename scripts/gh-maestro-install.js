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

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
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
      agents[currentAgent].substitutions[key] = value;
    }
  }

  return agents;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function expandHome(p) {
  return p.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function applySubstitutions(content, substitutions) {
  let result = content;
  for (const [key, value] of Object.entries(substitutions)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
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

  for (const skill of skillDirs) {
    const templatePath = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(templatePath)) continue;

    const destSkill = path.join(dest, skill);
    fs.mkdirSync(destSkill, { recursive: true });

    const template = fs.readFileSync(templatePath, 'utf8');
    const content = applySubstitutions(template, config.substitutions);
    fs.writeFileSync(path.join(destSkill, 'SKILL.md'), content, 'utf8');

    const scriptsSrc = path.join(SKILLS_DIR, skill, 'scripts');
    if (fs.existsSync(scriptsSrc)) {
      copyDir(scriptsSrc, path.join(destSkill, 'scripts'));
    }

    ok(`${skill} -> ${destSkill}`);
  }
}

// ── Shared scripts & assets ───────────────────────────────────────────────────

step('Installing shared scripts...');
const setupSrc = path.join(ROOT, 'scripts', 'gh-maestro-setup.js');
if (!fs.existsSync(setupSrc)) fail('scripts/gh-maestro-setup.js not found');
const sharedDest = expandHome('~/.gh-maestro/scripts');
fs.mkdirSync(sharedDest, { recursive: true });
fs.copyFileSync(setupSrc, path.join(sharedDest, 'gh-maestro-setup.js'));
ok(`gh-maestro-setup.js -> ${sharedDest}`);

step('Installing default review policy...');
const reviewPolicySrc = path.join(ROOT, 'assets', 'review-policy.md');
if (!fs.existsSync(reviewPolicySrc)) fail('assets/review-policy.md not found');
const reviewPolicyDest = expandHome('~/.gh-maestro/review-policy.md');
const reviewPolicyContent = stripFrontmatter(fs.readFileSync(reviewPolicySrc, 'utf8'));
fs.writeFileSync(reviewPolicyDest, reviewPolicyContent, 'utf8');
ok(`review-policy.md -> ${expandHome('~/.gh-maestro')}`);

console.log('\ngh-maestro installed.\n');
console.log('Usage:');
console.log('  1. Open wezterm and navigate to your project root');
console.log('  2. Start claude or agy');
console.log('  3. Type: /gh-maestro\n');
