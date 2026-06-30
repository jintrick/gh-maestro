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

// ~/.gh-maestro/ は gh-maestro 専用ディレクトリ。install が書いたものだけを残し、
// それ以外（旧バージョンの遺産）は最後に prune で除去する。
// 「書いた＝残す」を保証するため、ここ配下のパスは必ず ghMaestroPath() で組み立てる。
// パスを作る行為がそのままトップレベル名を keep に記録するので、登録し忘れる余地が無い。
const ghMaestroDir = expandHome('~/.gh-maestro');
const ghMaestroKeep = new Set();
function ghMaestroPath(...segs) {
  ghMaestroKeep.add(segs[0]);
  return path.join(ghMaestroDir, ...segs);
}

// 全スクリプト（CLI・モジュール）を集約する単一ディレクトリ。
// SKILL.md からは {{SCRIPTS_PATH}} がこの絶対パスに置換されて参照される。
const SHARED_SCRIPTS = ghMaestroPath('scripts');

// ── 各エージェントのスキルディレクトリに SKILL.md のみを配置 ──────────────────
// スクリプトはスキルdirには置かず、すべて SHARED_SCRIPTS に集約する（下の共有install参照）。

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

  // {{SCRIPTS_PATH}} は集約先（SHARED_SCRIPTS）の絶対パスに統一する
  const substitutions = Object.assign({}, config.substitutions, {
    SCRIPTS_PATH: SHARED_SCRIPTS,
  });

  for (const skill of skillDirs) {
    const templatePath = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(templatePath)) continue;

    const destSkill = path.join(dest, skill);
    fs.mkdirSync(destSkill, { recursive: true });

    const template = fs.readFileSync(templatePath, 'utf8');
    const content = applySubstitutions(template, substitutions);
    fs.writeFileSync(path.join(destSkill, 'SKILL.md'), content, 'utf8');

    // 旧バージョンが配置していた per-skill の scripts/ を stale として削除する
    const staleScripts = path.join(destSkill, 'scripts');
    if (fs.existsSync(staleScripts)) {
      fs.rmSync(staleScripts, { recursive: true, force: true });
      ok(`removed stale per-skill scripts: ${path.join(skill, 'scripts')}`);
    }

    ok(`${skill} -> ${destSkill}`);
  }
}

// ── scripts/ を SHARED_SCRIPTS にミラーする ───────────────────────────────────
// リポジトリの scripts/ が、インストール先 ~/.gh-maestro/scripts/ と1:1で対応する。
// CLIスクリプトもモジュール(link-node-modules等)も全て scripts/ に同居しているため、
// 各スクリプトの require('./xxx') がリポジトリ実行・インストール先実行の両方で解決する。

step('Installing all scripts into the shared directory...');
fs.mkdirSync(SHARED_SCRIPTS, { recursive: true });

const INSTALL_EXCLUDE = new Set(['install.js']);
const scriptsDir = path.join(ROOT, 'scripts');
const scriptFiles = fs.readdirSync(scriptsDir)
  .filter(f => (f.endsWith('.js') || f.endsWith('.md')) && !INSTALL_EXCLUDE.has(f));

// stale 削除: scripts/ に無いファイルを集約先から除去する
const expected = new Set(scriptFiles);
for (const f of fs.readdirSync(SHARED_SCRIPTS)) {
  if (!expected.has(f)) {
    const p = path.join(SHARED_SCRIPTS, f);
    if (fs.statSync(p).isFile()) {
      fs.unlinkSync(p);
      ok(`removed stale script: ${f}`);
    }
  }
}
for (const f of scriptFiles) {
  fs.copyFileSync(path.join(scriptsDir, f), path.join(SHARED_SCRIPTS, f));
}
ok(`${scriptFiles.length} scripts -> ${SHARED_SCRIPTS}`);

// ── 共有スキルを ~/.gh-maestro/skills/ にデプロイ ─────────────────────────────
// スキルシステムを持たないエージェント（reasonix 等）が AGENTS.md 経由でスキルを読むための
// 正規コピー。SCRIPTS_PATH は共有スクリプト先で統一する。
step('Installing shared skill files into ~/.gh-maestro/skills/...');
const SHARED_SKILLS = ghMaestroPath('skills');
fs.mkdirSync(SHARED_SKILLS, { recursive: true });

const canonicalAgent = agents['claude'] || agents[Object.keys(agents)[0]];
const sharedSubstitutions = Object.assign({}, canonicalAgent?.substitutions ?? {}, {
  SCRIPTS_PATH: SHARED_SCRIPTS,
});

// stale 削除
for (const entry of fs.readdirSync(SHARED_SKILLS, { withFileTypes: true })) {
  if (entry.isDirectory() && !skillDirs.includes(entry.name)) {
    fs.rmSync(path.join(SHARED_SKILLS, entry.name), { recursive: true, force: true });
    ok(`removed stale shared skill: ${entry.name}`);
  }
}
for (const skill of skillDirs) {
  const templatePath = path.join(SKILLS_DIR, skill, 'SKILL.md');
  if (!fs.existsSync(templatePath)) continue;
  const destSkillDir = path.join(SHARED_SKILLS, skill);
  fs.mkdirSync(destSkillDir, { recursive: true });
  const template = fs.readFileSync(templatePath, 'utf8');
  fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), applySubstitutions(template, sharedSubstitutions), 'utf8');
  ok(`${skill} -> ${destSkillDir} (shared)`);
}

