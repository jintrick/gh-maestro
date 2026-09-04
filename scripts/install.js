#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const AGENTS_YAML = path.join(SKILLS_DIR, 'agents.yaml');
// 部分テンプレート（複数スキルの SKILL.md へ {{...}} で差し込む共通本文）の置き場所。
// `_` 始まりのため skillDirs の走査対象からは除外され、スキルとしてはインストールされない。
const PARTIALS_DIR = path.join(SKILLS_DIR, '_partials');
const { validateAgentDefaults } = require(path.join(__dirname, 'shared', 'validate-agent-defaults'));
const { resolveExtends } = require(path.join(__dirname, 'shared', 'resolve-config'));
const storageLayout = require(path.join(__dirname, 'shared', 'storage-layout'));
const { parseAgentsYaml, expandHome } = require(path.join(__dirname, 'shared', 'agents-yaml'));
const { getCurrentBranch } = require(path.join(__dirname, 'shared', 'git-branch'));
const { resolveWorkspace } = require(path.join(__dirname, 'shared', 'workspace'));

// ── Utilities ─────────────────────────────────────────────────────────────────

function applySubstitutions(content, substitutions) {
  let result = content;
  let prev;
  do {
    prev = result;
    for (const [key, value] of Object.entries(substitutions)) {
      // replaceAll の第2引数が文字列だと $&/$`/$'/$$ 等を特殊置換パターンとして解釈してしまう
      // （検索側が正規表現でなくても働く仕様）。置換値をそのまま返す関数形式にして無効化する。
      result = result.replaceAll(`{{${key}}}`, () => value);
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

/**
 * 各エージェントのスキルディレクトリに SKILL.md およびアセットを配置する。
 * @param {object} agents parseAgentsYaml() の戻り値
 * @param {object} [options]
 * @param {string} [options.skillsDir] スキル原本ディレクトリ（既定: SKILLS_DIR）
 * @param {string} [options.sharedScripts] 共有スクリプトパス（既定: SHARED_SCRIPTS）
 * @param {string} [options.sharedSkills] 共有スキルパス（既定: SHARED_SKILLS）
 * @param {Map} [options.rulesSupportedMap]
 * @param {function} [options.step] ログ用 step 関数
 * @param {function} [options.ok] ログ用 ok 関数
 */
function installSkills(agents, options = {}) {
  const skillsDir = options.skillsDir || SKILLS_DIR;
  const sharedScripts = options.sharedScripts || SHARED_SCRIPTS;
  const sharedSkills = options.sharedSkills || SHARED_SKILLS;
  const rulesMap = options.rulesSupportedMap || new Map();
  const logStep = options.step || step;
  const logOk = options.ok || ok;

  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('_'))
    .map(e => e.name);

  const RULES_CHECK_STEP_CONTENT = readPartial('rules-check-step.md');
  const COMMUNICATION_RULES_CONTENT = readPartial('communication-rules.md');
  const CODER_WORKFLOW_CONTENT = readPartial('coder-workflow.md');
  const COMMENTS_AND_NAMING_CONTENT = readPartial('comments-and-naming.md');

  for (const [agentName, config] of Object.entries(agents)) {
    const destList = (config.dests && config.dests.length > 0)
      ? config.dests
      : (config.dest ? [config.dest] : []);

    for (const rawDest of destList) {
      const dest = expandHome(rawDest);
      logStep(`Installing skills for ${agentName} (${dest})...`);
      fs.mkdirSync(dest, { recursive: true });

      // リポジトリに存在しない stale スキルディレクトリ・ファイルを削除する
      if (fs.existsSync(dest)) {
        for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
          if (entry.isDirectory() && !skillDirs.includes(entry.name)) {
            fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
            logOk(`removed stale skill: ${entry.name}`);
          } else if (entry.isFile()) {
            fs.unlinkSync(path.join(dest, entry.name));
            logOk(`removed stray file in agent skills: ${entry.name} (${agentName})`);
          }
        }
      }

      // {{SCRIPTS_PATH}} は集約先の絶対パスに統一する
      const agentRulesSupported = rulesMap.get(agentName) !== false;
      const substitutions = Object.assign({}, config.substitutions, {
        SCRIPTS_PATH: sharedScripts,
        SHARED_SKILLS_PATH: sharedSkills,
        RULES_CHECK_STEP: agentRulesSupported ? '' : RULES_CHECK_STEP_CONTENT,
        COMMUNICATION_RULES: COMMUNICATION_RULES_CONTENT,
        CODER_WORKFLOW: CODER_WORKFLOW_CONTENT,
        COMMENTS_AND_NAMING: COMMENTS_AND_NAMING_CONTENT,
      });

      for (const skill of skillDirs) {
        const templatePath = path.join(skillsDir, skill, 'SKILL.md');
        if (!fs.existsSync(templatePath)) continue;

        const destSkill = path.join(dest, skill);
        fs.mkdirSync(destSkill, { recursive: true });

        const template = fs.readFileSync(templatePath, 'utf8');
        const content = applySubstitutions(template, substitutions);
        fs.writeFileSync(path.join(destSkill, 'SKILL.md'), content, 'utf8');
        copySkillAssets(path.join(skillsDir, skill), destSkill, substitutions);

        // 旧バージョンが配置していた per-skill の scripts/ を stale として削除する
        const staleScripts = path.join(destSkill, 'scripts');
        if (fs.existsSync(staleScripts)) {
          fs.rmSync(staleScripts, { recursive: true, force: true });
          logOk(`removed stale per-skill scripts: ${path.join(skill, 'scripts')}`);
        }

        logOk(`${skill} -> ${destSkill}`);
      }
    }
  }
}

/**
 * scripts/ を集約先ディレクトリにミラーし、agents.yaml もコピーする。
 * @param {object} [options]
 * @param {string} [options.scriptsDir] スキル原本ディレクトリ（既定: scripts/）
 * @param {string} [options.sharedScripts] 集約先スクリプトディレクトリ（既定: SHARED_SCRIPTS）
 * @param {string} [options.agentsYaml] agents.yaml パス（既定: skills/agents.yaml）
 * @param {function} [options.step] ログ用 step 関数
 * @param {function} [options.ok] ログ用 ok 関数
 */
function installScripts(options = {}) {
  const srcDir = options.scriptsDir || path.join(ROOT, 'scripts');
  const destDir = options.sharedScripts || SHARED_SCRIPTS;
  const agentsYamlPath = options.agentsYaml || AGENTS_YAML;
  const logStep = options.step || step;
  const logOk = options.ok || ok;

  logStep('Installing all scripts into the shared directory...');
  fs.mkdirSync(destDir, { recursive: true });

  const INSTALL_EXCLUDE = new Set(['install.js']);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  const scriptFiles = entries
    .filter(e => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.md') || e.name.endsWith('.json')) && !INSTALL_EXCLUDE.has(e.name))
    .map(e => e.name);
  // サブディレクトリ（scripts/shared/ 等）も 1:1 でミラーする。
  // これがないと shared/ を require するスクリプト（msg-send.js 等）が配布先で MODULE_NOT_FOUND になる。
  const scriptSubdirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  // stale 削除: scripts/ に無いファイル・ディレクトリを集約先から除去する
  // 'agents.yaml' は scripts/ 配下ではなく skills/agents.yaml からの配布分（下記参照）のため、
  // scriptFiles の走査には含まれないが stale 削除対象からは除外する必要がある。
  const expectedFiles = new Set([...scriptFiles, 'agents.yaml']);
  const expectedDirs = new Set(scriptSubdirs);
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    const p = path.join(destDir, entry.name);
    if (entry.isFile() && !expectedFiles.has(entry.name)) {
      fs.unlinkSync(p);
      logOk(`removed stale script: ${entry.name}`);
    } else if (entry.isDirectory() && !expectedDirs.has(entry.name)) {
      fs.rmSync(p, { recursive: true, force: true });
      logOk(`removed stale script dir: ${entry.name}`);
    }
  }
  for (const f of scriptFiles) {
    fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  }
  for (const d of scriptSubdirs) {
    const destSubdir = path.join(destDir, d);
    // 型不一致（旧バージョンではファイル→新バージョンではディレクトリ、またはその逆）による
    // fs.cpSync の ENOENT クラッシュを防ぐため、コピー先サブディレクトリを事前に除去する。
    if (fs.existsSync(destSubdir)) {
      fs.rmSync(destSubdir, { recursive: true, force: true });
    }
    fs.cpSync(path.join(srcDir, d), destSubdir, { recursive: true });
  }
  logOk(`${scriptFiles.length} scripts + ${scriptSubdirs.length} subdir(s) -> ${destDir}`);

  // skills/agents.yaml も SHARED_SCRIPTS に配布する（単純コピー、値の変換・再計算はしない）。
  // spawn-assistant.js 等ランタイム側が「agentIdに対応するSKILL.mdの実インストール先」を実行時に
  // 解決するために必要（skills/agents.yaml 自体は従来 install.js 実行時にしか読まれず、
  // ~/.gh-maestro/ 配下には一切配布されていなかった）。SSOTは引き続き skills/agents.yaml。
  if (fs.existsSync(agentsYamlPath)) {
    fs.copyFileSync(agentsYamlPath, path.join(destDir, 'agents.yaml'));
    logOk(`agents.yaml -> ${path.join(destDir, 'agents.yaml')}`);
  }
}

/**
 * 共有スキルを共有ディレクトリ（~/.gh-maestro/skills/）にデプロイする。
 * @param {object} agents parseAgentsYaml() の戻り値
 * @param {object} [options]
 * @param {string} [options.skillsDir] スキル原本ディレクトリ（既定: SKILLS_DIR）
 * @param {string} [options.sharedSkills] 共有スキルディレクトリ（既定: SHARED_SKILLS）
 * @param {string} [options.sharedScripts] 共有スクリプトパス（既定: SHARED_SCRIPTS）
 * @param {function} [options.step] ログ用 step 関数
 * @param {function} [options.ok] ログ用 ok 関数
 */
function installSharedSkills(agents, options = {}) {
  const skillsDir = options.skillsDir || SKILLS_DIR;
  const sharedSkills = options.sharedSkills || SHARED_SKILLS;
  const sharedScripts = options.sharedScripts || SHARED_SCRIPTS;
  const logStep = options.step || step;
  const logOk = options.ok || ok;

  logStep('Installing shared skill files into ~/.gh-maestro/skills/...');
  fs.mkdirSync(sharedSkills, { recursive: true });

  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('_'))
    .map(e => e.name);

  const COMMUNICATION_RULES_CONTENT = readPartial('communication-rules.md');
  const CODER_WORKFLOW_CONTENT = readPartial('coder-workflow.md');
  const COMMENTS_AND_NAMING_CONTENT = readPartial('comments-and-naming.md');

  const canonicalAgent = agents && (agents['claude'] || agents[Object.keys(agents)[0]]);
  const sharedSubstitutions = Object.assign({}, canonicalAgent?.substitutions ?? {}, {
    SCRIPTS_PATH: sharedScripts,
    SHARED_SKILLS_PATH: sharedSkills,
    RULES_CHECK_STEP: '',
    COMMUNICATION_RULES: COMMUNICATION_RULES_CONTENT,
    CODER_WORKFLOW: CODER_WORKFLOW_CONTENT,
    COMMENTS_AND_NAMING: COMMENTS_AND_NAMING_CONTENT,
  });

  // stale 削除（ディレクトリと未知ファイルの両方）
  for (const entry of fs.readdirSync(sharedSkills, { withFileTypes: true })) {
    if (entry.isDirectory() && !skillDirs.includes(entry.name)) {
      fs.rmSync(path.join(sharedSkills, entry.name), { recursive: true, force: true });
      logOk(`removed stale shared skill: ${entry.name}`);
    } else if (entry.isFile()) {
      fs.unlinkSync(path.join(sharedSkills, entry.name));
      logOk(`removed stray file in shared skills: ${entry.name}`);
    }
  }
  for (const skill of skillDirs) {
    const templatePath = path.join(skillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(templatePath)) continue;
    const destSkillDir = path.join(sharedSkills, skill);
    fs.mkdirSync(destSkillDir, { recursive: true });
    const template = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), applySubstitutions(template, sharedSubstitutions), 'utf8');
    copySkillAssets(path.join(skillsDir, skill), destSkillDir, sharedSubstitutions);
    logOk(`${skill} -> ${destSkillDir} (shared)`);
  }
}

