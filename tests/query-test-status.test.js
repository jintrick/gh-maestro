'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  USAGE,
  buildPrViewArgs,
  normalizePrNumber,
  parsePrViewResponse,
  queryTestStatus,
  main,
} = require('../scripts/query-test-status');
const {
  extractTestDeclaration,
  evaluateTestDeclaration,
  findLatestTrustedTestDeclaration,
  TEST_RESULT_MARKER,
  LEGACY_TEST_RESULT_MARKER,
} = require('../scripts/shared/test-declaration');

const SHA = 'a1b2c3d4e5f6';

function fullDeclarationBody(commit = 'a1b2c3d', fail = 0, pass = 1826, scope = 'full') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}, pass: ${pass})
- **実行件数**: \`${fail + pass}\`
- **実行元**: \`test-runner\`
- **実行範囲**: \`${scope}\``;
}

function legacyDeclarationBody(commit, fail, pass) {
  const passPart = pass === undefined ? '' : `, pass: ${pass}`;
  return `${LEGACY_TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}${passPart})`;
}

function prView(comments, headRefOid = SHA, author = 'owner') {
  return {
    status: 0,
    stdout: JSON.stringify({
      comments,
      headRefOid,
      author: author === null ? null : { login: author },
    }),
    stderr: '',
  };
}

function prComment(body, author = 'owner', authorAssociation = 'CONTRIBUTOR') {
  return { body, author: { login: author }, authorAssociation };
}

test('normalizePrNumber: 正の整数だけを正規化する', () => {
  assert.equal(normalizePrNumber('42'), '42');
  assert.equal(normalizePrNumber(42), '42');
  assert.equal(normalizePrNumber('0'), null);
  assert.equal(normalizePrNumber('042'), null);
  assert.equal(normalizePrNumber('42x'), null);
  assert.equal(normalizePrNumber(undefined), null);
});

test('buildPrViewArgs: gh pr view にPR番号・repo・必要なJSONフィールドを渡す', () => {
  assert.deepEqual(buildPrViewArgs('42', 'owner/repo'), [
    'pr', 'view', '42', '--repo', 'owner/repo', '--json', 'comments,headRefOid,author',
  ]);
});

test('共有ルール: v2 full の provenance/scope と件数を抽出する', () => {
  const declaration = extractTestDeclaration(fullDeclarationBody());
  assert.deepEqual(declaration, {
    version: 2,
    commit: 'a1b2c3d',
    fail: 0,
    pass: 1826,
    tests: 1826,
    provenance: 'test-runner',
    scope: 'full',
  });
  assert.deepEqual(evaluateTestDeclaration(declaration, SHA), {
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: SHA,
    fail: 0,
    pass: 1826,
    provenance: 'test-runner',
    scope: 'full',
  });
});

test('共有ルール: v1 は値を読めても provenance/scope が unknown になる', () => {
  const declaration = extractTestDeclaration(legacyDeclarationBody('a1b2c3d', 0, 1826));
  assert.deepEqual(declaration, {
    version: 1,
    commit: 'a1b2c3d',
    fail: 0,
    pass: 1826,
    provenance: 'unknown',
    scope: 'unknown',
  });
  const evaluation = evaluateTestDeclaration(declaration, SHA);
  assert.equal(evaluation.status, 'GREEN');
  assert.equal(evaluation.provenance, 'unknown');
  assert.equal(evaluation.scope, 'unknown');
});

test('共有ルール: 最新の信頼できる申告だけを採用し、第三者の申告を除外する', () => {
  const comments = [
    prComment(fullDeclarationBody('1111111', 0, 10), 'owner'),
    prComment(fullDeclarationBody('2222222', 3, 7), 'stranger', 'CONTRIBUTOR'),
    prComment(fullDeclarationBody('3333333', 0, 10), 'maintainer', 'MEMBER'),
  ];
  assert.equal(findLatestTrustedTestDeclaration(comments, 'owner').commit, '3333333');
  assert.equal(findLatestTrustedTestDeclaration(comments, 'owner').provenance, 'test-runner');
  assert.equal(findLatestTrustedTestDeclaration([
    prComment(fullDeclarationBody('4444444', 0, 10), 'stranger', 'CONTRIBUTOR'),
  ], 'owner'), null);
});

