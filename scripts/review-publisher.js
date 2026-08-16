#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');

const USAGE = `review-publisher.js — RM finding JSONを検証し、PRレビューとして投稿する

Usage: node review-publisher.js <findings-json> [--dry-run]

Arguments:
  <findings-json>  gh-maestro-reviewer RM が出力したJSON

Options:
  --dry-run        GitHubへ投稿せず、解決結果JSONをstdoutへ出力する`;

const {
  VALID_ASPECTS,
  VALID_SEVERITIES,
  FINDING_REQUIRED_FIELDS: REQUIRED_FINDING_FIELDS,
} = require('./shared/review-aspects');

const SEVERITY_LABELS = {
  BLOCKER: '\u{1F534} **BLOCKER**',
  MAJOR: '\u{1F7E1} **MAJOR**',
  SUGGESTION: '\u{1F7E2} **SUGGESTION**',
};

function isBlankLike(value) {
  if (typeof value !== 'string') return true;
  const s = value.trim();
  if (!s) return true;
  return s === '...' || /^<.*>$/.test(s) || /^todo$/i.test(s) || /^n\/a$/i.test(s);
}

function validatePayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['payload must be an object'] };
  }
  if (!Number.isInteger(payload.pr) || payload.pr < 1) errors.push('pr must be a positive integer');
  if (isBlankLike(payload.repo)) errors.push('repo is required');
  if (isBlankLike(payload.headRefOid)) errors.push('headRefOid is required');
  if (!Array.isArray(payload.findings)) errors.push('findings must be an array');
  return { ok: errors.length === 0, errors };
}

function validateFinding(finding) {
  const errors = [];
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return ['finding must be an object'];
  }

  for (const field of REQUIRED_FINDING_FIELDS) {
    if (!(field in finding)) errors.push(`${field} is required`);
  }
  if (!VALID_ASPECTS.has(finding.aspect)) errors.push('aspect is invalid');
  if (!VALID_SEVERITIES.has(finding.severity)) errors.push('severity is invalid (must be BLOCKER, MAJOR, or SUGGESTION)');
  for (const field of REQUIRED_FINDING_FIELDS.filter(f => f !== 'verified_references')) {
    if (isBlankLike(finding[field])) errors.push(`${field} is blank`);
  }
  if (!Array.isArray(finding.verified_references) || finding.verified_references.length === 0) {
    errors.push('verified_references must be a non-empty array');
  } else if (finding.verified_references.some(isBlankLike)) {
    errors.push('verified_references contains a blank value');
  }
  for (const field of ['context_before', 'context_after']) {
    if (field in finding && typeof finding[field] !== 'string') errors.push(`${field} must be a string`);
  }
  return errors;
}

function lineNumberAtIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findAnchorMatches(fileText, anchor) {
  const matches = [];
  let start = 0;
  while (true) {
    const index = fileText.indexOf(anchor, start);
    if (index === -1) break;
    matches.push({ index, line: lineNumberAtIndex(fileText, index) });
    start = index + Math.max(anchor.length, 1);
  }
  return matches;
}

function filterMatchesByContext(fileText, matches, finding) {
  if (matches.length <= 1) return matches;
  const lines = fileText.split(/\r?\n/);
  return matches.filter(match => {
    const lineIndex = match.line - 1;
    if (finding.context_before) {
      const before = lines[lineIndex - 1];
      if ((before ?? '').trim() !== finding.context_before.trim()) return false;
    }
    if (finding.context_after) {
      const anchorLineCount = finding.line_anchor.split(/\r?\n/).length;
      const after = lines[lineIndex + anchorLineCount];
      if ((after ?? '').trim() !== finding.context_after.trim()) return false;
    }
    return true;
  });
}

function resolveLineAnchor(fileText, finding) {
  const rawMatches = findAnchorMatches(fileText, finding.line_anchor);
  const matches = filterMatchesByContext(fileText, rawMatches, finding);
  if (matches.length === 1) return { status: 'resolved', line: matches[0].line };
  if (matches.length === 0) return { status: 'unresolved_anchor' };
  return { status: 'ambiguous_anchor', matchCount: matches.length };
}

function parseRightLinesByPath(diffText) {
  const result = new Map();
  let currentPath = null;
  let rightLine = null;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentPath = null;
      rightLine = null;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      if (!result.has(currentPath)) result.set(currentPath, new Set());
      continue;
    }
    if (!currentPath) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (rightLine === null) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      result.get(currentPath).add(rightLine);
      rightLine++;
    } else if (line.startsWith(' ')) {
      result.get(currentPath).add(rightLine);
      rightLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    } else if (line === '\\ No newline at end of file') {
      continue;
    }
  }

  return result;
}