/**
 * install後に、配布済みのrestart-residents.jsで常駐プロセスを現行コードへ入れ替える。
 *
 * install.jsはgh-maestroリポジトリから実行される一方、常駐プロセスのregistryは
 * 実ワークスペースごとに管理される。runtime rootの記録から対象をすべて列挙し、
 * installで更新した共有スクリプト側のCLIをworkspaceごとに呼び出す。各CLIの
 * stdout/stderrはinstallの出力へそのまま届ける。
 * 呼び出し元workspaceにMONITOR_REATTACH_REQUIREDが出た場合はcallerReattachLinesに
 * 収集し、install.jsの末尾で再掲できるようにする。
 *
 * @param {object} [options]
 * @param {string[]} [options.workspaces] テスト用のworkspace一覧
 * @param {string} [options.sharedScripts] 配布済みスクリプトディレクトリ
 * @param {string|null} [options.callerWorkspace] 呼び出し元workspace（既定: resolveWorkspace()）
 * @param {Function} [options.resolveWorkspace] workspace解決関数
 * @param {Function} [options.listRegisteredWorkspaces] workspace列挙関数
 * @param {Function} [options.workspaceExists] workspaceが現存ディレクトリかの判定関数
 * @param {Function} [options.execFileSync] CLI実行関数
 * @param {Function} [options.onWorkspace] workspaceごとの実行前通知
 * @param {object} [options.stdout] 出力先Stream（既定: process.stdout）
 * @returns {{attempted: boolean, code: number, workspaces: string[], results?: object[], scriptPath?: string, callerWorkspace?: string|null, callerReattachLines?: string[], error?: Error}}
 */
