'use strict';

const fs = require('fs');
const path = require('path');

// 相対パス表記の先頭 `./`・`../`（複数可）を許容しつつ、`.md`単体のような無意味な
// トークンは弾く。アンカー（`#...`）は日本語・パーセントエンコードも許容する。
const PATH_TOKEN_RE = /^(?:\.\.?\/)*[A-Za-z0-9_.][A-Za-z0-9_\-./]*\.md(#[^\s`)]*)?$/;

function isLikelyPathToken(token) {
  if (!PATH_TOKEN_RE.test(token)) return false;
  if (token.includes('*') || token.includes('|')) return false;
  return true;
}

// content中の各改行位置を1回だけ走査して記録し、以後は二分探索でindexから行番号を
// 求める。マッチのたびにcontent先頭からslice+splitするとO(n^2)になるため避ける。
function buildLineIndex(content) {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function lineForIndex(offsets, index) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function decodeFileUrl(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'file:') return null;
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/... -> C:/...
    return p;
  } catch {
    return null;
  }
}

// file:///... 形式のリンクから、リポジトリ配下を指す部分だけを取り出す。
// マシンローカルな絶対パス（例: file:///C:/Users/amg/work/gh-maestro/scripts/x.js）は
// ユーザー名等の前置きを含み実行環境ごとに異なるため、パス区切りの各位置から始まる
// 末尾部分列のうち、リポジトリルート配下に実在するものを探す。
function repoRelativeFromAbsolute(repoRoot, absPath) {
  const withoutAnchor = absPath.split('#')[0];
  const segments = withoutAnchor.split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/');
    if (!candidate.endsWith('.md') && !candidate.includes('.')) continue;
    const resolved = resolveWithinRoot(repoRoot, repoRoot, candidate);
    if (resolved && fs.existsSync(resolved)) return candidate;
  }
  return null;
}

// 与えられたMarkdown本文から、`*.md`への言及（Markdownリンク or インラインコード）を抽出する。
// テンプレート変数({{...}})・プレースホルダ(<...>)・ワイルドカード(*)・
// リポジトリ外を指すことが明らかなURLスキーム・/tmp/配下は誤検知源として除外する。
// file:///... はリポジトリ配下を指しうるため、実ファイル解決を試みる対象として残す。
function extractMdRefs(content) {
  const refs = [];
  const offsets = buildLineIndex(content);

  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    let target = m[1].trim().split(/\s+/)[0];
    const line = lineForIndex(offsets, m.index);

    if (/^file:\/\//i.test(target)) {
      const decoded = decodeFileUrl(target);
      if (decoded && (decoded.endsWith('.md') || /\.md#/.test(decoded))) {
        refs.push({ raw: m[1], target: decoded, line, isAbsolute: true });
      }
      continue;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) continue; // その他のURLスキーム
    if (target.startsWith('/tmp/')) continue;
    if (target.includes('{{') || target.includes('<')) continue;
    if (!target.endsWith('.md') && !/\.md#/.test(target)) continue;
    if (!isLikelyPathToken(target)) continue;
    refs.push({ raw: m[1], target, line });
  }

  const codeRe = /`([^`\n]+)`/g;
  while ((m = codeRe.exec(content)) !== null) {
    const target = m[1].trim();
    if (!target.endsWith('.md') && !/\.md#/.test(target)) continue;
    if (target.startsWith('/tmp/')) continue;
    if (target.includes('{{') || target.includes('<')) continue;
    if (!isLikelyPathToken(target)) continue;
    // 裸のファイル名（例: `logic-invariants.md`）も、言及元ファイルの祖先ディレクトリ
    // 基準でresolveRefExistsが解決を試みるため、ここでは除外しない。
    const line = lineForIndex(offsets, m.index);
    refs.push({ raw: m[1], target, line });
  }

  return refs;
}

// baseDirを起点にrelPathを解決した絶対パスを返す。ただしその解決先がrepoRootの
// 外に正規化される場合はnullを返す（path traversal拒否）。
function resolveWithinRoot(repoRoot, baseDir, relPath) {
  const absRepoRoot = path.resolve(repoRoot);
  const resolved = path.resolve(baseDir, relPath);
  const rel = path.relative(absRepoRoot, resolved);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null;
  return resolved;
}

// 参照パスが、言及元ファイルからの相対パス、その祖先ディレクトリ（スキルルート等）
// からの相対パス、またはリポジトリルートからの相対パスとして実在するかを判定する。
// いずれの候補もrepoRootの外に正規化される場合は拒否する（path traversal対策）。
function resolveRefExists(repoRoot, sourceFile, target, opts) {
  const isAbsolute = opts && opts.isAbsolute;
  const withoutAnchor = target.split('#')[0];
  const absRepoRoot = path.resolve(repoRoot);

  if (isAbsolute) {
    return repoRelativeFromAbsolute(absRepoRoot, withoutAnchor) !== null;
  }

  let dir = path.resolve(path.dirname(sourceFile));
  while (true) {
    const candidate = resolveWithinRoot(absRepoRoot, dir, withoutAnchor);
    if (candidate && fs.existsSync(candidate)) return true;
    if (dir === absRepoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

module.exports = { extractMdRefs, resolveRefExists, isLikelyPathToken };
