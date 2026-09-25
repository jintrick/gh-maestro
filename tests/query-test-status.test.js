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
- **実行範囲**: \`${scope}\`
- **lint**: pass (findings: 0)`;
}

function aggregateDeclarationBody(commit = SHA, includeSlow = true) {
  const slow = includeSlow ? `
  - **slow**: fail (fail: 1, pass: 9), tests: 10, executor: \`poll-pr\`, scope: \`partial\`, 実行記録: \`C:/runtime/slow.log\`` : '';
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: pass
- **実行元**: \`test-runner\`
- **実行範囲**: \`aggregate\`
- **lint**: pass (findings: 0)
- **層別結果**:
  - **full**: pass (fail: 0, pass: 1826), tests: 1826, executor: \`test-runner\`, scope: \`full\`${slow}`;
}

function outcomeOnlyDeclarationBody(commit = 'a1b2c3d', outcome = 'pass', scope = 'full') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${outcome}
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
    outcome: 'pass',
    fail: 0,
    pass: 1826,
    tests: 1826,
    provenance: 'test-runner',
    scope: 'full',
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
  });
  assert.deepEqual(evaluateTestDeclaration(declaration, SHA), {
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: SHA,
    fail: 0,
    pass: 1826,
    provenance: 'test-runner',
    scope: 'full',
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
  });

  const outcomeOnly = extractTestDeclaration(outcomeOnlyDeclarationBody());
  assert.deepEqual(outcomeOnly, {
    version: 2,
    commit: 'a1b2c3d',
    outcome: 'pass',
    provenance: 'test-runner',
    scope: 'full',
    lint: { status: 'missing', reason: 'lint-result-missing' },
  });
  assert.deepEqual(evaluateTestDeclaration(outcomeOnly, SHA), {
    status: 'GREEN',
    declaredSha: 'a1b2c3d',
    headSha: SHA,
    provenance: 'test-runner',
    scope: 'full',
    lint: { status: 'missing', reason: 'lint-result-missing' },
  });
});

test('共有ルール: aggregate は層別結果と全層充足性を抽出する', () => {
  const declaration = extractTestDeclaration(aggregateDeclarationBody());
  assert.deepEqual(declaration, {
    version: 2,
    commit: SHA,
    outcome: 'pass',
    provenance: 'test-runner',
    scope: 'aggregate',
    layers: {
      full: {
        layer: 'full', outcome: 'pass', fail: 0, pass: 1826, tests: 1826,
        executor: 'test-runner', scope: 'full',
      },
      slow: {
        layer: 'slow', outcome: 'fail', fail: 1, pass: 9, tests: 10,
        executor: 'poll-pr', scope: 'partial', executionLogPath: 'C:/runtime/slow.log',
      },
    },
    allLayersPresent: true,
    allLayersComplete: true,
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
  });
  assert.deepEqual(evaluateTestDeclaration(declaration, SHA), {
    status: 'GREEN',
    declaredSha: SHA,
    headSha: SHA,
    provenance: 'test-runner',
    scope: 'aggregate',
    layers: declaration.layers,
    allLayersPresent: true,
    allLayersComplete: true,
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
  });
});

test('queryTestStatus: aggregate はfull/slowの層別結果と不足層を返す', () => {
  const complete = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(aggregateDeclarationBody())]) },
  );
  assert.equal(complete.status, 'GREEN');
  assert.equal(complete.scope, 'aggregate');
  assert.equal(complete.layers.full.pass, 1826);
  assert.equal(complete.layers.slow.fail, 1);
  assert.equal(complete.allLayersPresent, true);
  assert.equal(complete.allLayersComplete, true);

  const partial = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(aggregateDeclarationBody(SHA, false))]) },
  );
  assert.equal(partial.status, 'GREEN');
  assert.deepEqual(partial.layers, {
    full: {
      layer: 'full', outcome: 'pass', fail: 0, pass: 1826, tests: 1826,
      executor: 'test-runner', scope: 'full',
    },
  });
  assert.equal(partial.allLayersPresent, false);
  assert.equal(partial.allLayersComplete, false);
});

