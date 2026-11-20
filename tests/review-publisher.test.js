'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  validateFinding,
  resolveLineAnchor,
  parsePatchRightLines,
  parseRightLinesByPath,
  isLineInDiff,
  buildPullFilesJqFilter,
  partitionTargetPathsForJq,
  decodePrFilesBase64Lines,
  fetchPrFiles,
  formatFinalReviewBody,
  formatFindingBody,
  formatFileFinding,
  processFindings,
  publish,
  postInlineComment,
  postFileComment,
  postFinalReview,
  assertZeroExit,
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

test('parsePatchRightLines and parseRightLinesByPath record right-side hunk lines including ++ lines', () => {
  const patch = [
    '@@ -8,2 +10,4 @@',
    ' context',
    '-old',
    '+new',
    '+++kept_plus_line',
    ' next',
  ].join('\n');
  const patchLines = parsePatchRightLines(patch);
  assert.equal(patchLines.has(10), true);
  assert.equal(patchLines.has(11), true);
  assert.equal(patchLines.has(12), true);
  assert.equal(patchLines.has(13), true);
  assert.equal(patchLines.has(9), false);

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

test('processFindings resolves, checks prFiles patch, and separates unresolved findings', () => {
  const payload = {
    pr: 1,
    repo: 'o/r',
    headRefOid: 'abc',
    findings: [
      finding(),
      finding({ line_anchor: 'not in file', summary: 'Missing anchor' }),
    ],
  };
  const prFiles = [
    {
      filename: 'src/foo.ts',
      patch: [
        '@@ -1,3 +1,3 @@',
        ' async function main() {',
        '   await saveUser(user)',
        '   return user',
      ].join('\n'),
    },
  ];
  const result = processFindings(payload, {
    prFiles,
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

test('processFindings rejects findings with missing severity without calling gh', () => {
  const f = finding();
  delete f.severity;
  const payload = {
    pr: 1,
    repo: 'o/r',
    headRefOid: 'abc',
    findings: [f],
  };
  const spawnCalls = [];
  const result = processFindings(payload, {
    spawnFn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(spawnCalls.length, 0);
  assert.equal(result.posted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].errors.some(e => e.includes('severity is required')));
});

test('file-level finding body records why the line anchor was unavailable and keeps its identity marker', () => {
  const item = {
    finding: finding({
      severity: 'MAJOR',
      summary: '保存失敗を呼び出し元へ通知できない',
      severity_rationale: '失敗を隠すと利用者は処理成功と誤認する',
      body: '保存処理の戻り値を確認し、失敗時は呼び出し元へエラーを返す。',
    }),
    status: 'diff_outside_anchor',
    resolved_line: 12,
  };
  const marker = '<!-- gh-maestro:review-manager-finding:v1:pr=7:sha256=abc:finding=1 -->';
  const body = formatFileFinding(item, marker);
  assert.match(body, /🟡 \*\*MAJOR\*\*: 保存失敗を呼び出し元へ通知できない/);
  assert.match(body, /判定根拠: 失敗を隠すと利用者は処理成功と誤認する/);
  assert.match(body, /保存処理の戻り値を確認し、失敗時は呼び出し元へエラーを返す。/);
  assert.match(body, /位置に結び付けられなかったため、ファイル単位で投稿しました（diff_outside_anchor）。/);
  assert.match(body, /アンカー解決行: 12/);
  assert.match(body, /<!-- gh-maestro:review-manager-finding/);
  assert.match(formatFinalReviewBody({ posted: [], unresolved: [item], rejected: [] }), /Posted file-level findings: 1/);
});

test('review comment API arguments use line anchors for inline comments and subject_type=file without line fields for file threads', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const payload = { repo: 'acme/repo', pr: 12, headRefOid: 'deadbeef' };
  const marker = '<!-- gh-maestro:review-manager-finding:v1:pr=12:sha256=abc:finding=1 -->';

  postInlineComment(payload, { ...finding(), resolved_line: 8, review_finding_marker: marker }, spawn);
  postFileComment(payload, { finding: finding({ review_finding_marker: marker }), status: 'ambiguous_anchor' }, spawn);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args.slice(0, 6), ['api', 'repos/acme/repo/pulls/12/comments', '-X', 'POST', '-F', 'body=@-']);
  assert.ok(calls[0].args.includes('commit_id=deadbeef'));
  assert.ok(calls[0].args.includes('path=src/foo.ts'));
  assert.ok(calls[0].args.includes('line=8'));
  assert.ok(calls[0].args.includes('side=RIGHT'));
  assert.ok(calls[0].options.input.includes(marker));

  assert.deepEqual(calls[1].args, [
    'api',
    'repos/acme/repo/pulls/12/comments',
    '-X', 'POST',
    '-F', 'body=@-',
    '-f', 'commit_id=deadbeef',
    '-f', 'path=src/foo.ts',
    '-f', 'subject_type=file',
  ]);
  assert.equal(
    calls[1].options.input,
    '[Correctness] 🔴 **BLOCKER**: Save is not awaited\n判定根拠: APIが成功を返した後に永続化が失敗するとデータ損失が発生する\n\n変更後のコードは saveUser(user) を await せずに呼び出している。saveUser が reject されると API は成功を返しているにもかかわらずデータが永続化されない。await を追加して修正する。\n\n位置に結び付けられなかったため、ファイル単位で投稿しました（ambiguous_anchor）。\n\n' + marker
  );
  assert.ok(calls[1].args.includes('subject_type=file'));
  assert.ok(!calls[1].args.some((arg) => arg === 'line=8' || arg.startsWith('line=')));
  assert.ok(!calls[1].args.includes('side=RIGHT'));
  assert.ok(calls[1].options.input.includes('ambiguous_anchor'));
});

test('publish identifies every finding by raw artifact bytes and posts all threads before the final review', () => {
  const artifactBytes = Buffer.from('{"pr":7,\n "findings":[ {"summary":"line"}, {"summary":"file"} ]}\n');
  const payload = {
    pr: 7,
    repo: 'acme/repo',
    headRefOid: 'deadbeef',
    findings: [finding(), finding({ line_anchor: 'not present', summary: 'file finding' })],
  };
  const events = [];
  const result = publish(payload, {
    artifactBytes,
    resultMarker: '<!-- review result -->',
    prFiles: [
      {
        filename: 'src/foo.ts',
        patch: [
          '@@ -1,1 +1,1 @@',
          '+await saveUser(user)',
        ].join('\n'),
      },
    ],
    files: { 'src/foo.ts': 'await saveUser(user)\n' },
    postInlineReviewFn: (_payload, findingWithMarker) => events.push({ kind: 'line', marker: findingWithMarker.review_finding_marker }),
    postFileReviewFn: (_payload, item) => events.push({ kind: 'file', marker: item.finding.review_finding_marker }),
    postFinalReviewFn: (_payload, body) => events.push({ kind: 'final', body }),
  });

  const artifactHash = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  assert.equal(result.posted.length, 1);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(events.map((event) => event.kind), ['line', 'file', 'final']);
  assert.equal(events[0].marker, `<!-- gh-maestro:review-manager-finding:v1:pr=7:sha256=${artifactHash}:finding=1 -->`);
  assert.equal(events[1].marker, `<!-- gh-maestro:review-manager-finding:v1:pr=7:sha256=${artifactHash}:finding=2 -->`);
  assert.match(events[2].body, /Posted inline findings: 1/);
  assert.match(events[2].body, /Posted file-level findings: 1/);
});

test('publish skips the final review when posting any finding thread fails', () => {
  const events = [];
  assert.throws(() => publish({
    pr: 7,
    repo: 'acme/repo',
    headRefOid: 'deadbeef',
    findings: [finding(), finding({ line_anchor: 'missing anchor', summary: 'file finding' })],
  }, {
    artifactBytes: Buffer.from('artifact'),
    prFiles: [
      {
        filename: 'src/foo.ts',
        patch: [
          '@@ -1,1 +1,1 @@',
          '+await saveUser(user)',
        ].join('\n'),
      },
    ],
    files: { 'src/foo.ts': 'await saveUser(user)\n' },
    postInlineReviewFn: () => events.push('inline'),
    postFileReviewFn: () => {
      events.push('file');
      throw new Error('GitHub rejected file-level thread');
    },
    postFinalReviewFn: () => events.push('final'),
  }), /GitHub rejected file-level thread/);

  assert.deepEqual(events, ['inline', 'file']);
});

test('buildFinalReviewBody appends the result marker after the summary', () => {
  const { buildFinalReviewBody } = require('../scripts/review-publisher');
  const crypto = require('crypto');
  const artifact = Buffer.from('{"pr":7}');
  const sha = crypto.createHash('sha256').update(artifact).digest('hex');
  const marker = `<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=${sha} -->`;
  const body = buildFinalReviewBody({ posted: [], unresolved: [], rejected: [] }, marker);
  assert.equal(body, `Review Manager completed.\nPosted inline findings: 0\nPosted file-level findings: 0\nRejected malformed findings: 0\n\n3観点とも機械的な指摘なし。\n\n${marker}`);
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
      postInlineReviewFn: () => { throw new Error('no inline findings expected'); },
      postFinalReviewFn: (payload, body) => posted.push({ payload, body }),
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].payload.pr, 7);
    assert.equal(
      posted[0].body,
      'Review Manager completed.\nPosted inline findings: 0\nPosted file-level findings: 0\nRejected malformed findings: 0\n\n3観点とも機械的な指摘なし。\n\n'
        + `<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=${expectedSha} -->`,
    );
  });
});

test('postInlineComment / postFileComment / postFinalReview: 32KB超の日本語本文を argv に載せず -F body=@- と opts.input (UTF-8) で渡す', () => {
  const largeJapaneseText = '日本語のレビュー指摘詳細・根拠説明。\n'.repeat(1800);
  assert.ok(Buffer.byteLength(largeJapaneseText, 'utf8') > 32768, 'テスト前提: 32KB超の日本語本文');

  const payload = { repo: 'acme/repo', pr: 12, headRefOid: 'deadbeef' };
  const marker = '<!-- gh-maestro:review-manager-finding:v1:pr=12:sha256=abc:finding=1 -->';
  const inlineFinding = { ...finding({ body: largeJapaneseText }), resolved_line: 8, review_finding_marker: marker };
  const fileItem = { finding: finding({ body: largeJapaneseText, review_finding_marker: marker }), status: 'unresolved_anchor' };

  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '{}', stderr: '' };
  };

  postInlineComment(payload, inlineFinding, spawn);
  postFileComment(payload, fileItem, spawn);
  postFinalReview(payload, largeJapaneseText, spawn);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, [
    'api', 'repos/acme/repo/pulls/12/comments', '-X', 'POST', '-F', 'body=@-',
    '-f', 'commit_id=deadbeef', '-f', 'path=src/foo.ts', '-F', 'line=8', '-f', 'side=RIGHT',
  ]);
  assert.equal(calls[0].options.input, formatFindingBody(inlineFinding, marker));

  assert.deepEqual(calls[1].args, [
    'api', 'repos/acme/repo/pulls/12/comments', '-X', 'POST', '-F', 'body=@-',
    '-f', 'commit_id=deadbeef', '-f', 'path=src/foo.ts', '-f', 'subject_type=file',
  ]);
  assert.equal(calls[1].options.input, formatFileFinding(fileItem, marker));

  assert.deepEqual(calls[2].args, [
    'api', 'repos/acme/repo/pulls/12/reviews', '-X', 'POST', '-F', 'body=@-', '-f', 'event=COMMENT',
  ]);
  assert.equal(calls[2].options.input, largeJapaneseText);

  for (const call of calls) {
    assert.equal(call.command, 'gh');
    assert.ok(call.args.join(' ').length < 512, 'argv に長文本文を含めない');
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.timeout, 30000);
    assert.ok(Buffer.byteLength(call.options.input, 'utf8') > 32768);
  }

  assert.throws(
    () => postFinalReview(payload, 'x', () => ({ status: null, stdout: '', stderr: '', error: new Error('spawnSync gh EPIPE') })),
    /spawnSync gh EPIPE/
  );
});

