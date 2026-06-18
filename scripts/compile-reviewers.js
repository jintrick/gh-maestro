#!/usr/bin/env node
// Compiles reviewer .md sources into .yml/.lock.yml:
//   1. Resolves {{#include shared/xxx.md}} directives in the .md body
//   2. Replaces the format section in compiled .yml/.lock.yml files
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'workflows');
const NAMES = ['reviewer-correctness', 'reviewer-maintainability', 'reviewer-resilience'];

function resolveIncludes(body, baseDir) {
  return body.replace(/\{\{#include ([^}]+)\}\}/g, (_, rel) => {
    const p = path.join(baseDir, rel.trim());
    if (!fs.existsSync(p)) throw new Error(`Include not found: ${p}`);
    return fs.readFileSync(p, 'utf8').trimEnd();
  });
}

function extractBody(mdContent) {
  const parts = mdContent.split(/^---\s*$/m);
  if (parts.length < 3) throw new Error('Expected two --- delimiters in frontmatter');
  return parts.slice(2).join('---').trimStart();
}

for (const name of NAMES) {
  const mdPath = path.join(WORKFLOWS_DIR, `${name}.md`);
  const mdRaw = fs.readFileSync(mdPath, 'utf8');
  const rawBody = extractBody(mdRaw);
  const resolvedBody = resolveIncludes(rawBody, WORKFLOWS_DIR);

  const targets = [
    path.join(ROOT, '.github', 'workflows', `${name}.yml`),
    path.join(WORKFLOWS_DIR, `${name}.lock.yml`),
  ];

  for (const target of targets) {
    const raw = fs.readFileSync(target, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const content = raw.replace(/\r\n/g, '\n');

    // Find the start of the format section
    const FORMAT_MARKER = '# 投稿コメントのフォーマット';
    const EOF_RE = /GH_AW_PROMPT_[a-f0-9]+_EOF/;

    const fmtIdx = content.indexOf(FORMAT_MARKER);
    if (fmtIdx === -1) { console.log(`SKIP (format marker not found): ${target}`); continue; }

    const eofMatch = EOF_RE.exec(content.slice(fmtIdx));
    if (!eofMatch) { console.log(`SKIP (EOF marker not found): ${target}`); continue; }
    const eofIdx = fmtIdx + eofMatch.index;

    // Detect indent from the format marker line
    const lineStart = content.lastIndexOf('\n', fmtIdx - 1) + 1;
    const indent = content.slice(lineStart, fmtIdx);

    // Build new section from resolved body, starting from format section
    const resolvedFmtIdx = resolvedBody.indexOf(FORMAT_MARKER);
    if (resolvedFmtIdx === -1) { console.log(`SKIP (format marker missing in resolved body): ${target}`); continue; }
    const newSection = resolvedBody.slice(resolvedFmtIdx)
      .split('\n')
      .map(l => l === '' ? '' : indent + l)
      .join('\n') + '\n          ';

    const result = content.slice(0, fmtIdx) + newSection + content.slice(eofIdx);
    fs.writeFileSync(target, eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result, 'utf8');
    console.log(`OK: ${target}`);
  }
}
