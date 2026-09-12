#!/usr/bin/env node
// create-adr.js — ADR作成の決定的な入口
//
// --next は次に使われるパスを表示するだけで、ファイルを変更しない。呼び出し側は
// その結果を使って規範文書や旧ADRへの参照を更新し、作成経路で完成状態を検査する。
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { toWinPath } = require('./shared/win-path');
const { assertWithinRoot } = require('./shared/record-paths');
const { extractMdRefs, resolveRefExists } = require('./shared/doc-ref-check');

const USAGE = `create-adr.js — ADRの採番・書式・参照を検証して作成する

Usage:
  node create-adr.js --next --slug <slug> [--workspace <path>]
  node create-adr.js --slug <slug> --body-file <path> (--normative-file <path> | --self-contained) [--supersedes <path>] [--workspace <path>]

Options:
  --next                   次に割り当てるADRの相対パスを表示する（ファイルは変更しない）
  --slug <slug>            ファイル名のスラッグ（英小文字・数字・ハイフン）
  --body-file <path>       ADR本文（UTF-8）
  --normative-file <path>  参照行を置いた規範文書。AGENTS.md、.claude/rules/**/*.md、skills/**/SKILL.mdに限る
  --self-contained         ワーカーの実装や振る舞いを縛らない自己完結の判断であることを明示する
  --supersedes <path>      覆す旧ADR（docs/adr/<番号>-<slug>.md）
  --workspace <path>       ワークスペースのルート（省略時は環境変数またはCWDから解決）
  --help, -h               このヘルプを表示する

作成経路は、規範文書に新ADRへの「理由と経緯: docs/adr/<new-file>」行があること、
および --supersedes 指定時の旧ADRへの追記と規範文書の参照張り替えを、ファイル作成前に確認する。`;

const SPEC = Object.freeze({
  flags: {
    '--slug': {},
    '--body-file': {},
    '--normative-file': {},
    '--supersedes': {},
    '--workspace': {},
  },
  booleans: ['--next', '--self-contained', '--help', '-h'],
  positionals: { min: 0, max: 0 },
});

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADR_FILE_RE = /^(\d+)-.+\.md$/;
const ADR_PATH_RE = /^docs\/adr\/[^/]+\.md$/;
const ALLOWED_NORMATIVE_RE = [
  /^AGENTS\.md$/,
  /^\.claude\/rules\/.+\.md$/,
  /^skills\/.+\/SKILL\.md$/,
];
const REQUIRED_SECTIONS = Object.freeze(['決めたこと', 'なぜ', '却下した案']);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isAllowedNormativePath(relativePath) {
  return ALLOWED_NORMATIVE_RE.some((pattern) => pattern.test(relativePath));
}