test('processFindings / postFinalReview: 起動エラー（signal なし・途中までの stdout を伴うもの）でエラー内容・終了ステータスを残し途中 stdout で隠さない', () => {
  const payload = { pr: 42, repo: 'acme/repo', headRefOid: 'deadbeef', findings: [finding()] };
  let diffError;
  assert.throws(
    () => processFindings(payload, {
      spawnFn: () => ({
        status: null,
        signal: null,
        stdout: '{"filename":"partial.js"}',
        stderr: '',
        error: new Error('spawnSync gh ENOBUFS'),
      }),
    }),
    (err) => {
      diffError = err;
      return true;
    }
  );
  assert.match(diffError.message, /status=null/);
  assert.doesNotMatch(diffError.message, /signal=/);
  assert.match(diffError.message, /error=spawnSync gh ENOBUFS/);
  assert.doesNotMatch(diffError.message, /partial\.js/);

  let apiError;
  assert.throws(
    () => postFinalReview(payload, 'body', () => ({
      status: null,
      signal: null,
      stdout: 'partial api stdout',
      stderr: 'partial stderr',
      error: new Error('spawnSync gh ETIMEDOUT'),
    })),
    (err) => {
      apiError = err;
      return true;
    }
  );
  assert.match(apiError.message, /status=null/);
  assert.doesNotMatch(apiError.message, /signal=/);
  assert.match(apiError.message, /error=spawnSync gh ETIMEDOUT/);
  assert.match(apiError.message, /stderr=partial stderr/);
  assert.doesNotMatch(apiError.message, /partial api stdout/);
});

