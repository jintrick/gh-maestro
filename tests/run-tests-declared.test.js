'use strict';

// run-tests.js --declared-tests の判定（Issue #671）。テストファイルの場所は対象プロジェクトの
// 層宣言（defaultTestFiles / testFilePattern / mapping.test）だけから決まる。ディレクトリ名は
// 判定に使わない。resolveTestConfigFn を注入し、実際の config を読まない。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterDeclaredTestFiles } = require('../scripts/run-tests');

/** 宣言の形（resolveTestConfig の戻り値と同じ層の構造）を注入する。 */
function declaring(layers) {
  return () => ({ source: 'declared', layers });
}

test('宣言された defaultTestFiles の場所にあるファイルだけを判定する（別の場所のテストも宣言に従う）', () => {
  const resolveTestConfigFn = declaring({
    unit: { scope: 'full', defaultTestFiles: ['specs/*.spec.ts'] },
  });
  const result = filterDeclaredTestFiles({
    files: ['specs/a.spec.ts', 'src/a.spec.ts', 'specs/nested/b.spec.ts', 'src/main.ts'],
    workspace: '/ws',
    cwd: '/ws',
  }, { resolveTestConfigFn });
  assert.deepEqual(result, { ok: true, files: ['specs/a.spec.ts'] });
});

test('testFilePattern（<name>）と mapping.test の場所も宣言として扱う', () => {
  const resolveTestConfigFn = declaring({
    slow: { scope: 'partial', testFilePattern: 'checks/<name>.check.js', mapping: [{ changed: 'lib/<name>.js', test: 'integration/<name>.int.js' }] },
  });
  const result = filterDeclaredTestFiles({
    files: ['checks/x.check.js', 'integration/y.int.js', 'lib/y.js', 'tests/z.test.js'],
    workspace: '/ws',
    cwd: '/ws',
  }, { resolveTestConfigFn });
  assert.deepEqual(result, { ok: true, files: ['checks/x.check.js', 'integration/y.int.js'] });
});

test('宣言が無い（source が declared でない）workspace では何も判定しない', () => {
  const resolveTestConfigFn = () => ({ source: 'builtin', layers: {} });
  const result = filterDeclaredTestFiles({ files: ['tests/a.test.js'], workspace: '/ws', cwd: '/ws' }, { resolveTestConfigFn });
  assert.deepEqual(result, { ok: true, files: [] });
});

test('宣言の解決に失敗したら error（黙って空にしない。フェイルクローズ）', () => {
  const resolveTestConfigFn = () => { throw new Error('bad config'); };
  const result = filterDeclaredTestFiles({ files: ['tests/a.test.js'], workspace: '/ws', cwd: '/ws' }, { resolveTestConfigFn });
  assert.equal(result.ok, false);
});

test('不正なパス（絶対パス・..）は error にする', () => {
  const resolveTestConfigFn = declaring({ full: { scope: 'full', defaultTestFiles: ['tests/*.test.js'] } });
  const result = filterDeclaredTestFiles({ files: ['../tests/a.test.js'], workspace: '/ws', cwd: '/ws' }, { resolveTestConfigFn });
  assert.equal(result.ok, false);
});

test('ネストしたディレクトリは単一の * に一致しない（宣言の範囲を越えない）', () => {
  const resolveTestConfigFn = declaring({ full: { scope: 'full', defaultTestFiles: ['tests/*.test.js'] } });
  const result = filterDeclaredTestFiles({ files: ['tests/slow/a.test.js', 'tests/a.test.js'], workspace: '/ws', cwd: '/ws' }, { resolveTestConfigFn });
  assert.deepEqual(result, { ok: true, files: ['tests/a.test.js'] });
});
