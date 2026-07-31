#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const AGENTS_YAML = path.join(SKILLS_DIR, 'agents.yaml');
// 部分テンプレート（複数スキルの SKILL.md へ {{...}} で差し込む共通本文）の置き場所。
// `_` 始まりのため skillDirs の走査対象からは除外され、スキルとしてはインストールされない。
const PARTIALS_DIR = path.join(SKILLS_DIR, '_partials');
const { validateAgentDefaults } = require(path.join(__dirname, 'shared', 'validate-agent-defaults'));
const { resolveExtends } = require(path.join(__dirname, 'shared', 'resolve-config'));
const storageLayout = require(path.join(__dirname, 'shared', 'storage-layout'));

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

// 部分テンプレート（skills/_partials/*.md）を読み込む。末尾改行は SKILL.md への差し込み時に
// 余分な空行を生むため落とす。中身の {{SCRIPTS_PATH}} 等のプレースホルダーは、差し込み後に
// applySubstitutions の複数パスで解決される。
function readPartial(name) {
  return fs.readFileSync(path.join(PARTIALS_DIR, name), 'utf8').trimEnd();
}

function stripFrontmatter(content) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

function copySkillAssets(srcSkillDir, destSkillDir, substitutions) {
  const expectedFiles = new Set(['SKILL.md']);
  const expectedDirs = new Set();
  for (const entry of fs.readdirSync(srcSkillDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      expectedDirs.add(entry.name);
      const srcSubDir = path.join(srcSkillDir, entry.name);
      const destSubDir = path.join(destSkillDir, entry.name);
      fs.mkdirSync(destSubDir, { recursive: true });
      copySkillAssets(srcSubDir, destSubDir, substitutions);
      continue;
    }
    if (!entry.isFile() || entry.name === 'SKILL.md') continue;
    if (!/\.(md|json|txt|yaml|yml)$/i.test(entry.name)) continue;
    expectedFiles.add(entry.name);
    const src = path.join(srcSkillDir, entry.name);
    const dest = path.join(destSkillDir, entry.name);
    const raw = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dest, applySubstitutions(raw, substitutions), 'utf8');
  }

  for (const entry of fs.readdirSync(destSkillDir, { withFileTypes: true })) {
    if (entry.isFile() && !expectedFiles.has(entry.name)) {
      fs.unlinkSync(path.join(destSkillDir, entry.name));
      ok(`removed stale skill asset: ${entry.name}`);
    } else if (entry.isDirectory() && !expectedDirs.has(entry.name)) {
      fs.rmSync(path.join(destSkillDir, entry.name), { recursive: true, force: true });
      ok(`removed stale skill subdir: ${entry.name}`);
    }
  }
}

function pruneStaleRecursive(srcDir, destDir, label) {
  if (!fs.existsSync(srcDir) || !fs.existsSync(destDir)) return;
  const srcNames = new Set(fs.readdirSync(srcDir));
  for (const name of fs.readdirSync(destDir)) {
    if (!srcNames.has(name)) {
      const p = path.join(destDir, name);
      fs.rmSync(p, { recursive: true, force: true });
      const display = label ? path.join(label, name) : name;
      ok(`pruned stale: ${display}`);
    } else {
      const srcChild = path.join(srcDir, name);
      const destChild = path.join(destDir, name);
      try {
        const srcStat = fs.lstatSync(srcChild);
        const destStat = fs.lstatSync(destChild);
        if (srcStat.isDirectory() && destStat.isDirectory()) {
          const childLabel = label ? path.join(label, name) : name;
          pruneStaleRecursive(srcChild, destChild, childLabel);
        } else if ((srcStat.isDirectory() && !destStat.isDirectory()) ||
                   (!srcStat.isDirectory() && destStat.isDirectory())) {
          // 型の不一致（srcがファイルでdestがディレクトリ、またはその逆）→ destを削除
          fs.rmSync(destChild, { recursive: true, force: true });
          const display = label ? path.join(label, name) : name;
          ok(`pruned type-mismatch: ${display}`);
        }
      } catch (_) { /* stat失敗時はスキップ */ }
    }
  }
}

