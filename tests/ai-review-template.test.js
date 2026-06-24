'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 単一レビュアーのソース（correctness/maintainability/resilience を1本に統合）
const REVIEWER_PATH = path.join(__dirname, '..', 'workflows', 'reviewer.md');

test('reviewer.md: 存在する', () => {
  assert.ok(fs.existsSync(REVIEWER_PATH), `reviewer.md が見つからない: ${REVIEWER_PATH}`);
});

test('reviewer.md: pull_request opened/reopened で直接起動する', () => {
  const content = fs.readFileSync(REVIEWER_PATH, 'utf8');
  assert.match(content, /pull_request:/, 'pull_request トリガーがない');
  assert.match(content, /types:\s*\[opened,\s*reopened\]/, 'types: [opened, reopened] がない');
});

test('reviewer.md: synchronize トリガーを含まない', () => {
  const content = fs.readFileSync(REVIEWER_PATH, 'utf8');
  assert.ok(
    !content.includes('synchronize'),
    'synchronize トリガーが含まれている（PR への追加 push でレビューCIが再実行される）'
  );
});

test('reviewer.md: PR番号は github.event.pull_request.number を使う（inputs.pr_number 残存禁止）', () => {
  const content = fs.readFileSync(REVIEWER_PATH, 'utf8');
  assert.ok(
    content.includes('github.event.pull_request.number'),
    'github.event.pull_request.number を使っていない'
  );
  assert.ok(
    !content.includes('inputs.pr_number'),
    'inputs.pr_number が残っている — direct trigger では解決されない（workflow_call の名残）'
  );
});

test('reviewer.md: 3観点をすべて含む', () => {
  const content = fs.readFileSync(REVIEWER_PATH, 'utf8');
  for (const aspect of ['Correctness', 'Maintainability', 'Resilience']) {
    assert.ok(content.includes(aspect), `観点 ${aspect} が含まれていない`);
  }
});

test('reviewer.md: 出力ポリシーを runtime-import する', () => {
  const content = fs.readFileSync(REVIEWER_PATH, 'utf8');
  assert.ok(
    content.includes('{{#runtime-import shared/reviewer-output-policy.md}}'),
    'shared/reviewer-output-policy.md の runtime-import がない（パスは .github/workflows/ 基準）'
  );
});
