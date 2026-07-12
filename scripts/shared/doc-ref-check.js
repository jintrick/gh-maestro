'use strict';

const fs = require('fs');
const path = require('path');

const PATH_TOKEN_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-./]*\.md(#[A-Za-z0-9_\-]*)?$/;

function isLikelyPathToken(token) {
  if (!PATH_TOKEN_RE.test(token)) return false;
  if (token.includes('*') || token.includes('|')) return false;
  if (token === '.md') return false;
  return true;
}

// 与えられたMarkdown本文から、`*.md`への言及（Markdownリンク or インラインコード）を抽出する。
// テンプレート変数({{...}})・プレースホルダ(<...>)・ワイルドカード(*)・URLスキーム・
// /tmp/配下は誤検知源として除外する。
function extractMdRefs(content) {
  const refs = [];

  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    let target = m[1].trim().split(/\s+/)[0];
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) continue; // URLスキーム付き（http, file等）
    if (target.startsWith('/tmp/')) continue;
    if (target.includes('{{') || target.includes('<')) continue;
    if (!target.endsWith('.md') && !/\.md#/.test(target)) continue;
    if (!isLikelyPathToken(target)) continue;
    const line = content.slice(0, m.index).split('\n').length;
    refs.push({ raw: m[1], target, line });
  }

  const codeRe = /`([^`\n]+)`/g;
  while ((m = codeRe.exec(content)) !== null) {
    const target = m[1].trim();
    if (!target.endsWith('.md') && !/\.md#/.test(target)) continue;
    if (target.startsWith('/tmp/')) continue;
    if (target.includes('{{') || target.includes('<')) continue;
    if (!isLikelyPathToken(target)) continue;
    // ディレクトリ区切りを含まない裸のファイル名（例: `SKILL.md`）は、箇条書きの見出し等
    // 文脈依存の言及であることが多く、単独では参照先を特定できないため除外する。
    if (!target.includes('/')) continue;
    const line = content.slice(0, m.index).split('\n').length;
    refs.push({ raw: m[1], target, line });
  }

  return refs;
}

// 参照パスが、言及元ファイルからの相対パス、その祖先ディレクトリ（スキルルート等）
// からの相対パス、またはリポジトリルートからの相対パスとして実在するかを判定する。
function resolveRefExists(repoRoot, sourceFile, target) {
  const withoutAnchor = target.split('#')[0];
  const absRepoRoot = path.resolve(repoRoot);
  let dir = path.resolve(path.dirname(sourceFile));
  while (true) {
    if (fs.existsSync(path.join(dir, withoutAnchor))) return true;
    if (dir === absRepoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fs.existsSync(path.resolve(absRepoRoot, withoutAnchor));
}

module.exports = { extractMdRefs, resolveRefExists, isLikelyPathToken };
