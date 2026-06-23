'use strict';
// lib/compile-reviewers-utils.js
// compile-reviewers.jsから抽出したテスト可能な純粋関数群

const fs = require('fs');
const path = require('path');

function parseFrontmatter(mdContent) {
  const parts = mdContent.split(/^---\s*$/m);
  if (parts.length < 3) return {};
  const result = {};
  for (const line of parts[1].split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

function extractBody(mdContent) {
  const parts = mdContent.split(/^---\s*$/m);
  if (parts.length < 3) throw new Error('Expected two --- delimiters in frontmatter');
  return parts.slice(2).join('---').trimStart();
}

function resolveIncludes(body, baseDir) {
  return body.replace(/\{\{#include ([^}]+)\}\}/g, (_, rel) => {
    const p = path.join(baseDir, rel.trim());
    if (!fs.existsSync(p)) throw new Error(`Include not found: ${p}`);
    return fs.readFileSync(p, 'utf8').trimEnd();
  });
}

module.exports = { parseFrontmatter, extractBody, resolveIncludes };
