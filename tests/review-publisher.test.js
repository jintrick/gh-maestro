'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateFinding,
  resolveLineAnchor,
  parseRightLinesByPath,
  isLineInDiff,
  dedupeFindings,
  processFindings,
} = require('../scripts/review-publisher');

function finding(overrides = {}) {
  return {
    aspect: 'Correctness',
    path: 'src/foo.ts',
    line_anchor: 'await saveUser(user)',
    summary: 'Save is not awaited',
    observed_fact: 'The changed code starts persistence without awaiting it.',
    invariant: 'The API must not report success before persistence completes.',
    failure_scenario: 'The write rejects after the response is returned.',
    minimal_fix: 'Await saveUser(user).',
    verified_references: ['src/foo.ts'],
    ...overrides,
  };
}

test('validateFinding rejects blank required fields and empty references', () => {
  const errors = validateFinding(finding({ summary: '...', verified_references: [] }));
  assert.ok(errors.includes('summary is blank'));
  assert.ok(errors.includes('verified_references must be a non-empty array'));
});

test('resolveLineAnchor resolves a unique anchor', () => {
  const file = [
    'async function main() {',
    '  await saveUser(user)',
    '  return user',
    '}',
  ].join('\n');
  assert.deepEqual(resolveLineAnchor(file, finding()), { status: 'resolved', line: 2 });
});

test('resolveLineAnchor uses context to disambiguate repeated anchors', () => {
  const file = [
    'if (first) {',
    '  await saveUser(user)',
    '}',
    'if (second) {',
    '  await saveUser(user)',
    '}',
  ].join('\n');
  assert.deepEqual(
    resolveLineAnchor(file, finding({ context_before: 'if (second) {' })),
    { status: 'resolved', line: 5 }
  );
});

test('parseRightLinesByPath records right-side hunk lines', () => {
  const diff = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -8,2 +10,3 @@',
    ' context',
    '-old',
    '+new',
    ' next',
  ].join('\n');
  const lines = parseRightLinesByPath(diff);
  assert.equal(isLineInDiff(lines, 'src/foo.ts', 10), true);
  assert.equal(isLineInDiff(lines, 'src/foo.ts', 11), true);
  assert.equal(isLineInDiff(lines, 'src/foo.ts', 12), true);
  assert.equal(isLineInDiff(lines, 'src/foo.ts', 9), false);
});

test('dedupeFindings merges identical concerns across aspects', () => {
  const a = { ...finding(), resolved_line: 2 };
  const b = { ...finding({ aspect: 'Resilience & Security' }), resolved_line: 2 };
  const result = dedupeFindings([a, b]);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].aspects, ['Correctness', 'Resilience & Security']);
  assert.equal(result.duplicates.length, 1);
});

test('processFindings resolves, checks diff, and separates unresolved findings', () => {
  const payload = {
    pr: 1,
    repo: 'o/r',
    headRefOid: 'abc',
    findings: [
      finding(),
      finding({ line_anchor: 'not in file', summary: 'Missing anchor' }),
    ],
  };
  const diffText = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,3 @@',
    ' async function main() {',
    '   await saveUser(user)',
    '   return user',
  ].join('\n');
  const result = processFindings(payload, {
    diffText,
    files: {
      'src/foo.ts': [
        'async function main() {',
        '  await saveUser(user)',
        '  return user',
      ].join('\n'),
    },
  });

  assert.equal(result.posted.length, 1);
  assert.equal(result.posted[0].resolved_line, 2);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].status, 'unresolved_anchor');
});
