'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { withTempDir } = require('../scripts/shared/temp-directory');

const {
  ReviewFindingsError,
  loadReviewFindings,
  formatFindingFull,
  formatText,
  parseArgs,
} = require('../scripts/read-review-findings.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'read-review-findings.js');

function withWorkspace(fn) {
  return withTempDir('gh-maestro-read-findings-', (dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  });
}

// manager.json の位置は仕様どおりに文字列で書く（実装の関数から導出しない）。
function writeManagerJson(workspace, content) {
  const dir = path.join(workspace, '.gh-maestro', 'records', 'pr', '7', 'review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manager.json'), content);
}

function validFinding(overrides = {}) {
  return {
    aspect: 'Correctness',
    path: 'scripts/example.js',
    line_anchor: 'const x = 1;',
    summary: '境界値の扱いが誤っている',
    severity: 'MAJOR',
    severity_rationale: '入力が0のとき誤った結果になる',
    body: '本文の全文。ここが切れてはならない。',
    verified_references: ['scripts/example.js:12'],
    ...overrides,
  };
}

function validPayload(findings) {
  return {
    pr: 7,
    repo: 'owner/repo',
    headRefOid: 'abc1234def5678',
    findings,
  };
}

test('parseArgs returns help for --help and -h', () => {
  assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
  assert.deepEqual(parseArgs(['-h']), { mode: 'help' });
});

test('parseArgs requires --pr', () => {
  assert.throws(() => parseArgs(['--json']), (error) => error instanceof ReviewFindingsError && error.exitCode === 1);
});

test('parseArgs rejects unexpected positional arguments', () => {
  assert.throws(() => parseArgs(['--pr', '7', 'extra']), (error) => error instanceof ReviewFindingsError && error.exitCode === 1);
});

test('parseArgs reads --pr, --workspace and --json', () => {
  const parsed = parseArgs(['--pr', '7', '--workspace', '/tmp/ws', '--json']);
  assert.deepEqual(parsed, { mode: 'run', pr: '7', workspaceArg: '/tmp/ws', json: true });
});

test('loadReviewFindings fails with exit 2 when manager.json does not exist', () => {
  withWorkspace((dir) => {
    assert.throws(() => loadReviewFindings(dir, 7), (error) => error.exitCode === 2 && /manager\.json がありません/.test(error.message));
  });
});

test('loadReviewFindings fails with exit 3 when JSON syntax is broken', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, '{"pr": 7, "findings": [');
    assert.throws(() => loadReviewFindings(dir, 7), (error) => error.exitCode === 3 && /JSON 構文/.test(error.message));
  });
});

test('loadReviewFindings fails with exit 3 when pr does not match the requested PR', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, JSON.stringify({ ...validPayload([]), pr: 8 }));
    assert.throws(() => loadReviewFindings(dir, 7), (error) => error.exitCode === 3 && /pr が要求された PR #7 と一致しません/.test(error.message));
  });
});

test('loadReviewFindings fails with exit 3 when a finding lacks body', () => {
  withWorkspace((dir) => {
    const finding = validFinding();
    delete finding.body;
    writeManagerJson(dir, JSON.stringify(validPayload([finding])));
    assert.throws(() => loadReviewFindings(dir, 7), (error) => error.exitCode === 3 && /findings\[0\]: body is required/.test(error.message));
  });
});

test('loadReviewFindings fails with exit 3 when a finding has an invalid severity', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, JSON.stringify(validPayload([validFinding({ severity: 'CRITICAL' })])));
    assert.throws(() => loadReviewFindings(dir, 7), (error) => error.exitCode === 3 && /severity is invalid/.test(error.message));
  });
});

test('loadReviewFindings returns zero findings as a successful read', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, JSON.stringify(validPayload([])));
    const { payload } = loadReviewFindings(dir, 7);
    assert.equal(payload.findings.length, 0);
    assert.equal(formatText(payload, '世代テスト'), '## PR #7 — Review Manager 指摘全文\n- repo: owner/repo\n- headRefOid: abc1234def5678\n- 世代: 世代テスト\n- 指摘件数: 0\n\n指摘なし（0件）。');
  });
});

