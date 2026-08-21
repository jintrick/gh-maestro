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
} = require('../scripts/shared/test-declaration');

const MARKER = '<!-- gh-maestro-test-result:v1 -->';

function declarationBody(commit, fail, pass) {
  const passPart = pass === undefined ? '' : `, pass: ${pass}`;
  return `${MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}${passPart})`;
}

function prView(comments, headRefOid = 'a1b2c3d4e5f6', author = 'owner') {
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

test('buildPrViewArgs: gh pr viewにPR番号・repo・必要なJSONフィールドを渡す', () => {
  assert.deepEqual(buildPrViewArgs('42', 'owner/repo'), [
    'pr', 'view', '42',
    '--repo', 'owner/repo',
    '--json', 'comments,headRefOid,author',
  ]);
});

test('共有ルール: 申告コメントから値を抽出し、SHA一致fail 0をGREENにする', () => {
  const declaration = extractTestDeclaration(declarationBody('a1b2c3d', 0, 1826));
  assert.deepEqual(declaration, { commit: 'a1b2c3d', fail: 0, pass: 1826 });
  assert.deepEqual(evaluateTestDeclaration(declaration, 'a1b2c3d4e5f6'), {
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: 'a1b2c3d4e5f6',
    fail: 0,
    pass: 1826,
  });
});

test('共有ルール: 最新の信頼できる申告だけを採用し、第三者の申告を除外する', () => {
  const comments = [
    prComment(declarationBody('1111111', 0), 'owner'),
    prComment(declarationBody('2222222', 3), 'stranger', 'CONTRIBUTOR'),
    prComment(declarationBody('3333333', 0), 'maintainer', 'MEMBER'),
  ];
  assert.deepEqual(findLatestTrustedTestDeclaration(comments, 'owner'), {
    commit: '3333333',
    fail: 0,
    pass: undefined,
  });

  assert.deepEqual(findLatestTrustedTestDeclaration([
    prComment(declarationBody('4444444', 0), 'stranger', 'CONTRIBUTOR'),
  ], 'owner'), null);
});

test('queryTestStatus: 申告あり・SHA一致・fail 0 → GREEN', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(declarationBody('a1b2c3d', 0, 1826))]) }
  );

  assert.deepEqual(result, {
    ok: true,
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: 'a1b2c3d4e5f6',
    fail: 0,
    pass: 1826,
  });
});

test('queryTestStatus: 申告あり・SHA不一致 → STALE', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(declarationBody('1111111', 0))]) }
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'STALE');
  assert.equal(result.declaredSha, '1111111');
  assert.equal(result.headSha, 'a1b2c3d4e5f6');
});

test('queryTestStatus: 申告なし → NONE', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([]) }
  );

  assert.deepEqual(result, {
    ok: true,
    status: 'NONE',
    headSha: 'a1b2c3d4e5f6',
  });
});

test('queryTestStatus: 申告あり・SHA一致・fail > 0 → RED', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(declarationBody('a1b2c3d4e5f6', 2, 10))]) }
  );

  assert.deepEqual(result, {
    ok: true,
    status: 'RED',
    declaredSha: 'a1b2c3d4e5f6',
    headSha: 'a1b2c3d4e5f6',
    fail: 2,
    pass: 10,
  });
});

test('queryTestStatus: PR作成者の古い申告を、第三者の新しい申告より優先する', () => {
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    {
      ghPrViewFn: () => prView([
        prComment(declarationBody('a1b2c3d', 0), 'owner'),
        prComment(declarationBody('a1b2c3d4e5f6', 5), 'stranger', 'CONTRIBUTOR'),
      ]),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'GREEN');
  assert.equal(result.fail, 0);
});

test('queryTestStatus: PR番号不正をGitHubアクセス前に拒否する', () => {
  let ghCalled = false;
  const result = queryTestStatus(
    { pr: '../42', repo: 'owner/repo' },
    { ghPrViewFn: () => { ghCalled = true; return prView([]); } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /--pr/);
  assert.equal(ghCalled, false);
});

test('queryTestStatus: GitHub失敗時はNONEに丸めずエラーを返す', () => {
  let ghCalled = false;
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    {
      ghPrViewFn: () => {
        ghCalled = true;
        return { status: 1, stdout: '', stderr: 'network unavailable' };
      },
    }
  );

  assert.equal(ghCalled, true);
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

test('main: --help は終了コード0でusageを返す', () => {
  const result = main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, USAGE);
});

test('main: 必須フラグ欠落時は終了コード1でusageをstderrへ返す', () => {
  const result = main([]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /必須/);
  assert.match(result.stderr, /query-test-status\.js/);
});

test('main: 成功時は状態と事実をJSON 1行として返す', () => {
  const result = main(
    ['--pr', '42', '--repo', 'owner/repo'],
    { ghPrViewFn: () => prView([prComment(declarationBody('a1b2c3d', 0, 1826))]) }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, JSON.stringify({
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: 'a1b2c3d4e5f6',
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