test('processFindings / assertZeroExit: signal による終了（error なし・途中までの stdout あり）で signal と終了ステータスを残し途中 stdout を出さない', () => {
  const payload = { pr: 42, repo: 'acme/repo', headRefOid: 'deadbeef', findings: [finding()] };
  let caught;
  assert.throws(
    () => processFindings(payload, {
      spawnFn: () => ({
        status: null,
        signal: 'SIGKILL',
        stdout: '{"filename":"killed.js"}',
        stderr: '',
      }),
    }),
    (err) => {
      caught = err;
      return true;
    }
  );
  assert.match(caught.message, /status=null/);
  assert.match(caught.message, /signal=SIGKILL/);
  assert.doesNotMatch(caught.message, /killed\.js/);

  let zeroWithSignal;
  assert.throws(
    () => assertZeroExit('gh api repos/acme/repo/pulls/42/files', {
      status: 0,
      signal: 'SIGTERM',
      stdout: 'partial output',
      stderr: '',
    }),
    (err) => {
      zeroWithSignal = err;
      return true;
    }
  );
  assert.match(zeroWithSignal.message, /status=0/);
  assert.match(zeroWithSignal.message, /signal=SIGTERM/);
  assert.doesNotMatch(zeroWithSignal.message, /partial output/);
});