function resolveRepoPath(workspace, input, label) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label}が指定されていません`);
  }
  const candidate = path.resolve(workspace, toWinPath(input));
  const absolute = assertWithinRoot(workspace, candidate);
  const relative = toPosix(path.relative(workspace, absolute));
  if (!relative || relative === '.') {
    throw new Error(`${label}にワークスペースのルートは指定できません`);
  }
  return { absolute, relative };
}

function resolveNormativeFile(workspace, input) {
  const resolved = resolveRepoPath(workspace, input, '規範文書');
  if (!isAllowedNormativePath(resolved.relative)) {
    throw new Error(
      `規範文書はAGENTS.md、.claude/rules/**/*.md、skills/**/SKILL.mdのいずれかで指定してください: ${resolved.relative}`,
    );
  }
  if (!fs.existsSync(resolved.absolute)) {
    throw new Error(`指定した規範文書が存在しません: ${resolved.relative}`);
  }
  if (!fs.statSync(resolved.absolute).isFile()) {
    throw new Error(`指定した規範文書がファイルではありません: ${resolved.relative}`);
  }
  return resolved;
}

function resolveAdrFile(workspace, input) {
  const resolved = resolveRepoPath(workspace, input, 'ADR');
  if (!ADR_PATH_RE.test(resolved.relative)) {
    throw new Error(`ADRはdocs/adr/<番号>-<slug>.mdで指定してください: ${resolved.relative}`);
  }
  const adrRoot = path.join(workspace, 'docs', 'adr');
  assertWithinRoot(adrRoot, resolved.absolute);
  if (!fs.existsSync(resolved.absolute)) {
    throw new Error(`指定した旧ADRが存在しません: ${resolved.relative}`);
  }
  if (!fs.statSync(resolved.absolute).isFile()) {
    throw new Error(`指定した旧ADRがファイルではありません: ${resolved.relative}`);
  }
  return resolved;
}

function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error('--slugは英小文字・数字・ハイフンで指定してください');
  }
}

function nextAdrPath(workspace, slug) {
  validateSlug(slug);
  const adrRoot = path.join(workspace, 'docs', 'adr');
  if (!fs.existsSync(adrRoot) || !fs.statSync(adrRoot).isDirectory()) {
    throw new Error(`ADRディレクトリが存在しません: ${toPosix(path.relative(workspace, adrRoot))}`);
  }

  let maximum = 0;
  for (const entry of fs.readdirSync(adrRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(ADR_FILE_RE);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }

  const filename = `${String(maximum + 1).padStart(4, '0')}-${slug}.md`;
  const absolute = assertWithinRoot(adrRoot, path.join(adrRoot, filename));
  if (fs.existsSync(absolute)) {
    throw new Error(`作成先のADRが既に存在します: docs/adr/${filename}`);
  }
  return { absolute, relative: `docs/adr/${filename}`, filename };
}

function headingText(raw) {
  return raw.trim().replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function parseMarkdownHeadings(content) {
  const headings = [];
  const lines = content.split(/\r?\n/);
  let fenceChar = null;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      const length = fence[1].length;
      if (fenceChar === null) {
        fenceChar = char;
        fenceLength = length;
      } else if (char === fenceChar && length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceChar !== null) continue;

    const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
    if (!heading) continue;
    headings.push({
      line: index + 1,
      level: heading[1].length,
      text: headingText(heading[2]),
    });
  }
  return headings;
}

function validateAdrBody(content) {
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('ADR本文が空です');
  }
  const headings = parseMarkdownHeadings(content);
  const lines = content.split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
  if (headings.length !== REQUIRED_SECTIONS.length + 1) {
    throw new Error('ADR本文の見出しはタイトルと3つの規定見出しだけにしてください');
  }
  if (headings[0].line !== firstNonEmpty + 1 || headings[0].level !== 1 || !headings[0].text) {
    throw new Error('ADR本文の先頭にはタイトル見出し（# <タイトル>）が必要です');
  }
  for (let i = 0; i < REQUIRED_SECTIONS.length; i += 1) {
    const heading = headings[i + 1];
    if (heading.level !== 2 || heading.text !== REQUIRED_SECTIONS[i]) {
      throw new Error(`ADR本文の${i + 1}番目の見出しは「## ${REQUIRED_SECTIONS[i]}」にしてください`);
    }
  }
  return headings;
}

function listMarkdownFiles(dir, root, output = []) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listMarkdownFiles(absolute, root, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = toPosix(path.relative(root, absolute));
    if (isAllowedNormativePath(relative)) output.push({ absolute, relative });
  }
  return output;
}

function listNormativeFiles(workspace) {
  const files = [];
  const agents = path.join(workspace, 'AGENTS.md');
  if (fs.existsSync(agents) && fs.statSync(agents).isFile()) {
    files.push({ absolute: agents, relative: 'AGENTS.md' });
  }
  listMarkdownFiles(path.join(workspace, '.claude', 'rules'), workspace, files);
  listMarkdownFiles(path.join(workspace, 'skills'), workspace, files);
  const seen = new Set();
  return files.filter((file) => {
    if (seen.has(file.relative)) return false;
    seen.add(file.relative);
    return true;
  });
}

function isTarget(ref, relativePath) {
  const target = ref.target.split('#')[0];
  return target === relativePath || target === `./${relativePath}`;
}

function readRefs(workspace, file, expectedNewPath = null) {
  const content = fs.readFileSync(file.absolute, 'utf8');
  const refs = extractMdRefs(content);
  for (const ref of refs) {
    // 作成前の新ADRだけはまだ実在しないため、許可された作成先と一致することを
    // 検査する。既存の参照は共有解決器で実在とリポジトリ外脱出を確認する。
    if (expectedNewPath && isTarget(ref, expectedNewPath)) continue;
    if (!resolveRefExists(workspace, file.absolute, ref.target, { isAbsolute: ref.isAbsolute })) {
      throw new Error(`${file.relative}:${ref.line} の参照先が存在しません: ${ref.target}`);
    }
  }
  return { content, refs };
}

