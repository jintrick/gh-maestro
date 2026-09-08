'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const DOC_PATH = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'lightweight-pr.md');

function readDocument() {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

function shellFences(content) {
  return [...content.matchAll(/^[ \t]*```sh\r?\n([\s\S]*?)\r?\n[ \t]*```/gm)]
    .map((match) => match[1]);
}

test('lightweight-pr.md: タイトルだけのIssueからPR作成までの具体的な入口がある', () => {
  const content = readDocument();
  const fences = shellFences(content);

  assert.ok(fences.some((fence) => /create-issue\.js/.test(fence) && /--title-only/.test(fence)));
  assert.ok(fences.some((fence) => /git switch --create/.test(fence) && /\$BASE_BRANCH/.test(fence)));
  assert.ok(fences.some((fence) => /git commit/.test(fence) && /git push/.test(fence)));
  assert.ok(fences.some((fence) => /gh-create-pr\.js/.test(fence)));
});

test('lightweight-pr.md: PR監視はReview Managerを起動せず、slow層と申告確認を残す', () => {
  const content = readDocument();
  const fences = shellFences(content);
  const pollFence = fences.find((fence) => /poll-pr\.js/.test(fence));

  assert.ok(pollFence, 'poll-pr.jsの実行例がない');
  assert.match(pollFence, /--no-review-manager/);
  assert.doesNotMatch(pollFence, /start-review-manager\.js/);
  assert.match(content, /SLOW_TEST_RESULT/);
  assert.match(content, /テスト申告コメント/);
  assert.match(content, /REVIEW_MANAGER_STARTED[\s\S]*出力されない/);
});

test('lightweight-pr.md: 任意の対象プロジェクトで使えるセッション変数だけを前提にする', () => {
  const content = readDocument();

  for (const variable of ['$REPO', '$WORKSPACE', '$BASE_BRANCH', '{{SCRIPTS_PATH}}']) {
    assert.match(content, new RegExp(variable.replace(/[{}$]/g, '\\$&')));
  }
  assert.doesNotMatch(content, /(?:^|[\s"'(=])[A-Za-z]:[\\/]/, 'Windowsの絶対パスを文書へ持ち込まない');
  assert.doesNotMatch(content, /(?:^|[\s"'(=])\/Users\//, 'Unixのユーザー絶対パスを文書へ持ち込まない');
  assert.doesNotMatch(content, /jintrick\/gh-maestro/, '固定リポジトリ名を文書へ持ち込まない');
});
