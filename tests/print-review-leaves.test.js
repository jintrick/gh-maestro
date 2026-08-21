'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ALL_LEAF_IDS,
  reviewFilesForLeaves,
} = require('../scripts/shared/review-aspects');
const {
  USAGE,
  main,
  readReviewDefinitions,
  resolveReviewSkillsDir,
} = require('../scripts/print-review-leaves');

function withReviewFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-review-leaves-'));
  try {
    const files = reviewFilesForLeaves(ALL_LEAF_IDS);
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

test('readReviewDefinitions: 既存の導出順で全定義内容をそのまま連結する', () => {
  withReviewFixture((root, files, expected) => {
    assert.equal(readReviewDefinitions(root), expected);
    assert.equal(files.length, 15, '共通定義と7葉のpre/post定義をすべて読む');
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
