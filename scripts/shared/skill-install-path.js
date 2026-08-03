'use strict';
// skill-install-path.js
// agentId（agent-defaults.json の id）から、そのエージェントが実際にネイティブなスキル
// 発見機構で読むSKILL.mdの絶対パスを実行時に解決する。
//
// SSOTは skills/agents.yaml。install.js がその実ファイルを
// ~/.gh-maestro/scripts/agents.yaml に単純コピーして配布するため、リポジトリ実行時・
// インストール先実行時のどちらでも同じパーサーで同じ内容を読める
// （scripts/agent-defaults.json と同じ配布パターン。resolve-config.js 冒頭コメント参照）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { existsSync, readFileSync } = require('fs');
const { resolve, join } = require('path');
const { parseAgentsYaml, expandHome } = require('./agents-yaml');

/**
 * skills/agents.yaml の実体を解決する。インストール後の配布コピー
 * （~/.gh-maestro/scripts/agents.yaml）を優先し、無ければリポジトリ本体
 * （<repo>/skills/agents.yaml）にフォールバックする。
 * @returns {string|null}
 */
function resolveAgentsYamlPath() {
  const installedCopy = resolve(__dirname, '..', 'agents.yaml');
  if (existsSync(installedCopy)) return installedCopy;
  const repoOriginal = resolve(__dirname, '..', '..', 'skills', 'agents.yaml');
  if (existsSync(repoOriginal)) return repoOriginal;
  return null;
}

/**
 * agent-defaults.json の agentId は skills/agents.yaml のキー（claude/agy/reasonix/codex）と
 * 1:1対応しない（例: agy-interactive は agy と同じCLI・同じスキルインストール先を使うが、
 * 独立したagentエントリとして宣言されている）。新しい対応表は持たず、既存の2つのSSOT
 * （agentIdそのもの、および agent-defaults.json の command 文字列）だけから機械的に導出する。
 * どちらも一致しなければ null（フェイルクローズ: 対応外のエージェントに誤った推測をしない）。
 * @param {string} agentId
 * @param {string|undefined} command
 * @param {object} yamlAgentsMap parseAgentsYaml() の戻り値
 * @returns {string|null}
 */
function resolveSkillsFamilyKey(agentId, command, yamlAgentsMap) {
  if (yamlAgentsMap[agentId]) return agentId;
  if (command && yamlAgentsMap[command]) return command;
  return null;
}

/**
 * fsアクセスなしの純粋関数コア（単体テスト容易性のため分離）。
 * @param {object} yamlAgentsMap parseAgentsYaml() の戻り値
 * @param {string} agentId
 * @param {string|undefined} command
 * @param {string} skillName スキルフォルダ名（例: 'gh-maestro-assistant'）
 * @returns {string|null} SKILL.md の絶対パス。解決不能なら null。
 */
function computeSkillMdPath(yamlAgentsMap, agentId, command, skillName) {
  const family = resolveSkillsFamilyKey(agentId, command, yamlAgentsMap);
  if (!family || !yamlAgentsMap[family] || !yamlAgentsMap[family].dest) return null;
  return join(expandHome(yamlAgentsMap[family].dest), skillName, 'SKILL.md');
}

/**
 * agentId に対応するスキルの、実際にインストールされたSKILL.mdの絶対パスを解決する
 * （IOラッパー。呼び出し元はこちらを使う）。
 * @param {string} agentId agent-defaults.json のエージェントID（例: 'agy-interactive'）
 * @param {string|undefined} command agentConfig.command（例: 'agy'）
 * @param {string} skillName スキルフォルダ名（例: 'gh-maestro-assistant'）
 * @returns {string|null} SKILL.md の絶対パス。agents.yaml が見つからない、または対応するエージェント
 *   ファミリーを解決できない場合は null。
 */
function resolveSkillMdPath(agentId, command, skillName) {
  const yamlPath = resolveAgentsYamlPath();
  if (!yamlPath) return null;
  const yamlAgentsMap = parseAgentsYaml(readFileSync(yamlPath, 'utf8'));
  return computeSkillMdPath(yamlAgentsMap, agentId, command, skillName);
}

module.exports = { resolveSkillMdPath, computeSkillMdPath, resolveSkillsFamilyKey, resolveAgentsYamlPath };