test('queryTestStatus: v2 full のSHA一致・fail 0 → GREEN と full を返す', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(fullDeclarationBody())]) },
  );

  assert.deepEqual(result, {
    ok: true,
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: SHA,
    fail: 0,
    pass: 1826,
    provenance: 'test-runner',
    scope: 'full',
  });
});

test('queryTestStatus: v2 partial のfail > 0 → RED と partial を返す', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(fullDeclarationBody(SHA, 2, 10, 'partial'))]) },
  );

  assert.deepEqual(result, {
    ok: true,
    status: 'RED',
    declaredSha: SHA,
    headSha: SHA,
    fail: 2,
    pass: 10,
    provenance: 'test-runner',
    scope: 'partial',
  });
});

test('queryTestStatus: v1 と不完全なv2を full と取り違えず unknown として返す', () => {
  const legacy = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(legacyDeclarationBody('a1b2c3d', 0, 1826))]) },
  );
  assert.equal(legacy.status, 'GREEN');
  assert.equal(legacy.provenance, 'unknown');
  assert.equal(legacy.scope, 'unknown');

  const incompleteV2 = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(`${TEST_RESULT_MARKER}
- **対象コミット**: \`${SHA}\`
- **結果**: pass (fail: 0, pass: 10)`)]) },
  );
  assert.deepEqual(incompleteV2, {
    ok: true,
    status: 'NONE',
    declaredSha: SHA,
    headSha: SHA,
    provenance: 'unknown',
    scope: 'unknown',
  });
});

test('queryTestStatus: 申告なし → NONE と none metadata', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([]) },
  );
  assert.deepEqual(result, {
    ok: true,
    status: 'NONE',
    headSha: SHA,
    provenance: 'none',
    scope: 'none',
  });
});

test('queryTestStatus: 申告あり・SHA不一致 → STALE でも provenance/scope を保持する', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(fullDeclarationBody('1111111', 0, 10))]) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'STALE');
  assert.equal(result.provenance, 'test-runner');
  assert.equal(result.scope, 'full');
});

test('queryTestStatus: PR番号不正をGitHubアクセス前に拒否する', () => {
  let ghCalled = false;
  const result = queryTestStatus(
    { pr: '../42', repo: 'owner/repo' },
    { ghPrViewFn: () => { ghCalled = true; return prView([]); } },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /--pr/);
  assert.equal(ghCalled, false);
});

test('queryTestStatus: GitHub失敗時はNONEに丸めずエラーを返す', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => ({ status: 1, stdout: '', stderr: 'network unavailable' }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /network unavailable/);
});

test('parsePrViewResponse: 壊れたJSON・誤ったフィールド型を拒否する', () => {
  assert.equal(parsePrViewResponse('{not json').ok, false);
  assert.equal(parsePrViewResponse(JSON.stringify({ comments: {} })).ok, false);
  assert.equal(parsePrViewResponse(JSON.stringify({ headRefOid: 123 })).ok, false);
  assert.equal(parsePrViewResponse(JSON.stringify({ author: 'owner' })).ok, false);
});

test('parsePrViewResponse: headRefOid欠落は照合不能として空SHAを返す', () => {
  assert.deepEqual(parsePrViewResponse(JSON.stringify({ comments: [] })), {
    ok: true,
    comments: [],
    headSha: '',
    prAuthor: undefined,
  });
});

test('main: --help と必須フラグ欠落を処理する', () => {
  const help = main(['--help']);
  assert.equal(help.exitCode, 0);
  assert.equal(help.stdout, USAGE);

  const missing = main([]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /必須/);
  assert.match(missing.stderr, /query-test-status\.js/);
});

test('main: 成功時JSONに provenance/scope を含め、1行で返す', () => {
  const result = main(
    ['--pr', '42', '--repo', 'owner/repo'],
    { ghPrViewFn: () => prView([prComment(fullDeclarationBody())]) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, JSON.stringify({
    status: 'GREEN',
    provenance: 'test-runner',
    scope: 'full',
    declaredSha: 'a1b2c3d',
    headSha: SHA,
    fail: 0,
    pass: 1826,
  }));
  assert.doesNotMatch(result.stdout, /\n/);
});

test('main: 未知フラグを受け入れない', () => {
  const result = main(['--pr', '42', '--bogus']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /未知のフラグ/);
});
