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
  const powershellFences = [...content.matchAll(/^[ \t]*```powershell\r?\n([\s\S]*?)\r?\n[ \t]*```/gm)]
    .map((match) => match[1]);

  // 参照先（スクリプトのフラグ・環境変数）だけを確かめる。git の手順の並びは検査しない。
  assert.ok(fences.some((fence) => /create-issue\.js/.test(fence) && /--title-only/.test(fence)));
  assert.ok(fences.some((fence) => /gh-create-pr\.js/.test(fence)));
  assert.ok(powershellFences.some((fence) => /\$env:GH_MAESTRO_BASE_BRANCH/.test(fence) && /gh-create-pr\.js/.test(fence)));
});

test('lightweight-pr.md: target経由のPR監視はReview Manager・slow層・CI checksを行わない', () => {
  const content = readDocument();
  const fences = shellFences(content);
  const monitorFence = fences.find((fence) => /activate-pr-monitor\.js/.test(fence));

  assert.ok(monitorFence, 'activate-pr-monitor.jsの実行例がない');
  assert.match(monitorFence, /--no-review-manager/);
  assert.match(monitorFence, /--no-review-events/);
  assert.doesNotMatch(monitorFence, /start-review-manager\.js/);
  assert.match(content, /poll-pr-monitor\.js/);
  assert.doesNotMatch(content, /node "\{\{SCRIPTS_PATH\}\}\/poll-pr\.js"/);
  // 参照先（poll-pr-monitor.js / start-review-manager.js が出す合図の名前）だけを確かめる
  assert.match(content, /SLOW_TEST_STARTED/);
  assert.match(content, /CI_CHECK_FAILED/);
  assert.match(content, /REVIEW_MANAGER_STARTED/);
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