function restartResidentsAfterInstall(options = {}) {
  let workspaces;
  try {
    workspaces = Object.prototype.hasOwnProperty.call(options, 'workspaces')
      ? options.workspaces
      : (options.listRegisteredWorkspaces || storageLayout.listRegisteredWorkspaces)();
  } catch (error) {
    return { attempted: false, code: 1, workspaces: [], error };
  }

  if (!Array.isArray(workspaces) || workspaces.some((workspace) => typeof workspace !== 'string' || !workspace)) {
    return {
      attempted: false,
      code: 1,
      workspaces: [],
      error: new Error('workspace registryから不正なworkspace一覧が返されました'),
    };
  }

  const uniqueWorkspaces = [...new Set(workspaces)];
  const workspaceExists = options.workspaceExists || storageLayout.isExistingWorkspaceDirectory;
  if (typeof workspaceExists !== 'function') {
    return {
      attempted: false,
      code: 1,
      workspaces: [],
      error: new Error('workspaceの存在確認関数が不正です'),
    };
  }

  const existingWorkspaces = [];
  try {
    for (const workspace of uniqueWorkspaces) {
      const exists = workspaceExists(workspace);
      if (typeof exists !== 'boolean') {
        throw new Error(`workspaceの存在確認関数がbooleanを返しません: ${workspace}`);
      }
      if (exists) existingWorkspaces.push(workspace);
    }
  } catch (error) {
    return { attempted: false, code: 1, workspaces: [], error };
  }

  if (existingWorkspaces.length === 0) {
    return { attempted: false, code: 0, workspaces: [], callerReattachLines: [] };
  }

  let callerWorkspace;
  if (Object.prototype.hasOwnProperty.call(options, 'callerWorkspace')) {
    callerWorkspace = options.callerWorkspace;
  } else {
    try {
      const resolver = options.resolveWorkspace || resolveWorkspace;
      callerWorkspace = resolver();
    } catch {
      callerWorkspace = null;
    }
  }

  let canonicalCaller = null;
  if (callerWorkspace && typeof callerWorkspace === 'string') {
    try {
      canonicalCaller = storageLayout.canonicalWorkspace(callerWorkspace);
    } catch {
      canonicalCaller = null;
    }
  }

  const scriptsPath = options.sharedScripts || SHARED_SCRIPTS;
  const scriptPath = path.join(scriptsPath, 'restart-residents.js');
  const run = options.execFileSync || execFileSync;
  const results = [];
  let code = 0;
  const callerReattachLines = [];
  const outStream = options.stdout || (typeof process !== 'undefined' ? process.stdout : null);

  for (const workspace of existingWorkspaces) {
    if (typeof options.onWorkspace === 'function') options.onWorkspace(workspace);
    const isCaller = Boolean(canonicalCaller && storageLayout.canonicalWorkspace(workspace) === canonicalCaller);
    let output = '';
    try {
      const runResult = run(process.execPath, [scriptPath, '--workspace', workspace], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
      });
      if (typeof runResult === 'string') {
        output = runResult;
        if (outStream && typeof outStream.write === 'function') {
          outStream.write(output);
        }
      } else if (Buffer.isBuffer(runResult)) {
        output = runResult.toString('utf8');
        if (outStream && typeof outStream.write === 'function') {
          outStream.write(output);
        }
      }
      results.push({ workspace, code: 0 });
    } catch (error) {
      const workspaceCode = Number.isInteger(error && error.status) && error.status !== 0
        ? error.status
        : 1;
      if (code === 0) code = workspaceCode;
      if (typeof error.stdout === 'string') {
        output = error.stdout;
        if (outStream && typeof outStream.write === 'function') {
          outStream.write(output);
        }
      } else if (Buffer.isBuffer(error.stdout)) {
        output = error.stdout.toString('utf8');
        if (outStream && typeof outStream.write === 'function') {
          outStream.write(output);
        }
      }
      results.push({ workspace, code: workspaceCode, error });
    }

    if (isCaller && output) {
      const matches = output.match(/^MONITOR_REATTACH_REQUIRED\s+.+$/gm);
      if (matches) {
        callerReattachLines.push(...matches.map((m) => m.trim()));
      }
    }
  }
  return {
    attempted: true,
    code,
    workspaces: existingWorkspaces,
    results,
    scriptPath,
    callerWorkspace,
    callerReattachLines,
  };
}