function isLineInDiff(rightLinesByPath, filePath, line) {
  return Boolean(rightLinesByPath.get(filePath)?.has(line));
}

function formatFindingBody(finding) {
  const labels = (finding.aspects || [finding.aspect]).map(a => `[${a}]`).join('');
  const severityLabel = SEVERITY_LABELS[finding.severity] || finding.severity;
  return `${labels} ${severityLabel}: ${finding.summary}
判定根拠: ${finding.severity_rationale}

${finding.body}`;
}

function formatFinalReviewBody({ posted, unresolved, rejected }) {
  const lines = [
    `Review Manager completed.`,
    `Posted inline findings: ${posted.length}`,
    `Unposted findings (anchor unresolved): ${unresolved.length}`,
    `Rejected malformed findings: ${rejected.length}`,
  ];
  if (posted.length === 0 && unresolved.length === 0 && rejected.length === 0) {
    lines.push('');
    lines.push('3観点とも機械的な指摘なし。');
  }
  if (unresolved.length) {
    lines.push('');
    lines.push('位置未解決finding:');
    for (const item of unresolved) {
      lines.push(`- [${item.finding.aspect}] ${item.finding.path}: ${item.status} — ${item.finding.summary}`);
    }
  }
  return lines.join('\n');
}

function runRequired(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

function loadFileAtCommit(headRefOid, filePath, cwd) {
  return runRequired('git', ['show', `${headRefOid}:${filePath}`], { cwd });
}

function postInlineComment(payload, finding) {
  runRequired('gh', [
    'api',
    `repos/${payload.repo}/pulls/${payload.pr}/comments`,
    '-X', 'POST',
    '-f', `body=${formatFindingBody(finding)}`,
    '-f', `commit_id=${payload.headRefOid}`,
    '-f', `path=${finding.path}`,
    '-F', `line=${finding.resolved_line}`,
    '-f', 'side=RIGHT',
  ]);
}

function postFinalReview(payload, body) {
  runRequired('gh', [
    'api',
    `repos/${payload.repo}/pulls/${payload.pr}/reviews`,
    '-X', 'POST',
    '-f', `body=${body}`,
    '-f', 'event=COMMENT',
  ]);
}

function processFindings(payload, options = {}) {
  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) {
    throw new Error(payloadValidation.errors.join('; '));
  }

  const rejected = [];
  const candidates = [];
  for (const finding of payload.findings) {
    const errors = validateFinding(finding);
    if (errors.length) rejected.push({ finding, errors });
    else candidates.push(finding);
  }

  const diffText = options.diffText ?? runRequired('gh', ['pr', 'diff', String(payload.pr), '--repo', payload.repo]);
  const rightLinesByPath = parseRightLinesByPath(diffText);
  const cwd = options.cwd || process.cwd();
  const resolved = [];
  const unresolved = [];

  const fileCache = new Map();
  for (const finding of candidates) {
    try {
      if (!fileCache.has(finding.path)) {
        fileCache.set(finding.path, options.files?.[finding.path] ?? loadFileAtCommit(payload.headRefOid, finding.path, cwd));
      }
      const lineResult = resolveLineAnchor(fileCache.get(finding.path), finding);
      if (lineResult.status !== 'resolved') {
        unresolved.push({ finding, status: lineResult.status });
        continue;
      }
      if (!isLineInDiff(rightLinesByPath, finding.path, lineResult.line)) {
        unresolved.push({ finding, status: 'diff_outside_anchor', resolved_line: lineResult.line });
        continue;
      }
      resolved.push({ ...finding, resolved_line: lineResult.line });
    } catch (e) {
      unresolved.push({ finding, status: 'file_unavailable', error: e.message });
    }
  }

  return {
    posted: resolved,
    unresolved,
    rejected,
  };
}

function publish(payload, options = {}) {
  const result = processFindings(payload, options);
  if (!options.dryRun) {
    for (const finding of result.posted) postInlineComment(payload, finding);
    postFinalReview(payload, formatFinalReviewBody(result));
  }
  return result;
}

module.exports = {
  validatePayload,
  validateFinding,
  resolveLineAnchor,
  parseRightLinesByPath,
  isLineInDiff,
  formatFindingBody,
  formatFinalReviewBody,
  processFindings,
  publish,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const dryRun = args.includes('--dry-run');
  const file = args.find(arg => arg !== '--dry-run');
  if (!file) {
    console.error(USAGE);
    process.exit(1);
  }
  try {
    const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const result = publish(payload, { dryRun });
    if (dryRun) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    console.error(`review-publisher: ${e.message}`);
    process.exit(1);
  }
}