test('processFindings / postFinalReview: 非0終了で終了ステータスと stderr（stderr が空のときは stdout）を残す', () => {
  const payload = { pr: 42, repo: 'acme/repo', headRefOid: 'deadbeef', findings: [finding()] };
  let stderrFailure;
  assert.throws(
    () => processFindings(payload, {
      spawnFn: () => ({
        status: 2,
        signal: null,
        stdout: '{"filename":"ignored.js"}',
        stderr: 'gh: HTTP 500 Internal Server Error',
      }),
    }),
    (err) => {
      stderrFailure = err;
      return true;
    }
  );
  assert.match(stderrFailure.message, /status=2/);
  assert.match(stderrFailure.message, /stderr=gh: HTTP 500 Internal Server Error/);
  assert.doesNotMatch(stderrFailure.message, /ignored\.js/);

  let stdoutFallbackFailure;
  assert.throws(
    () => postFinalReview(payload, 'body', () => ({
      status: 1,
      signal: null,
      stdout: '{"message":"Validation Failed"}',
      stderr: '',
    })),
    (err) => {
      stdoutFallbackFailure = err;
      return true;
    }
  );
  assert.match(stdoutFallbackFailure.message, /status=1/);
  assert.match(stdoutFallbackFailure.message, /stdout=\{"message":"Validation Failed"\}/);
});