/**
 * install完了メッセージおよび呼び出し元workspaceのMONITOR_REATTACH_REQUIRED再掲を出力する。
 *
 * @param {object} [residentRestart] restartResidentsAfterInstallの戻り値
 * @param {object|Function} [options] 出力オプションまたはlog関数
 */
function printInstallCompletion(residentRestart = {}, options = {}) {
  const log = typeof options === 'function'
    ? options
    : (options.log || console.log);
  const callerReattachLines = Array.isArray(residentRestart)
    ? residentRestart
    : (residentRestart && residentRestart.callerReattachLines) || [];

  log('\ngh-maestro installed.\n');
  log('Usage:');
  log('  1. Open wezterm and navigate to your project root');
  log('  2. Start claude or agy');
  log('  3. Type: /gh-maestro\n');

  if (callerReattachLines.length > 0) {
    for (const line of callerReattachLines) {
      log(line);
    }
  }
}

/**
 * /gh-maestro の UserPromptExpansion matcher に登録する単一handlerを構築する。
 *
 * Claude Code は一致するhandlerを並列実行するため、setup・reset・get-contextを
 * 個別に登録せず、順序制御を担う共有エントリポイントだけを登録する。
 * @param {string} sharedScripts 配布済み共有スクリプトの絶対パス
 * @returns {object} UserPromptExpansionのmatcher group
 */
