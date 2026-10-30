#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { recordSyncFailure, clearSyncFailure } = require('./shared/sync-failure');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');

const USAGE = `sync-rules.js — .claude/rules/*.md を .agents/rules/*.md に変換・同期する

Usage: node sync-rules.js [--help]

.claude/rules/ 配下のルール定義を Antigravity (agy) 形式に変換し .agents/rules/ へ同期します。
ファイル単位の失敗は残りの同期を続け、失敗したファイル名と詳細記録先を stderr にまとめて表示します。
同期失敗時は <workspace>/.gh-maestro/sync-failures/sync-rules.yaml に失敗理由を記録します。

Options:
  --help, -h  このヘルプを表示します。`;

const SPEC = {
  flags: {},
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

const ROOT = process.cwd();
const CLAUDE_RULES = path.join(ROOT, '.claude', 'rules');
const AGENTS_RULES = path.join(ROOT, '.agents', 'rules');

function parseFrontmatter(rawContent) {
  const content = rawContent.replace(/\r\n/g, '\n');
  if (!content.startsWith('---\n')) return { paths: null, signals: null, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { paths: null, signals: null, body: content };
  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);

  // Keep this small list reader as part of the existing frontmatter parser so
  // rule paths and handbook delivery signals share one parsing contract.
  const parseList = (key) => {
    const match = yaml.match(new RegExp('^' + key + ':\\s*\\n((?:[ \\t]+-[ \\t]+[^\\n]*(?:\\n|$))*)', 'm'));
    if (!match) return null;
    return match[1]
      .split('\n')
      .filter(line => /^[ \\t]+-[ \\t]+/.test(line))
      .map(line => line.replace(/^[ \\t]+-[ \\t]+/, '').replace(/^['\"]|['\"]$/g, '').trim());
  };

  return { paths: parseList('paths'), signals: parseList('signals'), body };
}
function toAgyFrontmatter(paths, file) {
  if (!paths || paths.length === 0) {
    throw new Error(`sync-rules: ${file} has no paths: frontmatter`);
  }
  return `---\ntrigger: glob\nglobs: ${paths.join(',')}\n---\n`;
}

function syncRules(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { exitCode: 0, stdout: USAGE, stderr: '' };
    return { exitCode: 1, stdout: '', stderr: `sync-rules: ${error.errors.map((item) => item.message).join('\n')}\n${USAGE}` };
  }
  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE, stderr: '' };

  const failures = [];
  let syncedCount = 0;
  let removedOrphanCount = 0;
  let srcFiles;
  try {
    if (!fs.existsSync(CLAUDE_RULES)) {
      throw new Error('sync-rules: .claude/rules/ not found');
    }
    fs.mkdirSync(AGENTS_RULES, { recursive: true });

    srcFiles = new Set(fs.readdirSync(CLAUDE_RULES).filter((file) => file.endsWith('.md')));

    // Sync source files
    for (const file of srcFiles) {
      const src = path.join(CLAUDE_RULES, file);
      const dst = path.join(AGENTS_RULES, file);
      try {
        const content = fs.readFileSync(src, 'utf8');
        const { paths, body } = parseFrontmatter(content);
        const frontmatter = toAgyFrontmatter(paths, file);
        fs.writeFileSync(dst, frontmatter + body, 'utf8');
        syncedCount += 1;
      } catch (error) {
        failures.push({ file: `.claude/rules/${file}`, reason: error.message });
      }
    }

    // Remove orphaned files in .agents/rules/ that no longer exist in .claude/rules/
    if (fs.existsSync(AGENTS_RULES)) {
      for (const file of fs.readdirSync(AGENTS_RULES).filter(f => f.endsWith('.md'))) {
        if (!srcFiles.has(file)) {
          try {
            fs.unlinkSync(path.join(AGENTS_RULES, file));
            removedOrphanCount += 1;
          } catch (error) {
            failures.push({ file: `.agents/rules/${file}`, reason: error.message });
          }
        }
      }
    }
  } catch (e) {
    failures.push({ file: '.claude/rules/', reason: e.message });
  }

  const workspace = resolveWorkspace();
  const failurePath = path.join(workspace || ROOT, '.gh-maestro', 'sync-failures', 'sync-rules.yaml');
  if (failures.length > 0) {
    recordSyncFailure('sync-rules', failures.map(({ file, reason }) => `${file}: ${reason}`).join('\n'), ROOT);
  } else {
    clearSyncFailure('sync-rules');
  }

  const stdout = `sync-rules: ${syncedCount} 件を .agents/rules/ へ同期しました${removedOrphanCount > 0 ? `（孤児 ${removedOrphanCount} 件を削除）` : ''}`;
  const stderr = failures.length > 0
    ? `sync-rules: ${failures.length} 件の同期に失敗しました: ${failures.map(({ file }) => file).join(', ')}（詳細: ${failurePath}）`
    : '';
  return { exitCode: failures.length > 0 ? 1 : 0, stdout, stderr };
}

function main(argv = process.argv.slice(2)) {
  const result = syncRules(argv);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  return result.exitCode;
}

module.exports = { USAGE, SPEC, parseFrontmatter, toAgyFrontmatter, syncRules, main };

if (require.main === module) process.exitCode = main();
