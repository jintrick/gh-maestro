'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../sync-rules');
const { resolveSkillMdPath } = require('./skill-install-path');
const { isWorkerIdentity } = require('./resident-force-guard');

const SKILL_NAME = 'gh-maestro-orchestrator';

function resolveGuidanceDirectory(workspace, options = {}) {
  if (options.skillDirectory) return options.skillDirectory;

  const projectDirectory = path.join(workspace, '.claude', 'skills', SKILL_NAME);
  if (fs.existsSync(path.join(projectDirectory, 'SKILL.md'))) return projectDirectory;

  const installedSkillMd = (options.resolveSkillMdPathFn || resolveSkillMdPath)(
    'claude', 'claude', SKILL_NAME,
  );
  if (installedSkillMd && fs.existsSync(installedSkillMd)) return path.dirname(installedSkillMd);
  throw new Error(`orchestratorスキルの配置先を解決できません: ${workspace}`);
}

function readDeclaredGuidance(workspace, options = {}) {
  const directory = resolveGuidanceDirectory(workspace, options);
  const files = fs.readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));
  const documents = [];
  for (const file of files) {
    const filePath = path.join(directory, file);
    const parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.signals || parsed.signals.length === 0) continue;
    documents.push({ file, filePath, signals: parsed.signals, body: parsed.body.trim() });
  }
  return documents;
}

function renderGuidanceDocuments(documents) {
  return documents.map(({ file, body }) => [
    `以下は ${file} の現在の内容です。事実として参照してください。`,
    '<gh-maestro-guidance>',
    body,
    '</gh-maestro-guidance>',
  ].join('\n')).join('\n\n');
}

function prepareScriptGuidance({ workspace, scriptName, signal, env = process.env, ...options }) {
  if (signal === undefined) return '';
  if (isWorkerIdentity(env.GH_MAESTRO_WORKER)) {
    throw new Error('--guidance-signal はworkerが実行するCLI呼び出しでは使えません');
  }
  if (typeof signal !== 'string' || !/^[A-Za-z0-9_-]+$/.test(signal)) {
    throw new Error('--guidance-signal は英数字・ハイフン・アンダースコアで指定してください');
  }
  const requested = `script:${scriptName}:${signal}`;
  const documents = readDeclaredGuidance(workspace, options)
    .filter((document) => document.signals.includes(requested));
  if (documents.length === 0) {
    throw new Error(`宣言された手順書合図がありません: ${requested}`);
  }
  return renderGuidanceDocuments(documents);
}

function extractNotificationNames(prompt) {
  const names = new Set();
  for (const match of prompt.matchAll(/<event>([\s\S]*?)<\/event>/g)) {
    for (const line of match[1].split(/\r?\n/)) {
      const event = /^\s*([A-Z][A-Z0-9_]*)(?=:|\s*$)/.exec(line);
      if (event) names.add(event[1]);
    }
  }
  return names;
}

function renderNotificationGuidance({ workspace, prompt, ...options }) {
  const names = extractNotificationNames(prompt);
  if (names.size === 0) return '';
  const signals = new Set([...names].map((name) => `notify:${name}`));
  const documents = readDeclaredGuidance(workspace, options)
    .filter((document) => document.signals.some((signal) => signals.has(signal)));
  return renderGuidanceDocuments(documents);
}

module.exports = {
  resolveGuidanceDirectory,
  readDeclaredGuidance,
  renderGuidanceDocuments,
  prepareScriptGuidance,
  extractNotificationNames,
  renderNotificationGuidance,
};