function step(msg) { console.log(`\x1b[36m[gh-maestro-install] ${msg}\x1b[0m`); }
function ok(msg)   { console.log(`  \x1b[32mv ${msg}\x1b[0m`); }
function fail(msg) { console.error(`  \x1b[31mx ${msg}\x1b[0m`); process.exit(1); }

/**
 * agentDefaults.agents から、各エージェントIDが rulesSupported かどうかのマップを構築する。
 *
 * claude-ds/claude-ds-pro のように extends で rulesSupported を継承するエントリは、
 * 生のエントリのままだと rulesSupported が undefined になり false と誤判定される
 * （PR #170レビュー指摘）。resolveExtends で実効値にしてから判定する。
 *
 * @param {{ agents?: object[] }} agentDefaults
 * @returns {Map<string, boolean>}
 */
function buildRulesSupportedMap(agentDefaults) {
  const agentsArr = Array.isArray(agentDefaults && agentDefaults.agents) ? agentDefaults.agents : [];
  return new Map(
    agentsArr.map(a => [a.id, resolveExtends(a, agentsArr).rulesSupported === true]),
  );
}

// ── Issue #214: managed root (~/.gh-maestro/) の登録漏れ検知と legacy pids 隔離 ──

/**
 * ghMaestroPath() が組み立てようとしているトップレベル名が
 * storage-layout.js の MANAGED_TOP_LEVEL に宣言済みかを検証する。
 *
 * install.js は ~/.gh-maestro/ を「未知のトップレベルは削除する」allow-list方式で
 * 権威的に管理している。新しいトップレベル名を書くコードを追加する際、この宣言を
 * 更新し忘れると、実行時に throw して気づける（サイレントな登録漏れを防ぐ）。
 * PID registry 等の実行時状態はそもそもこの宣言に含めてはならない
 * （runtime root を使うべき。process-lifecycle.js 参照）。
 *
 * @param {string} topLevelName
 * @throws {Error} MANAGED_TOP_LEVEL に含まれない場合
 */
function assertManagedTopLevelName(topLevelName) {
  if (!storageLayout.MANAGED_TOP_LEVEL.has(topLevelName)) {
    throw new Error(
      `ghMaestroPath: "${topLevelName}" は scripts/shared/storage-layout.js の MANAGED_TOP_LEVEL に`
      + ` 宣言されていません。~/.gh-maestro/ 配下に新しいトップレベル名を書く場合は、先にそこへ`
      + ` 追加してください（実行時状態は runtime root を使うべきで、ここに追加すべきではありません）。`
    );
  }
}

/**
 * Issue #214: install.js の prune ロジックが、稼働中プロセスの PID registry
 * （本来 ~/.gh-maestro/pids に作られてはならないバグ経路の遺物）を無条件削除して
 * しまっていた事故の再発防止。
 *
 * legacyHomePidsDir（通常は ~/.gh-maestro/pids）の中身を quarantineDir
 * （runtimeRoot()/legacy-home/pids 相当）へ検証付きでコピーする。
 * 全エントリのコピーに成功した場合のみ ok:true を返す。1件でも読み込み/JSON検証/
 * 書き込みに失敗した場合は ok:false を返し、呼び出し側はそのディレクトリの削除を
 * スキップすべきである（fail-closed。ヒューリスティックな内容判定ではなく、
 * 実際のコピー成否で安全性を判定する）。
 *
 * @param {string} legacyHomePidsDir
 * @param {string} quarantineDir
 * @returns {{ ok: boolean, migrated: number, errors: string[] }}
 */