function requireNewAdrReference(workspace, file, newRelativePath) {
  const content = fs.readFileSync(file.absolute, 'utf8');
  const refs = extractMdRefs(content);
  if (!refs.some((ref) => isTarget(ref, newRelativePath))) {
    throw new Error(`${file.relative} に新ADRへの参照行がありません: ${newRelativePath}`);
  }
  for (const ref of refs) {
    if (isTarget(ref, newRelativePath)) continue;
    if (!resolveRefExists(workspace, file.absolute, ref.target, { isAbsolute: ref.isAbsolute })) {
      throw new Error(`${file.relative}:${ref.line} の参照先が存在しません: ${ref.target}`);
    }
  }
}

function validateSupersession(workspace, oldFile, newRelativePath) {
  const oldContent = fs.readFileSync(oldFile.absolute, 'utf8');
  const marker = `この判断は \`${newRelativePath}\` で覆された`;
  if (!oldContent.split(/\r?\n/).some((line) => line.trim() === marker)) {
    throw new Error(`${oldFile.relative} に旧ADRの覆し追記がありません: ${marker}`);
  }

  for (const file of listNormativeFiles(workspace)) {
    const { refs } = readRefs(workspace, file, newRelativePath);
    for (const ref of refs) {
      if (isTarget(ref, oldFile.relative)) {
        throw new Error(`${file.relative}:${ref.line} が旧ADRを参照したままです: ${oldFile.relative}`);
      }
    }
  }
}

function createAdr({ workspace, slug, bodyFile, normativeFile, selfContained = false, supersedes }) {
  const next = nextAdrPath(workspace, slug);
  const bodyPath = path.resolve(toWinPath(bodyFile));
  const body = fs.readFileSync(bodyPath, 'utf8');
  validateAdrBody(body);

  if (normativeFile) {
    const normative = resolveNormativeFile(workspace, normativeFile);
    requireNewAdrReference(workspace, normative, next.relative);
  }
  if (supersedes) {
    const oldFile = resolveAdrFile(workspace, supersedes);
    validateSupersession(workspace, oldFile, next.relative);
  }

  fs.writeFileSync(next.absolute, body, { encoding: 'utf8', flag: 'wx' });
  return next;
}

function errorResult(message) {
  return { code: 1, stderr: `create-adr: ${message}\n${USAGE}` };
}

function main(argv = process.argv.slice(2)) {
  let values;
  let rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { code: 0, stdout: USAGE };
    return errorResult(error.errors.map((entry) => entry.message).join('\n'));
  }

  if (values['--help'] || values['-h']) return { code: 0, stdout: USAGE };
  if (rest.length > 0) return errorResult(`予期しない位置引数です: ${rest.join(' ')}`);

  const nextOnly = values['--next'] === true;
  const slug = values['--slug'];
  if (!slug) return errorResult('--slugが必要です');
  if (nextOnly && (values['--body-file'] || values['--normative-file'] || values['--self-contained'] || values['--supersedes'])) {
    return errorResult('--nextは作成用オプションと併用できません');
  }
  if (!nextOnly && !values['--body-file']) return errorResult('--body-fileが必要です');
  if (!nextOnly && Boolean(values['--normative-file']) === Boolean(values['--self-contained'])) {
    return errorResult('--normative-fileまたは--self-containedのどちらか一方が必要です');
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    return errorResult('ワークスペースを解決できません。--workspaceを指定するか、.gh-maestro/のあるディレクトリで実行してください');
  }

  try {
    if (nextOnly) {
      return { code: 0, stdout: `ADR_NEXT:${nextAdrPath(workspace, slug).relative}` };
    }
    const next = createAdr({
      workspace,
      slug,
      bodyFile: values['--body-file'],
      normativeFile: values['--normative-file'],
      selfContained: values['--self-contained'] === true,
      supersedes: values['--supersedes'],
    });
    return { code: 0, stdout: `ADR_CREATED:${next.relative}` };
  } catch (error) {
    return errorResult(error.message);
  }
}

if (require.main === module) {
  const result = main();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

module.exports = {
  USAGE,
  SPEC,
  createAdr,
  main,
  nextAdrPath,
  parseMarkdownHeadings,
  validateAdrBody,
};