test('processFindings uses pulls/{n}/files with --jq @json|@base64 instead of gh pr diff and handles renamed files', () => {
  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  const calls = [];
  const payload = {
    pr: 572,
    repo: 'acme/repo',
    headRefOid: 'abc123',
    findings: [
      finding({ path: 'src/renamed-new.ts', line_anchor: 'const added = 1;' }),
      finding({ path: 'src/renamed-new.ts', line_anchor: 'const unchanged = 0;', summary: 'Outside hunk in renamed file' }),
    ],
  };

  const result = processFindings(payload, {
    files: {
      'src/renamed-new.ts': [
        'const unchanged = 0;',
        'const added = 1;',
      ].join('\n'),
    },
    spawnFn: (cmd, args) => {
      calls.push({ cmd, args });
      // 1行目は生base64、2行目はJSON文字列クォート付きbase64の双方を検証する（同一ファイルは重複排除されるため1件で足りるがクォート形式も確認）。
      return {
        status: 0,
        stdout: `${JSON.stringify(encode({
          filename: 'src/renamed-new.ts',
          patch: '@@ -2,0 +2,1 @@\n+const added = 1;\n',
        }))}\n`,
        stderr: '',
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args.slice(0, 6), [
    'api', '--method', 'GET', 'repos/acme/repo/pulls/572/files', '-f', 'per_page=100',
  ]);
  assert.ok(calls[0].args.includes('--paginate'));
  const jqIndex = calls[0].args.indexOf('--jq');
  assert.ok(jqIndex >= 0);
  assert.match(calls[0].args[jqIndex + 1], /"src\/renamed-new\.ts"/);
  assert.match(calls[0].args[jqIndex + 1], /@json \| @base64/);
  assert.ok(!calls[0].args.includes('diff'));

  assert.equal(result.posted.length, 1);
  assert.equal(result.posted[0].resolved_line, 2);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].status, 'diff_outside_anchor');
  assert.equal(result.unresolved[0].resolved_line, 1);
});

test('publish posts omitted-patch findings at file level without blocking inline findings or the final review', () => {
  const payload = {
    pr: 572,
    repo: 'acme/repo',
    headRefOid: 'abc123',
    findings: [
      finding({ path: 'src/generated-huge.ts', line_anchor: 'const x = 1;', summary: 'Huge patch omitted' }),
      finding({ path: 'src/small.ts', line_anchor: 'const y = 2;', summary: 'Small inline finding' }),
    ],
  };
  const posted = [];
  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

  const result = publish(payload, {
    files: {
      'src/generated-huge.ts': 'const x = 1;\n',
      'src/small.ts': 'const y = 2;\n',
    },
    spawnFn: () => ({
      status: 0,
      stdout: [
        encode({ filename: 'src/generated-huge.ts', patch: null }),
        encode({ filename: 'src/small.ts', patch: '@@ -1,0 +1,1 @@\n+const y = 2;\n' }),
      ].join('\n'),
      stderr: '',
    }),
    postInlineReviewFn: (_p, item) => posted.push({ kind: 'inline', path: item.path, line: item.resolved_line }),
    postFileReviewFn: (_p, item) => posted.push({ kind: 'file', path: item.finding.path, status: item.status }),
    postFinalReviewFn: (_p, body) => posted.push({ kind: 'final', body }),
  });

  assert.equal(result.posted.length, 1);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].status, 'patch_unavailable');
  assert.deepEqual(posted.slice(0, 2), [
    { kind: 'inline', path: 'src/small.ts', line: 1 },
    { kind: 'file', path: 'src/generated-huge.ts', status: 'patch_unavailable' },
  ]);
  assert.equal(posted[2].kind, 'final');
  assert.match(posted[2].body, /^Review Manager completed\./);
});

test('fetchPrFiles splits target paths across multiple --jq batches instead of dropping path filtering', () => {
  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  const paths = ['src/alpha-one.ts', 'src/beta-two.ts', 'src/gamma-three.ts'];
  // 1件だけ入る上限を設定し、全件経路にフォールバックせず必ず分割バッチごとに --jq 絞り込みが行われることを検証する。
  const singleLimit = buildPullFilesJqFilter(['src/alpha-one.ts']).length + 5;
  assert.deepEqual(partitionTargetPathsForJq(paths, singleLimit), [
    ['src/alpha-one.ts'],
    ['src/beta-two.ts'],
    ['src/gamma-three.ts'],
  ]);

  const calls = [];
  const files = fetchPrFiles(
    { pr: 572, repo: 'acme/repo' },
    [...paths, 'src/alpha-one.ts'],
    (cmd, args) => {
      calls.push({ cmd, args });
      const jq = args[args.indexOf('--jq') + 1];
      if (jq.includes('alpha-one')) return { status: 0, stdout: `${encode({ filename: 'src/alpha-one.ts', patch: '@@ -1 +1 @@\n+a' })}\n`, stderr: '' };
      if (jq.includes('beta-two')) return { status: 0, stdout: `${encode({ filename: 'src/beta-two.ts', patch: null })}\n`, stderr: '' };
      return { status: 0, stdout: `${encode({ filename: 'src/gamma-three.ts', patch: '@@ -1 +1 @@\n+c' })}\n`, stderr: '' };
    },
    singleLimit
  );

  assert.equal(calls.length, 3);
  for (const call of calls) {
    const jq = call.args[call.args.indexOf('--jq') + 1];
    assert.match(jq, /as \$targets \| \.\[\] \| select/);
  }
  assert.deepEqual(files.map(f => f.filename), paths);
});

test('decodePrFilesBase64Lines fails closed on each corrupt response kind', () => {
  assert.throws(() => decodePrFilesBase64Lines('not-valid-base64!'), /not valid base64/);
  assert.throws(
    () => decodePrFilesBase64Lines(Buffer.from('{broken json', 'utf8').toString('base64')),
    /not valid JSON/
  );
  assert.throws(
    () => decodePrFilesBase64Lines(Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8').toString('base64')),
    /missing a valid filename/
  );
  assert.throws(
    () => decodePrFilesBase64Lines(Buffer.from(JSON.stringify({ filename: 'src/a.ts', patch: 42 }), 'utf8').toString('base64')),
    /invalid patch type/
  );
});