test('loadReviewFindings accepts a UTF-8 BOM at the start of manager.json', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, `﻿${JSON.stringify(validPayload([validFinding()]))}`);
    const { payload } = loadReviewFindings(dir, 7);
    assert.equal(payload.findings.length, 1);
  });
});

test('formatFindingFull prints the whole body and every verified reference without truncation', () => {
  const longBody = `${'長い本文の行。'.repeat(40)}末尾の文`;
  const text = formatFindingFull(validFinding({ body: longBody, verified_references: ['a.js:1', 'b.js:2'] }), 3);
  assert.ok(text.includes(longBody), 'body must be printed in full');
  assert.ok(text.includes('- 検証した参照: a.js:1, b.js:2'));
  assert.ok(text.startsWith('### 3. '));
  assert.ok(text.includes('- 重要度: MAJOR'));
  assert.ok(text.includes('- 判定根拠: 入力が0のとき誤った結果になる'));
});

test('CLI --help exits 0 and prints Usage', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node read-review-findings\.js --pr <N>/);
});

test('CLI exits 2 when manager.json is missing', () => {
  withWorkspace((dir) => {
    const result = spawnSync(process.execPath, [SCRIPT, '--pr', '7', '--workspace', dir], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /manager\.json がありません/);
  });
});

test('CLI exits 3 when manager.json is corrupt', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, 'not json');
    const result = spawnSync(process.execPath, [SCRIPT, '--pr', '7', '--workspace', dir], { encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr);
  });
});

test('CLI --json prints the verified payload that start-review-manager accepts as prior findings', () => {
  withWorkspace((dir) => {
    writeManagerJson(dir, JSON.stringify(validPayload([validFinding()])));
    const result = spawnSync(process.execPath, [SCRIPT, '--pr', '7', '--workspace', dir, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.pr, 7);
    assert.equal(out.repo, 'owner/repo');
    assert.equal(out.headRefOid, 'abc1234def5678');
    assert.equal(out.findings[0].body, '本文の全文。ここが切れてはならない。');
  });
});

test('CLI exits 1 with an error message when --pr is missing (no workspace access)', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /read-review-findings: 引数エラー/);
  assert.match(result.stderr, /Usage: node read-review-findings\.js/);
});

test('CLI exits 1 when an unexpected positional argument is given', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--pr', '7', 'extra'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /read-review-findings: 引数エラー/);
});

test('CLI rejects a non-positive --pr value before reading any file', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--pr', '0'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--pr は正の整数/);
});

test('CLI text output (no --json) exits 0 and prints each finding body and every verified reference in full', () => {
  // 期待値はこのテスト内の独立した文字列リテラル。実装の整形関数からは導出しない。
  const longBody = '第1段落: 入力が空のとき配列の先頭要素を参照して例外になる。'
    + '第2段落: 呼び出し元は例外を捕捉せず、通知本文の切れた位置で結果が途切れる。'
    + '第3段落（末尾）: 修正は空判定を先に行うこと。';
  const references = ['scripts/alpha.js:12', 'scripts/beta.js:87', 'tests/gamma.test.js:203'];
  withWorkspace((dir) => {
    writeManagerJson(dir, JSON.stringify(validPayload([
      validFinding({
        summary: '空入力で例外になる',
        body: longBody,
        verified_references: references,
      }),
    ])));
    const result = spawnSync(process.execPath, [SCRIPT, '--pr', '7', '--workspace', dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(longBody), 'the whole body must be printed without truncation');
    for (const reference of references) {
      assert.ok(result.stdout.includes(reference), `reference missing from output: ${reference}`);
    }
    assert.ok(result.stdout.includes('- 指摘件数: 1'));
  });
});
