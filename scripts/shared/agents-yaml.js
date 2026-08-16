'use strict';
// agents-yaml.js
// skills/agents.yaml の最小YAMLパーサーとホームディレクトリ展開ユーティリティ。
// scripts/install.js と scripts/shared/skill-install-path.js の両方から共有される
// （agents.yaml のパース処理を2箇所に独立実装させないための単一実装）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

// ── Minimal YAML parser for agents.yaml ──────────────────────────────────────

function parseAgentsYaml(content) {
  const agents = {};
  let currentAgent = null;
  let inSubstitutions = false;
  let inDestList = false;
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

    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (inDestList && indent >= 4 && trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      agents[currentAgent].dests.push(item);
      if (!agents[currentAgent].dest) {
        agents[currentAgent].dest = item;
      }
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (indent === 2 && !value) {
      currentAgent = key;
      agents[key] = { substitutions: {}, dests: [] };
      inSubstitutions = false;
      inDestList = false;
    } else if (indent === 4 && currentAgent) {
      if (key === 'skill_markdown_template_placeholder_substitutions') {
        inSubstitutions = true;
        inDestList = false;
      } else if (key === 'skill_files_install_destination_directory') {
        inSubstitutions = false;
        if (value) {
          agents[currentAgent].dest = value;
          agents[currentAgent].dests = [value];
          inDestList = false;
        } else {
          inDestList = true;
          agents[currentAgent].dests = [];
        }
      } else {
        inSubstitutions = false;
        inDestList = false;
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

module.exports = { parseAgentsYaml, expandHome };
