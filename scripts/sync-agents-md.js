#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const AGENTS_MD = path.join(ROOT, 'AGENTS.md');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');

const BEGIN = '<!-- BEGIN: synced from AGENTS.md (scripts/sync-agents-md.js) -->';
const END = '<!-- END: synced from AGENTS.md -->';

function buildSyncedClaudeMd(claudeContent, agentsContent) {
  const beginIdx = claudeContent.indexOf(BEGIN);
  const endIdx = claudeContent.indexOf(END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`sync-agents-md: CLAUDE.md に ${BEGIN} / ${END} マーカーが見つかりません`);
  }
  const before = claudeContent.slice(0, beginIdx + BEGIN.length);
  const after = claudeContent.slice(endIdx);
  return `${before}\n\n${agentsContent.trimEnd()}\n\n${after}`;
}

function syncAgentsMd() {
  if (!fs.existsSync(AGENTS_MD)) {
    console.error('sync-agents-md: AGENTS.md not found');
    process.exit(1);
  }
  if (!fs.existsSync(CLAUDE_MD)) {
    console.error('sync-agents-md: CLAUDE.md not found');
    process.exit(1);
  }

  const agentsContent = fs.readFileSync(AGENTS_MD, 'utf8');
  const claudeContent = fs.readFileSync(CLAUDE_MD, 'utf8');

  let next;
  try {
    next = buildSyncedClaudeMd(claudeContent, agentsContent);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (next === claudeContent) {
    console.log('sync-agents-md: no changes');
    return;
  }

  fs.writeFileSync(CLAUDE_MD, next, 'utf8');
  console.log('sync-agents-md: synced AGENTS.md -> CLAUDE.md');
}

module.exports = { buildSyncedClaudeMd, BEGIN, END };

if (require.main === module) syncAgentsMd();
