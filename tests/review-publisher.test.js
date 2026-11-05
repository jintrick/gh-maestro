'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateFinding,
  resolveLineAnchor,
  parseRightLinesByPath,
  isLineInDiff,
  formatFinalReviewBody,
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
  // プレースホルダの body・severity_rationale も同じ検査（統合元: 47, 52）
  assert.ok(validateFinding(finding({ body: '<placeholder>' })).includes('body is blank'));
  assert.ok(validateFinding(finding({ severity_rationale: '...' })).includes('severity_rationale is blank'));
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

test('formatFinalReviewBody preserves severity and detail for unresolved findings', () => {
  const unresolvedFinding = finding({
    severity: 'MAJOR',
    summary: '保存失敗を呼び出し元へ通知できない',
    severity_rationale: '失敗を隠すと利用者は処理成功と誤認する',
    body: '保存処理の戻り値を確認し、失敗時は呼び出し元へエラーを返す。',
  });

  const body = formatFinalReviewBody({
    posted: [],
    unresolved: [{
      finding: unresolvedFinding,
      status: 'diff_outside_anchor',
      resolved_line: 12,
    }],
    rejected: [],
  });

  assert.match(body, /位置未解決finding:/);
  assert.match(body, /🟡 \*\*MAJOR\*\*: 保存失敗を呼び出し元へ通知できない/);
  assert.match(body, /対象パス: `src\/foo\.ts`/);
  assert.match(body, /位置解決状態: `diff_outside_anchor`/);
  assert.match(body, /解決行: 12/);
  assert.match(body, /判定根拠: 失敗を隠すと利用者は処理成功と誤認する/);
  assert.match(body, /保存処理の戻り値を確認し、失敗時は呼び出し元へエラーを返す。/);
});

test('buildFinalReviewBody appends the result marker after the summary', () => {
  const { buildFinalReviewBody } = require('../scripts/review-publisher');
  const crypto = require('crypto');
  const artifact = Buffer.from('{"pr":7}');
  const sha = crypto.createHash('sha256').update(artifact).digest('hex');
  const marker = `<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=${sha} -->`;
  const body = buildFinalReviewBody({ posted: [], unresolved: [], rejected: [] }, marker);
  assert.equal(body, `Review Manager completed.\nPosted inline findings: 0\nUnposted findings (anchor unresolved): 0\nRejected malformed findings: 0\n\n3観点とも機械的な指摘なし。\n\n${marker}`);
});

test('buildFinalReviewBody without a marker keeps the previous body unchanged', () => {
  const { buildFinalReviewBody, formatFinalReviewBody } = require('../scripts/review-publisher');
  const result = { posted: [], unresolved: [], rejected: [] };
  assert.equal(buildFinalReviewBody(result), formatFinalReviewBody(result));
});

test('publishArtifactFile puts the exact marker of the artifact bytes on the final review body', () => {
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const { publishArtifactFile } = require('../scripts/review-publisher');
  const { withTempDir } = require('../scripts/shared/temp-directory');
  withTempDir('gh-maestro-publisher-marker-', (dir) => {
    // 整形（改行・インデント）込みの既知のバイト列。JSONを再直列化した値の印とは一致しないことも確かめる。
    const bytes = Buffer.from('{\r\n  "pr": 7,\r\n  "repo": "owner/repo",\r\n  "headRefOid": "abc1234",\r\n  "findings": []\r\n}\r\n', 'utf8');
    const file = path.join(dir, 'manager.json');
    fs.writeFileSync(file, bytes);
    const expectedSha = crypto.createHash('sha256').update(bytes).digest('hex');
    const reserializedSha = crypto.createHash('sha256').update(JSON.stringify(JSON.parse(bytes.toString('utf8')))).digest('hex');
    assert.notEqual(expectedSha, reserializedSha, 'fixture must distinguish raw bytes from re-serialized JSON');

    const posted = [];
    publishArtifactFile(file, {
      diffText: '',
      postInlineReviewFn: () => { throw new Error('no inline findings expected'); },
      postFinalReviewFn: (payload, body) => posted.push({ payload, body }),
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].payload.pr, 7);
    assert.equal(
      posted[0].body,
      'Review Manager completed.\nPosted inline findings: 0\nUnposted findings (anchor unresolved): 0\nRejected malformed findings: 0\n\n3観点とも機械的な指摘なし。\n\n'
        + `<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=${expectedSha} -->`,
    );
  });
});