test('queryTestStatus: lintの4状態を既存の照会JSONへ含める', () => {
  const cases = [
    ['pass (findings: 0)', { status: 'complete', outcome: 'pass', findingCount: 0 }],
    ['findings (findings: 2)', { status: 'complete', outcome: 'findings', findingCount: 2 }],
    ['unavailable, reason: lint-output-invalid', { status: 'unavailable', reason: 'lint-output-invalid' }],
    ['missing, reason: lint-result-missing', { status: 'missing', reason: 'lint-result-missing' }],
  ];
  for (const [line, expected] of cases) {
    const body = fullDeclarationBody().replace(/- \*\*lint\*\*:.*$/, `- **lint**: ${line}`);
    const result = queryTestStatus(
      { pr: '42', repo: 'owner/repo' },
      { ghPrViewFn: () => prView([prComment(body)]) },
    );
    assert.deepEqual(result.lint, expected);
    assert.equal(result.status, 'GREEN');

    const cliResult = main(
      ['--pr', '42', '--repo', 'owner/repo'],
      { ghPrViewFn: () => prView([prComment(body)]) },
    );
    assert.equal(cliResult.exitCode, 0);
    assert.deepEqual(JSON.parse(cliResult.stdout).lint, expected);
  }
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
    lint: { status: 'missing', reason: 'lint-result-missing' },
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
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
  });
});

test('queryTestStatus: 不明なfindings件数を0としてJSONへ出力しない', () => {
  const declarationBody = fullDeclarationBody()
    .replace('- **lint**: pass (findings: 0)', '- **lint**: findings');
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(declarationBody)]) },
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
    lint: { status: 'complete', outcome: 'findings' },
  });

  const output = main(
    ['--pr', '42', '--repo', 'owner/repo'],
    { ghPrViewFn: () => prView([prComment(declarationBody)]) },
  );
  assert.equal(output.exitCode, 0);
  assert.doesNotMatch(output.stdout, /"findingCount":0/);
  assert.match(output.stdout, /"outcome":"findings"/);
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
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
  });

  const outcomeOnly = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(outcomeOnlyDeclarationBody(SHA, 'fail', 'partial'))]) },
  );
  assert.deepEqual(outcomeOnly, {
    ok: true,
    status: 'RED',
    declaredSha: SHA,
    headSha: SHA,
    provenance: 'test-runner',
    scope: 'partial',
    lint: { status: 'missing', reason: 'lint-result-missing' },
  });

  const exitCodeAuthoritative = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(
      fullDeclarationBody(SHA, 0, 10, 'partial').replace('**結果**: pass', '**結果**: fail'),
    )]) },
  );
  assert.equal(exitCodeAuthoritative.status, 'RED');
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
    lint: { status: 'missing', reason: 'lint-result-missing' },
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
    lint: { status: 'missing', reason: 'lint-result-missing' },
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
    lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
    declaredSha: 'a1b2c3d',
    headSha: SHA,
    fail: 0,
    pass: 1826,
  }));
  assert.doesNotMatch(result.stdout, /\n/);
});

test('main: aggregate申告の層別結果と充足性をJSONへ含める', () => {
  const result = main(
    ['--pr', '42', '--repo', 'owner/repo'],
    { ghPrViewFn: () => prView([prComment(aggregateDeclarationBody())]) },
  );
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.scope, 'aggregate');
  assert.equal(parsed.layers.full.executor, 'test-runner');
  assert.equal(parsed.layers.slow.scope, 'partial');
  assert.equal(parsed.allLayersPresent, true);
  assert.equal(parsed.allLayersComplete, true);
  assert.doesNotMatch(result.stdout, /\n/);
});

test('main: 未知フラグを受け入れない', () => {
  const result = main(['--pr', '42', '--bogus']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /未知のフラグ/);
});

