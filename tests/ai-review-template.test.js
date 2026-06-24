'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'workflows', 'caller-template', 'ai-review.yml');

test('ai-review.yml: 存在する', () => {
  assert.ok(fs.existsSync(TEMPLATE_PATH), `テンプレートが見つからない: ${TEMPLATE_PATH}`);
});

test('ai-review.yml: synchronize トリガーを含まない', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  assert.ok(
    !content.includes('synchronize'),
    'synchronize トリガーが含まれている（PR への追加 push でレビューCIが再実行される）'
  );
});

test('ai-review.yml: 各 reviewer ジョブに aw_context が存在する', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const jobs = ['review-correctness', 'review-maintainability', 'review-resilience'];

  for (const job of jobs) {
    const jobIdx = content.indexOf(`${job}:`);
    assert.ok(jobIdx !== -1, `ジョブが見つからない: ${job}`);
    const jobSection = content.slice(jobIdx, jobIdx + 500);
    assert.ok(
      jobSection.includes('aw_context:'),
      `${job} に aw_context がない — artifact prefix 衝突により全レビューが同一内容になる`
    );
  }
});

test('ai-review.yml: 全 reviewer の aw_context 値が一意である（artifact prefix 衝突防止）', () => {
  const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const matches = [...content.matchAll(/aw_context:\s*'([^']+)'/g)];
  assert.ok(
    matches.length >= 3,
    `aw_context のエントリ数が不足 (期待: 3件以上, 実際: ${matches.length}件)`
  );

  const values = matches.map(m => m[1]);
  const unique = new Set(values);
  assert.equal(
    unique.size, values.length,
    `aw_context 値が重複: [${values.join(', ')}] — compute_artifact_prefix.sh が同一ハッシュを生成し全 reviewer が同じ activation artifact を上書きする`
  );
});
