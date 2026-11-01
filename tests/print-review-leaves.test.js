'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  USAGE,
  main,
  readReviewDefinitions,
  resolveReviewSkillsDir,
} = require('../scripts/print-review-leaves');

// 読み込み対象の定義ファイル（共通1件＋8葉の pre/post）を、正本の配置規約どおりリテラルで列挙する。
// 本番の導出関数から作ると、本番が1件落としても fixture も同じく落として検出できないため、導出しない。
const REVIEW_DEFINITION_FILES = Object.freeze([
  'common.md',
  'correctness/logic-invariants/pre-review.md',
  'correctness/logic-invariants/post-review.md',
  'correctness/api-contract/pre-review.md',
  'correctness/api-contract/post-review.md',
  'correctness/concurrency/pre-review.md',
  'correctness/concurrency/post-review.md',
  'resilience-security/failure-recovery/pre-review.md',
  'resilience-security/failure-recovery/post-review.md',
  'resilience-security/hostile-input/pre-review.md',
  'resilience-security/hostile-input/post-review.md',
  'maintainability/structure-naming/pre-review.md',
  'maintainability/structure-naming/post-review.md',
  'maintainability/design-quality/pre-review.md',
  'maintainability/design-quality/post-review.md',
  'test-quality/test-quality/pre-review.md',
  'test-quality/test-quality/post-review.md',
]);

function withReviewFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-review-leaves-'));
  try {
    const files = REVIEW_DEFINITION_FILES;
    const expected = files.map((relativePath) => {
      const content = `definition:${relativePath}\n`;
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      return content;
    }).join('');
    return callback(root, files, expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('resolveReviewSkillsDir: managed root配下の共有レビュー正本を指す', () => {
  assert.equal(
    resolveReviewSkillsDir(),
    path.join(require('../scripts/shared/storage-layout').managedRoot(), 'skills', 'gh-maestro-reviewer'),
  );
});

test('readReviewDefinitions: 正本の17ファイルをこの順序で連結して返す', () => {
  withReviewFixture((root, files, expected) => {
    assert.equal(readReviewDefinitions(root), expected);
    assert.equal(files.length, 17, '共通定義と8葉のpre/post定義をすべて読む');
  });
});

test('main: 定義ファイルの読み取りに失敗した場合は不完全なstdoutを返さず終了コード1', () => {
  withReviewFixture((root, files) => {
    fs.rmSync(path.join(root, files[files.length - 1]));

    const result = main([], { reviewSkillsDir: root });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, undefined);
    assert.match(result.stderr, /cannot read review definition/);
  });
});

test('main: --help / -h はUsageを終了コード0で返す', () => {
  assert.deepEqual(main(['--help']), { exitCode: 0, stdout: USAGE });
  assert.deepEqual(main(['-h']), { exitCode: 0, stdout: USAGE });
});

test('main: 余分な位置引数はUsage付きの終了コード1で拒否する', () => {
  const result = main(['unexpected']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /print-review-leaves:.*位置引数/);
  assert.match(result.stderr, /print-review-leaves\.js/);
});
