'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateFinding,
  resolveLineAnchor,
  parseRightLinesByPath,
  isLineInDiff,
  processFindings,
} = require('../scripts/review-publisher');

function finding(overrides = {}) {
  return {
    aspect: 'Correctness',
    path: 'src/foo.ts',
    line_anchor: 'await saveUser(user)',
    summary: 'Save is not awaited',
    severity: 'BLOCKER',
    severity_rationale: 'APIが成功を返した後に永続化が失敗するとデータ損失が発生する',
    body: '変更後のコードは saveUser(user) を await せずに呼び出している。saveUser が reject されると API は成功を返しているにもかかわらずデータが永続化されない。await を追加して修正する。',
    verified_references: ['src/foo.ts'],
    ...overrides,
  };
}

test('validateFinding rejects blank required fields and empty references', () => {
  const errors = validateFinding(finding({ summary: '...', verified_references: [] }));
  assert.ok(errors.includes('summary is blank'));
  assert.ok(errors.includes('verified_references must be a non-empty array'));
});

test('validateFinding rejects invalid severity', () => {
  const errors = validateFinding(finding({ severity: 'CRITICAL' }));
  assert.ok(errors.includes('severity is invalid (must be BLOCKER, MAJOR, or SUGGESTION)'));
});

test('validateFinding rejects missing severity', () => {
  const f = finding();
  delete f.severity;
  const errors = validateFinding(f);
  assert.ok(errors.includes('severity is required'));
});

test('validateFinding rejects blank body', () => {
  const errors = validateFinding(finding({ body: '<placeholder>' }));
  assert.ok(errors.includes('body is blank'));
});

test('validateFinding rejects blank severity_rationale', () => {
  const errors = validateFinding(finding({ severity_rationale: '...' }));
  assert.ok(errors.includes('severity_rationale is blank'));
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

test('processFindings rejects findings with missing severity', () => {
  const f = finding();
  delete f.severity;
  const payload = {
    pr: 1,
    repo: 'o/r',
    headRefOid: 'abc',
    findings: [f],
  };
  const result = processFindings(payload, {
    diffText: '',
  });
  assert.equal(result.posted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].errors.some(e => e.includes('severity is required')));
});
