#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { recordSyncFailure, clearSyncFailure } = require('./shared/sync-failure');

const USAGE = `sync-agents-md.js — AGENTS.md の内容を CLAUDE.md に同期する

Usage: node sync-agents-md.js

AGENTS.md を読み、CLAUDE.md のマーカー間に同期します。
同期失敗時は <workspace>/.gh-maestro/sync-failures/sync-agents-md.yaml に失敗理由を記録します。`;

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
  if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!fs.existsSync(AGENTS_MD)) {
    const msg = 'sync-agents-md: AGENTS.md not found';
    recordSyncFailure('sync-agents-md', msg);
    console.error(msg);
    process.exit(1);
  }
  if (!fs.existsSync(CLAUDE_MD)) {
    const msg = 'sync-agents-md: CLAUDE.md not found';
    recordSyncFailure('sync-agents-md', msg);
    console.error(msg);
    process.exit(1);
  }

  const agentsContent = fs.readFileSync(AGENTS_MD, 'utf8');
  const claudeContent = fs.readFileSync(CLAUDE_MD, 'utf8');

  let next;
  try {
    next = buildSyncedClaudeMd(claudeContent, agentsContent);
  } catch (e) {
    recordSyncFailure('sync-agents-md', e.message);
    console.error(e.message);
    process.exit(1);
  }

  if (next === claudeContent) {
    clearSyncFailure('sync-agents-md');
    console.log('sync-agents-md: no changes');
    return;
  }

  fs.writeFileSync(CLAUDE_MD, next, 'utf8');
  clearSyncFailure('sync-agents-md');
  console.log('sync-agents-md: synced AGENTS.md -> CLAUDE.md');
}

module.exports = { buildSyncedClaudeMd, syncAgentsMd, BEGIN, END };

if (require.main === module) syncAgentsMd();