function buildUserPromptExpansionHook(sharedScripts) {
  return {
    matcher: '^gh-maestro$',
    hooks: [
      {
        type: 'command',
        command: 'node',
        args: [
          path.join(sharedScripts, 'gh-maestro-session-hook.js'),
          '--workspace',
          '${CLAUDE_PROJECT_DIR}',
        ],
        statusMessage: 'gh-maestro セッション初期化中...',
      },
    ],
  };
}

/**
 * ~/.claude/settings.json（またはテスト用に指定されたsettings path）へ、
 * /gh-maestro のUserPromptExpansion handlerを冪等に登録する。
 * @param {object} [options]
 * @param {string} [options.settingsPath] settings.jsonのパス
 * @param {string} [options.sharedScripts] 配布済み共有スクリプトのパス
 * @param {function} [options.step] ログ用step関数
 * @param {function} [options.ok] ログ用ok関数
 * @returns {{settingsPath:string, settings:object, hook:object}}
 */
function registerUserPromptExpansionHook(options = {}) {
  const settingsPath = options.settingsPath || expandHome('~/.claude/settings.json');
  const sharedScripts = options.sharedScripts || SHARED_SCRIPTS;
  const logStep = options.step || step;
  const logOk = options.ok || ok;

  logStep('Registering UserPromptExpansion hook in ~/.claude/settings.json...');

  let userSettings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      userSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      fail(`Cannot parse ${settingsPath}: ${e.message}`);
    }
  }

  if (!userSettings.hooks) userSettings.hooks = {};
  if (!Array.isArray(userSettings.hooks.UserPromptExpansion)) {
    userSettings.hooks.UserPromptExpansion = [];
  }

  // 既存のgh-maestroエントリを除去（重複防止）。無関係なmatcherは保持する。
  userSettings.hooks.UserPromptExpansion =
    userSettings.hooks.UserPromptExpansion.filter(g => !/gh-maestro/.test(g?.matcher ?? ''));

  userSettings.hooks.UserPromptExpansion.push(buildUserPromptExpansionHook(sharedScripts));

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2) + '\n', 'utf8');
  logOk(`UserPromptExpansion hook -> ${settingsPath}`);

  return {
    settingsPath,
    settings: userSettings,
    hook: userSettings.hooks.UserPromptExpansion[userSettings.hooks.UserPromptExpansion.length - 1],
  };
}

