#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CLAUDE_RULES = path.join(ROOT, '.claude', 'rules');
const AGENTS_RULES = path.join(ROOT, '.agents', 'rules');

function parseFrontmatter(rawContent) {
  const content = rawContent.replace(/\r\n/g, '\n');
  if (!content.startsWith('---\n')) return { paths: null, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { paths: null, body: content };
  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);

  const pathsMatch = yaml.match(/^paths:\s*\n((?:[ \t]+-[ \t]+.+\n?)+)/m);
  if (!pathsMatch) return { paths: null, body };

  const paths = pathsMatch[1]
    .split('\n')
    .filter(l => /^[ \t]+-[ \t]+/.test(l))
    .map(l => l.replace(/^[ \t]+-[ \t]+/, '').replace(/^["']|["']$/g, '').trim());

  return { paths, body };
}

function toAgyFrontmatter(paths, file) {
  if (!paths || paths.length === 0) {
    console.error(`sync-rules: ${file} has no paths: frontmatter`);
    process.exit(1);
  }
  return `---\ntrigger: glob\nglobs: ${paths.join(',')}\n---\n`;
}

function syncRules() {
  if (!fs.existsSync(CLAUDE_RULES)) {
    console.error('sync-rules: .claude/rules/ not found');
    process.exit(1);
  }
  fs.mkdirSync(AGENTS_RULES, { recursive: true });

  const srcFiles = new Set(
    fs.readdirSync(CLAUDE_RULES).filter(f => f.endsWith('.md'))
  );

  // Sync source files
  for (const file of srcFiles) {
    const src = path.join(CLAUDE_RULES, file);
    const dst = path.join(AGENTS_RULES, file);
    const content = fs.readFileSync(src, 'utf8');
    const { paths, body } = parseFrontmatter(content);
    fs.writeFileSync(dst, toAgyFrontmatter(paths, file) + body, 'utf8');
    console.log(`  synced: .claude/rules/${file} -> .agents/rules/${file}`);
  }

  // Remove orphaned files in .agents/rules/ that no longer exist in .claude/rules/
  if (fs.existsSync(AGENTS_RULES)) {
    for (const file of fs.readdirSync(AGENTS_RULES).filter(f => f.endsWith('.md'))) {
      if (!srcFiles.has(file)) {
        fs.unlinkSync(path.join(AGENTS_RULES, file));
        console.log(`  removed orphan: .agents/rules/${file}`);
      }
    }
  }
}

syncRules();