step('Installing default agents config...');
const agentsConfigPath = ghMaestroPath('agents.json');
const defaults = [
  { id: 'claude',    label: 'Claude Code (Anthropic)', command: 'claude',    extraArgs: ['--dangerously-skip-permissions'], promptFlag: null },
  { id: 'claude-ds', label: 'Claude Code (DeepSeek)',  command: 'claude-ds', extraArgs: ['--dangerously-skip-permissions'], promptFlag: null },
  { id: 'reasonix',  label: 'Reasonix Code',           command: 'reasonix',  extraArgs: ['--yolo'], promptFlag: 'run', skillsViaMd: true },
  { id: 'agy',       label: 'Antigravity',             command: 'agy',       extraArgs: ['--dangerously-skip-permissions'], promptFlag: '-i' },
];
if (!fs.existsSync(agentsConfigPath)) {
  fs.writeFileSync(agentsConfigPath, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
  ok(`agents.json -> ${expandHome('~/.gh-maestro')}`);
} else {
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(agentsConfigPath, 'utf8'));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    ok('agents.json parse failed — overwriting with defaults');
    existing = [];
  }
  const existingMap = new Map(existing.map(a => [a.id, a]));
  let added = 0, updated = 0;
  for (const agent of defaults) {
    if (!existingMap.has(agent.id)) {
      existing.push(agent);
      added++;
    } else {
      const entry = existingMap.get(agent.id);
      // command がデフォルトのままのときだけ extraArgs/promptFlag をデフォルトに追従させる。
      // ユーザーが command をカスタマイズしている場合、extraArgs はその command と結合している
      // （例: command=pwsh の DeepSeek ラッパー）ため、上書きすると起動が壊れる。touch しない。
      if (entry.command === agent.command) {
        entry.extraArgs = agent.extraArgs;
        entry.promptFlag = agent.promptFlag;
        if ('skillsViaMd' in agent) entry.skillsViaMd = agent.skillsViaMd;
        updated++;
      }
    }
  }
  if (added > 0 || updated > 0) {
    fs.writeFileSync(agentsConfigPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    ok(`agents.json updated (+${added} added, ${updated} refreshed)`);
  } else {
    ok('agents.json already up to date');
  }
}

// ── ~/.gh-maestro/ を権威的に管理する ─────────────────────────────────────────
// install がこの実行中に書いたトップレベル名（ghMaestroKeep）だけを残し、それ以外
// （旧バージョンの遺産: workflows/ ・.claude/ ・GH_MAESTRO_REF ・廃止済み review-policy.md 等）
// を除去する。keep リストは ghMaestroPath() がパス生成時に自動記録するので、手書きの
// 管理対象リストは存在せず、登録し忘れによるサイレント削除が起きない。
step('Pruning ~/.gh-maestro/ of unmanaged legacy artifacts...');
for (const entry of fs.readdirSync(ghMaestroDir)) {
  if (ghMaestroKeep.has(entry)) continue;
  fs.rmSync(path.join(ghMaestroDir, entry), { recursive: true, force: true });
  ok(`removed legacy artifact: ${entry}`);
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

// フックが呼ぶスクリプトはすべて集約先（SHARED_SCRIPTS）の絶対パスで配線する
// （インストール時に解決し、シェル展開に依存しない）。
userSettings.hooks.UserPromptExpansion.push({
  matcher: '^gh-maestro$',
  hooks: [
    {
      type: 'command',
      command: 'node',
      args: [path.join(SHARED_SCRIPTS, 'gh-maestro-setup.js')],
      statusMessage: 'gh-maestro 前提条件チェック中...',
    },
    {
      type: 'command',
      command: 'node',
      args: [path.join(SHARED_SCRIPTS, 'reset-session.js'), '--workspace', '${CLAUDE_PROJECT_DIR}', '--quiet'],
      statusMessage: 'セッションリセット中...',
    },
    {
      type: 'command',
      command: 'node',
      args: [path.join(SHARED_SCRIPTS, 'get-context.js')],
    },
  ],
});

fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
fs.writeFileSync(userSettingsPath, JSON.stringify(userSettings, null, 2) + '\n', 'utf8');
ok(`UserPromptExpansion hook -> ${userSettingsPath}`);

// --- git pre-commit hook (core.hooksPath) を設定 ---
step('Configuring git pre-commit hook...');
// Unix では実行権限が無いと git がフックを黙ってスキップするため付与する（Windowsでは無視される）。
try { fs.chmodSync(path.join(ROOT, '.githooks', 'pre-commit'), 0o755); } catch {}
try { fs.chmodSync(path.join(ROOT, 'install.sh'),              0o755); } catch {}
const { spawnSync: spawnGit } = require('child_process');
const hookResult = spawnGit('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, encoding: 'utf8' });
if (hookResult.status === 0) {
  ok('git core.hooksPath -> .githooks (npm test runs before each commit)');
} else {
  console.log(`  \x1b[33m! git config core.hooksPath 失敗 — 手動で実行: git config core.hooksPath .githooks\x1b[0m`);
}

console.log('\ngh-maestro installed.\n');
console.log('Usage:');
console.log('  1. Open wezterm and navigate to your project root');
console.log('  2. Start claude or agy');
console.log('  3. Type: /gh-maestro\n');