test('queryTestStatus: 層別結果の失敗テスト名（failedTests）と上限超過件数（otherFailedCount）を抽出して返す', () => {
  const commentBody = `<!-- gh-maestro-test-result:v2 -->
### 🧪 テスト結果申告
- **対象コミット**: \`${SHA}\`
- **結果**: fail
- **実行元**: \`test-runner\`
- **実行範囲**: \`aggregate\`
- **lint**: pass (findings: 0)
- **層別結果**:
  - **full**: fail (fail: 7, pass: 10), tests: 17, executor: \`local\`, scope: \`full\`, 失敗: \`test 1\`, \`test 2\`, \`test 3\`, \`test 4\`, \`test 5\`（他2件）
  - **slow**: fail (fail: 1, pass: 5), tests: 6, executor: \`poll-pr\`, scope: \`partial\`, 実行記録: \`slow.log\`, 失敗: \`slow test failure\`
`;
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(commentBody)]) },
  );
  assert.equal(result.status, 'RED');
  assert.equal(result.scope, 'aggregate');
  assert.deepEqual(result.layers.full.failedTests, ['test 1', 'test 2', 'test 3', 'test 4', 'test 5']);
  assert.equal(result.layers.full.otherFailedCount, 2);
  assert.deepEqual(result.layers.slow.failedTests, ['slow test failure']);
  assert.equal(result.layers.slow.otherFailedCount, 0);
});

test('queryTestStatus: テスト名に fail: 0 や pass: 99 や scope: full 等の紛らわしい文字列が含まれていても件数やステータス判定を壊さない', () => {
  const commentBody = `<!-- gh-maestro-test-result:v2 -->
### 🧪 テスト結果申告
- **対象コミット**: \`${SHA}\`
- **結果**: fail
- **実行元**: \`test-runner\`
- **実行範囲**: \`aggregate\`
- **lint**: pass (findings: 0)
- **層別結果**:
  - **full**: fail (fail: 1, pass: 9), tests: 10, executor: \`local\`, scope: \`full\`, 失敗: \`check that fail: 0 and pass: 99 works with scope: 'full' and executor: 'fake'\`
  - **slow**: pass (fail: 0, pass: 5), tests: 5, executor: \`poll-pr\`, scope: \`partial\`, 実行記録: \`slow.log\`
`;
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(commentBody)]) },
  );
  assert.equal(result.status, 'RED');
  assert.equal(result.layers.full.fail, 1);
  assert.equal(result.layers.full.pass, 9);
  assert.equal(result.layers.full.tests, 10);
  assert.equal(result.layers.full.executor, 'local');
  assert.equal(result.layers.full.scope, 'full');
  assert.deepEqual(result.layers.full.failedTests, [
    "check that fail: 0 and pass: 99 works with scope: 'full' and executor: 'fake'",
  ]);
  assert.equal(result.layers.full.otherFailedCount, 0);
});

test('queryTestStatus: テスト名に「（他N件）」が含まれていても超過件数として誤認しない', () => {
  const commentBody = `<!-- gh-maestro-test-result:v2 -->
### 🧪 テスト結果申告
- **対象コミット**: \`${SHA}\`
- **結果**: fail
- **実行元**: \`test-runner\`
- **実行範囲**: \`aggregate\`
- **lint**: pass (findings: 0)
- **層別結果**:
  - **full**: fail (fail: 1, pass: 9), tests: 10, executor: \`local\`, scope: \`full\`, 失敗: \`test with (他99件) and （他50件） in name\`
  - **slow**: fail (fail: 7, pass: 0), tests: 7, executor: \`poll-pr\`, scope: \`partial\`, 実行記録: \`slow.log\`, 失敗: \`t1\`, \`t2\`, \`t3\`, \`t4\`, \`t5（他100件）\`（他2件）
`;
  const result = queryTestStatus(
    { pr: '42', repo: 'owner/repo' },
    { ghPrViewFn: () => prView([prComment(commentBody)]) },
  );
  assert.equal(result.status, 'RED');
  // full層: テスト名に（他99件）等があっても超過なしなので otherFailedCount は 0
  assert.deepEqual(result.layers.full.failedTests, ['test with (他99件) and （他50件） in name']);
  assert.equal(result.layers.full.otherFailedCount, 0);

  // slow層: 5つ目のテスト名に（他100件）があっても、末尾の「（他2件）」が正しく otherFailedCount = 2 として解釈される
  assert.deepEqual(result.layers.slow.failedTests, ['t1', 't2', 't3', 't4', 't5（他100件）']);
  assert.equal(result.layers.slow.otherFailedCount, 2);
});

test('main: --help は終了コード0で usage を返し、failedTests の説明を含む', () => {
  const result = main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /failedTests and otherFailedCount/);
});