module.exports = {
  parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter, copySkillAssets, pruneStaleRecursive,
  buildRulesSupportedMap, assertManagedTopLevelName, quarantineLegacyHomePids, installSkills,
  installScripts, installSharedSkills, restartResidentsAfterInstall, printInstallCompletion,
  buildUserPromptExpansionHook, registerUserPromptExpansionHook,
};

if (require.main !== module) return;

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Branch guard: WIPブランチからの実行を防止 ──────────────────────────────────
// install.js は ~/.gh-maestro/ 共有ディレクトリを書き換えるため、
// 未レビュー・未マージのWIPブランチからの実行は機械的に拒否する。
// --force で明示的に許可可能。
const forceFlag = process.argv.includes('--force');
try {
  const currentBranch = getCurrentBranch(ROOT);
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
const CODER_WORKFLOW_CONTENT = readPartial('coder-workflow.md');
const COMMENTS_AND_NAMING_CONTENT = readPartial('comments-and-naming.md');

// ── 各エージェントのスキルディレクトリに SKILL.md のみを配置 ──────────────────
// スクリプトはスキルdirには置かず、すべて SHARED_SCRIPTS に集約する（下の共有install参照）。
installSkills(agents, {
  skillsDir: SKILLS_DIR,
  sharedScripts: SHARED_SCRIPTS,
  sharedSkills: SHARED_SKILLS,
  rulesSupportedMap,
  step,
  ok,
});

// ── scripts/ を SHARED_SCRIPTS にミラーする ───────────────────────────────────
// リポジトリの scripts/ が、インストール先 ~/.gh-maestro/scripts/ と1:1で対応する。
// CLIスクリプトもモジュール(link-node-modules等)も全て scripts/ に同居しているため、
// 各スクリプトの require('./xxx') がリポジトリ実行・インストール先実行の両方で解決する。
installScripts({
  scriptsDir: path.join(ROOT, 'scripts'),
  sharedScripts: SHARED_SCRIPTS,
  agentsYaml: AGENTS_YAML,
  step,
  ok,
});

// ── 共有スキルを ~/.gh-maestro/skills/ にデプロイ ─────────────────────────────
// 全エージェントがそれぞれのネイティブなスキル発見機構（skill_files_install_destination_directory）
// 経由でSKILL.mdを読む方式に統一済み（reasonixも含む。agents.yaml参照）。
// ここで作る共有コピーは、orchestrator専用の非SKILL.mdアセット（issue-template.md等）を
// 配布するためのものであり、orchestratorは常にClaude Code自身で動くため、置換にはclaude用
// substitutionsを使う。
installSharedSkills(agents, {
  skillsDir: SKILLS_DIR,
  sharedSkills: SHARED_SKILLS,
  sharedScripts: SHARED_SCRIPTS,
  step,
  ok,
});

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
// runtime root（GH_MAESTRO_RUNTIME_DIR で明示 override 可能）が managed root
// （~/.gh-maestro/）と衝突している場合、隔離先ディレクトリ自体が prune 対象に巻き込まれる
// おそれがあるため、隔離処理を始める前に自己検査で fail-closed に倒す。
storageLayout.assertDisjointRoots();
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

registerUserPromptExpansionHook({ sharedScripts: SHARED_SCRIPTS });

// --- git pre-commit hook (core.hooksPath) を設定 ---
step('Configuring git pre-commit hook...');
// Unix では実行権限が無いと git がフックを黙ってスキップするため付与する（Windowsでは無視される）。
try { fs.chmodSync(path.join(ROOT, '.githooks', 'pre-commit'), 0o755); } catch {}
try { fs.chmodSync(path.join(ROOT, 'install.sh'),              0o755); } catch {}
const { spawnSync: spawnGit } = require('child_process');
const hookResult = spawnGit('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, encoding: 'utf8' });
if (hookResult.status === 0) {
  ok('git core.hooksPath -> .githooks (.claude/rules と AGENTS.md の同期のみ。テストは実行しない)');
} else {
  console.log(`  \x1b[33m! git config core.hooksPath 失敗 — 手動で実行: git config core.hooksPath .githooks\x1b[0m`);
}

// installで共有スクリプトを更新した時点で、既存の常駐プロセスは古いrequire閉包を
// 保持している。配布済みのCLIに停止・入れ替えを委ね、Monitorを持つ常駐の再接続要求も
// installの出力へそのまま届ける。登録workspaceが無い場合だけ対象を推測せずスキップする。
step('Restarting resident processes with the installed scripts...');
const residentRestart = restartResidentsAfterInstall({
  onWorkspace: (workspace) => step(`Restarting resident processes for workspace=${JSON.stringify(workspace)}`),
});
if (!residentRestart.attempted) {
  if (residentRestart.code === 0) {
    ok('No registered workspace — resident restart skipped');
  } else {
    fail(`常駐プロセスの対象workspace registryを読み取れませんでした: ${residentRestart.error.message}`);
  }
} else if (residentRestart.code !== 0) {
  const status = residentRestart.code === 1 ? '終了コード1' : `終了コード${residentRestart.code}`;
  fail(`常駐プロセスの入れ替えに失敗しました（${status}）。一部workspaceに未確認の常駐が残っている可能性があります。`);
} else {
  ok(`Resident process restart completed for ${residentRestart.workspaces.length} workspace(s)`);
}

printInstallCompletion(residentRestart);