function quarantineLegacyHomePids(legacyHomePidsDir, quarantineDir) {
  if (!fs.existsSync(legacyHomePidsDir)) return { ok: true, migrated: 0, errors: [] };

  let entries;
  try {
    entries = fs.readdirSync(legacyHomePidsDir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, migrated: 0, errors: [`readdir failed: ${e.message}`] };
  }

  const errors = [];
  let migrated = 0;

  for (const entry of entries) {
    // サブディレクトリ等ファイル以外は想定外。fail-closedのため対象外として無視せず、
    // 隔離不能な内容として報告する（削除スキップの判断材料にする）。
    if (!entry.isFile()) {
      errors.push(`${entry.name}: unexpected non-file entry`);
      continue;
    }

    const srcPath = path.join(legacyHomePidsDir, entry.name);
    let content;
    try {
      content = fs.readFileSync(srcPath, 'utf8');
    } catch (e) {
      errors.push(`${entry.name}: read failed: ${e.message}`);
      continue;
    }

    // PID registry のレコードファイル（<pid>.json）は内容が有効なJSONであることを確認する。
    // start-up-lock 等の非JSONファイルはそのままコピーする。
    if (entry.name.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (e) {
        errors.push(`${entry.name}: invalid JSON: ${e.message}`);
        continue;
      }
    }

    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      fs.writeFileSync(path.join(quarantineDir, entry.name), content, 'utf8');
      migrated++;
    } catch (e) {
      errors.push(`${entry.name}: write failed: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, migrated, errors };
}

module.exports = {
  parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter, copySkillAssets, pruneStaleRecursive,
  buildRulesSupportedMap, assertManagedTopLevelName, quarantineLegacyHomePids,
};

if (require.main !== module) return;

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Branch guard: WIPブランチからの実行を防止 ──────────────────────────────────
// install.js は ~/.gh-maestro/ 共有ディレクトリを書き換えるため、
// 未レビュー・未マージのWIPブランチからの実行は機械的に拒否する。
// --force で明示的に許可可能。
const forceFlag = process.argv.includes('--force');
try {
  const { execFileSync: execGit } = require('child_process');
  const currentBranch = execGit('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const PROTECTED_BRANCHES = new Set(['dev', 'main']);
  if (!PROTECTED_BRANCHES.has(currentBranch) && !forceFlag) {
    console.error(`\x1b[31m[gh-maestro-install] エラー: 現在のブランチ "${currentBranch}" は保護ブランチではありません。`);
    console.error(`  WIPブランチからの install.js 実行は ~/.gh-maestro/ 共有ディレクトリを`);
    console.error(`  未レビュー・未マージのコードで上書きする恐れがあります。`);
    console.error(`  dev または main ブランチで実行するか、--force フラグを付けて強行してください。`);
    process.exit(1);
  }
  if (!PROTECTED_BRANCHES.has(currentBranch) && forceFlag) {
    console.warn(`  \x1b[33m! --force によりブランチ "${currentBranch}" からの実行を許可します\x1b[0m`);
  }
} catch (e) {
  // git が使えないなどブランチ確認不能な場合、安全側に倒して中断する。
  // 警告で続行すると WIP ブランチからの誤実行を防げない（fail-open）。
  if (!forceFlag) {
    console.error(`\x1b[31m[gh-maestro-install] エラー: git branch --show-current に失敗しました。`);
    console.error(`  ブランチ確認ができないため、安全のため中断します。`);
    console.error(`  どうしても実行する場合は --force を付けてください。`);
    console.error(`  エラー詳細: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
  console.warn(`  \x1b[33m! --force によりブランチ確認失敗を無視して続行します（${e.message.split('\n')[0]}）\x1b[0m`);
}

if (!fs.existsSync(AGENTS_YAML)) fail('skills/agents.yaml not found');
const agents = parseAgentsYaml(fs.readFileSync(AGENTS_YAML, 'utf8'));

const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith('_'))  // `_partials` 等の部分テンプレート置き場を除外
  .map(e => e.name);

// agent-defaults.json を読み込み、rulesSupported フラグのマップを構築する
const defaultsPath = path.join(ROOT, 'scripts', 'agent-defaults.json');
let agentDefaults = { agents: [] };
try {
  const parsed = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  if (parsed && Array.isArray(parsed.agents)) {
    agentDefaults = parsed;
  } else {
    console.warn(`  \x1b[33m! agent-defaults.json の agents フィールドが配列ではありません。rulesSupported 判定をスキップします\x1b[0m`);
  }
} catch (e) {
  console.warn(`  \x1b[33m! agent-defaults.json の読み込みに失敗しました: ${e.message}。rulesSupported 判定をスキップします\x1b[0m`);
}
const rulesSupportedMap = buildRulesSupportedMap(agentDefaults);

// agent-defaults.json の内容を検証する。エラーがあれば fail-closed で中断する
// （fail-closed-safety-guards: 安全と確認できない場合は中断）。
const defaultsIssues = validateAgentDefaults(agentDefaults);
const defaultsErrors = defaultsIssues.filter(i => i.startsWith('[ERROR]'));
if (defaultsErrors.length > 0) {
  console.error(`\x1b[31m[gh-maestro-install] agent-defaults.json にエラーがあります:\x1b[0m`);
  for (const err of defaultsErrors) console.error(`  ${err}`);
  process.exit(1);
}
const defaultsWarnings = defaultsIssues.filter(i => i.startsWith('[WARN]'));
for (const w of defaultsWarnings) console.warn(`  \x1b[33m! ${w}\x1b[0m`);

// スキル本文へ差し込む共通部分テンプレート（本文は skills/_partials/*.md が正本）。
// 指示文というコンテンツをスクリプト内の文字列リテラルに埋め込まず、編集しやすい .md に置く。
// RULES_CHECK_STEP は rulesSupported が false のエージェントにのみ注入される。
const RULES_CHECK_STEP_CONTENT = readPartial('rules-check-step.md');
const COMMUNICATION_RULES_CONTENT = readPartial('communication-rules.md');

// ~/.gh-maestro/ は gh-maestro 専用ディレクトリ。install が書いたものだけを残し、
// それ以外（旧バージョンの遺産）は最後に prune で除去する。
// 「書いた＝残す」を保証するため、ここ配下のパスは必ず ghMaestroPath() で組み立てる。
// パスを作る行為がそのままトップレベル名を keep に記録するので、登録し忘れる余地が無い。
const ghMaestroDir = expandHome('~/.gh-maestro');
const ghMaestroKeep = new Set();
function ghMaestroPath(...segs) {
  // Issue #214: 未宣言のトップレベル名（登録漏れ・実行時状態の誤混入）を早期に検知する。
  assertManagedTopLevelName(segs[0]);
  ghMaestroKeep.add(segs[0]);
  return path.join(ghMaestroDir, ...segs);
}

// 全スクリプト（CLI・モジュール）を集約する単一ディレクトリ。
// SKILL.md からは {{SCRIPTS_PATH}} がこの絶対パスに置換されて参照される。
const SHARED_SCRIPTS = ghMaestroPath('scripts');
const SHARED_SKILLS = ghMaestroPath('skills');

// ── 各エージェントのスキルディレクトリに SKILL.md のみを配置 ──────────────────
// スクリプトはスキルdirには置かず、すべて SHARED_SCRIPTS に集約する（下の共有install参照）。

for (const [agentName, config] of Object.entries(agents)) {
  const dest = expandHome(config.dest);
  step(`Installing skills for ${agentName}...`);
  fs.mkdirSync(dest, { recursive: true });

  // リポジトリに存在しない stale スキルディレクトリ・ファイルを削除する
  if (fs.existsSync(dest)) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (entry.isDirectory() && !skillDirs.includes(entry.name)) {
        fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
        ok(`removed stale skill: ${entry.name}`);
      } else if (entry.isFile()) {
        fs.unlinkSync(path.join(dest, entry.name));
        ok(`removed stray file in agent skills: ${entry.name} (${agentName})`);
      }
    }
  }

  // {{SCRIPTS_PATH}} は集約先（SHARED_SCRIPTS）の絶対パスに統一する
  const agentRulesSupported = rulesSupportedMap.get(agentName) !== false;
  const substitutions = Object.assign({}, config.substitutions, {
    SCRIPTS_PATH: SHARED_SCRIPTS,
    SHARED_SKILLS_PATH: SHARED_SKILLS,
    RULES_CHECK_STEP: agentRulesSupported ? '' : RULES_CHECK_STEP_CONTENT,
    COMMUNICATION_RULES: COMMUNICATION_RULES_CONTENT,
  });

  for (const skill of skillDirs) {
    const templatePath = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(templatePath)) continue;

    const destSkill = path.join(dest, skill);
    fs.mkdirSync(destSkill, { recursive: true });

    const template = fs.readFileSync(templatePath, 'utf8');
    const content = applySubstitutions(template, substitutions);
    fs.writeFileSync(path.join(destSkill, 'SKILL.md'), content, 'utf8');
    copySkillAssets(path.join(SKILLS_DIR, skill), destSkill, substitutions);

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
const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
const scriptFiles = entries
  .filter(e => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.md') || e.name.endsWith('.json')) && !INSTALL_EXCLUDE.has(e.name))
  .map(e => e.name);
// サブディレクトリ（scripts/shared/ 等）も 1:1 でミラーする。
// これがないと shared/ を require するスクリプト（msg-send.js 等）が配布先で MODULE_NOT_FOUND になる。
const scriptSubdirs = entries.filter(e => e.isDirectory()).map(e => e.name);

// stale 削除: scripts/ に無いファイル・ディレクトリを集約先から除去する
const expectedFiles = new Set(scriptFiles);
const expectedDirs = new Set(scriptSubdirs);
for (const entry of fs.readdirSync(SHARED_SCRIPTS, { withFileTypes: true })) {
  const p = path.join(SHARED_SCRIPTS, entry.name);
  if (entry.isFile() && !expectedFiles.has(entry.name)) {
    fs.unlinkSync(p);
    ok(`removed stale script: ${entry.name}`);
  } else if (entry.isDirectory() && !expectedDirs.has(entry.name)) {
    fs.rmSync(p, { recursive: true, force: true });
    ok(`removed stale script dir: ${entry.name}`);
  }
}
for (const f of scriptFiles) {
  fs.copyFileSync(path.join(scriptsDir, f), path.join(SHARED_SCRIPTS, f));
}
for (const d of scriptSubdirs) {
  const destSubdir = path.join(SHARED_SCRIPTS, d);
  // 型不一致（旧バージョンではファイル→新バージョンではディレクトリ、またはその逆）による
  // fs.cpSync の ENOENT クラッシュを防ぐため、コピー先サブディレクトリを事前に除去する。
  if (fs.existsSync(destSubdir)) {
    fs.rmSync(destSubdir, { recursive: true, force: true });
  }
  fs.cpSync(path.join(scriptsDir, d), destSubdir, { recursive: true });
}
ok(`${scriptFiles.length} scripts + ${scriptSubdirs.length} subdir(s) -> ${SHARED_SCRIPTS}`);

// ── 共有スキルを ~/.gh-maestro/skills/ にデプロイ ─────────────────────────────
// 全エージェントがそれぞれのネイティブなスキル発見機構（skill_files_install_destination_directory）
// 経由でSKILL.mdを読む方式に統一済み（reasonixも含む。agents.yaml参照）。
// ここで作る共有コピーは、orchestrator専用の非SKILL.mdアセット（issue-template.md等）を
// 配布するためのものであり、orchestratorは常にClaude Code自身で動くため、置換にはclaude用
// substitutionsを使う。
step('Installing shared skill files into ~/.gh-maestro/skills/...');
fs.mkdirSync(SHARED_SKILLS, { recursive: true });

const canonicalAgent = agents['claude'] || agents[Object.keys(agents)[0]];
const sharedSubstitutions = Object.assign({}, canonicalAgent?.substitutions ?? {}, {
  SCRIPTS_PATH: SHARED_SCRIPTS,
  SHARED_SKILLS_PATH: SHARED_SKILLS,
  RULES_CHECK_STEP: '',
  COMMUNICATION_RULES: COMMUNICATION_RULES_CONTENT,
});

// stale 削除（ディレクトリと未知ファイルの両方）
for (const entry of fs.readdirSync(SHARED_SKILLS, { withFileTypes: true })) {
  if (entry.isDirectory() && !skillDirs.includes(entry.name)) {
    fs.rmSync(path.join(SHARED_SKILLS, entry.name), { recursive: true, force: true });
    ok(`removed stale shared skill: ${entry.name}`);
  } else if (entry.isFile()) {
    fs.unlinkSync(path.join(SHARED_SKILLS, entry.name));
    ok(`removed stray file in shared skills: ${entry.name}`);
  }
}
for (const skill of skillDirs) {
  const templatePath = path.join(SKILLS_DIR, skill, 'SKILL.md');
  if (!fs.existsSync(templatePath)) continue;
  const destSkillDir = path.join(SHARED_SKILLS, skill);
  fs.mkdirSync(destSkillDir, { recursive: true });
  const template = fs.readFileSync(templatePath, 'utf8');
  fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), applySubstitutions(template, sharedSubstitutions), 'utf8');
  copySkillAssets(path.join(SKILLS_DIR, skill), destSkillDir, sharedSubstitutions);
  ok(`${skill} -> ${destSkillDir} (shared)`);
}

// ── agents.json → config.json 移行 ──────────────────────────────────────────────
// エージェント設定のSSOTは scripts/agent-defaults.json に移行した（Issue #41）。
// 既存の ~/.gh-maestro/agents.json にデフォルトと異なるカスタムエントリがあれば、
// ~/.gh-maestro/config.json の agents override に一度だけ変換する。
// ユーザーファイルには差分のみ書き、デフォルトをコピーしない（設計原則 #1）。
// agentsConfigPath は ghMaestroPath ではなく path.join で組み立てる。
// ghMaestroPath を使うと prune 対象外（keep）になってしまい、移行後に残骸が残るため。
step('Checking for legacy agents.json migration...');
const agentsConfigPath = path.join(ghMaestroDir, 'agents.json');
const configJsonPath = ghMaestroPath('config.json');

if (fs.existsSync(agentsConfigPath)) {
  let legacyAgents = [];
  try {
    legacyAgents = JSON.parse(fs.readFileSync(agentsConfigPath, 'utf8'));
    if (!Array.isArray(legacyAgents)) { legacyAgents = []; ghMaestroPath("agents.json"); }
  } catch {
    ok('agents.json parse failed — skipping migration, preserving file');
    ghMaestroPath('agents.json');
    legacyAgents = [];
  }

  if (legacyAgents.length > 0) {
    // agent-defaults.json からデフォルト値を読み込む
    const defaultsPath = path.join(ROOT, 'scripts', 'agent-defaults.json');
    let defaultsData = { agents: [] };
    try {
      defaultsData = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    } catch {
      ok('agent-defaults.json not found — skipping migration');
    }

    const defaultMap = new Map(defaultsData.agents.map(a => [a.id, a]));

    // デフォルトと異なるフィールドのみを抽出
    const agentOverrides = {};
    let migratedCount = 0;

    for (const userAgent of legacyAgents) {
      const defaultAgent = defaultMap.get(userAgent.id);
      if (!defaultAgent) {
        // デフォルトに無いカスタムエージェント — 全体を保存
        const { id, ...rest } = userAgent;
        agentOverrides[id] = rest;
        migratedCount++;
        continue;
      }

      // デフォルトと異なるフィールドを抽出
      const diff = {};
      for (const [key, value] of Object.entries(userAgent)) {
        if (key === 'id') continue;
        // デフォルトに存在しないフィールドはカスタム追加として保存
        if (!(key in defaultAgent)) {
          diff[key] = value;
          continue;
        }
        // 値が異なる場合のみ保存
        if (JSON.stringify(value) !== JSON.stringify(defaultAgent[key])) {
          diff[key] = value;
        }
      }

      if (Object.keys(diff).length > 0) {
        agentOverrides[userAgent.id] = diff;
        migratedCount++;
      }
    }

    if (migratedCount > 0) {
      // 既存の config.json を読み込み、agents セクションをマージ
      let existingConfig = {};
      if (fs.existsSync(configJsonPath)) {
        try {
          existingConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
          if (typeof existingConfig !== 'object' || existingConfig === null || Array.isArray(existingConfig)) {
            existingConfig = {};
          }
        } catch {
          existingConfig = {};
        }
      }

      existingConfig.agents = { ...agentOverrides, ...(existingConfig.agents || {}) };
      fs.writeFileSync(configJsonPath, JSON.stringify(existingConfig, null, 2) + '\n', 'utf8');
      ok(`agents.json → config.json: ${migratedCount} agent override(s) migrated`);
    } else {
      ok('agents.json has no customizations — config.json not created (defaults are in agent-defaults.json)');
    }
  } else {
    ok('agents.json is empty — nothing to migrate');
  }
} else {
  ok('No legacy agents.json — nothing to migrate');
}

// ── Issue #214: legacy PID registry の隔離（prune より必ず先に実行） ────────────
// ~/.gh-maestro/pids は、workspace がホームディレクトリに誤解決された場合に
// process-lifecycle.js が作ってしまうバグ経路の遺物であり、稼働中プロセスの
// 生存判定に使われている可能性がある。中身を検証せずに prune で無条件削除すると
// sweep の誤判定・誤killを招く（Issue #214 本体）。
// 全エントリの隔離コピーに成功した場合のみ、通常の prune によるディレクトリ削除を許可する。
// 1件でも失敗した場合は fail-closed でこのエントリの削除だけをスキップする
// （ヒューリスティックな内容判定ではなく、実際のコピー成否で判定する）。
step('Quarantining legacy home PID registry (Issue #214) before prune...');
const legacyHomePidsDir = path.join(ghMaestroDir, 'pids');
const prunePathSkip = new Set();
if (fs.existsSync(legacyHomePidsDir)) {
  const quarantineDir = path.join(storageLayout.runtimeRoot(), 'legacy-home', 'pids');
  const quarantineResult = quarantineLegacyHomePids(legacyHomePidsDir, quarantineDir);
  if (quarantineResult.ok) {
    ok(`quarantined ${quarantineResult.migrated} legacy pids entrie(s) -> ${quarantineDir}`);
  } else {
    prunePathSkip.add('pids');
    console.warn(`  \x1b[33m! ~/.gh-maestro/pids の隔離に失敗したエントリがあるため、削除をスキップします（fail-closed）:\x1b[0m`);
    for (const e of quarantineResult.errors) console.warn(`    ${e}`);
  }
} else {
  ok('No legacy ~/.gh-maestro/pids found — nothing to quarantine');
}

// ── ~/.gh-maestro/ を権威的に管理する ─────────────────────────────────────────
// install がこの実行中に書いたトップレベル名（ghMaestroKeep）だけを残し、それ以外
// （旧バージョンの遺産: workflows/ ・.claude/ ・GH_MAESTRO_REF ・廃止済み review-policy.md 等）
// を除去する。keep リストは ghMaestroPath() がパス生成時に自動記録するので、手書きの
// 管理対象リストは存在せず、登録し忘れによるサイレント削除が起きない
// （ghMaestroPath() 自体も MANAGED_TOP_LEVEL 宣言と照合するため、二重にチェックされる）。
step('Pruning ~/.gh-maestro/ of unmanaged legacy artifacts...');
for (const entry of fs.readdirSync(ghMaestroDir)) {
  if (ghMaestroKeep.has(entry)) continue;
  if (prunePathSkip.has(entry)) {
    console.warn(`  \x1b[33m! skipping deletion of "${entry}" (quarantine failed above, fail-closed)\x1b[0m`);
    continue;
  }
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
