'use strict';
// declaration-workflow.test.js
//
// コーダーの「修正push」手順（skills/_partials/coder-workflow.md）が、素のバージョン管理
// コマンドやホスティングCLIの直接実行ではなく、push と申告を一体化したアセットスクリプト
// （push-and-declare.js）経由であることを固定する（Issue #374）。
//
// 検証対象は「コーダーが実際に実行する手順」＝コード実行例（コードフェンス）に限定する。
// 本文の説明文・注意書きは検証対象にしない（差し戻し指摘2: 「文書中に素のコマンドの
// 文字列が出現しないこと」で判定しない。素のコマンド名に言及した説明文はあってよい）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CODER_WORKFLOW = path.join(ROOT, 'skills', '_partials', 'coder-workflow.md');

/** コードフェンス（```sh ... ```）の中身を抽出する。リスト項目の下に置かれた
 *  インデント付きフェンス（開始・終了マーカー行に先頭空白がある）にも対応する。 */
function codeFences(content) {
  const fences = [];
  const re = /^[ \t]*```sh\r?\n([\s\S]*?)\r?\n[ \t]*```/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    fences.push(m[1]);
  }
  return fences;
}

test('coder-workflow.md: push-and-declare.js のコード実行例が存在する', () => {
  const content = fs.readFileSync(CODER_WORKFLOW, 'utf8');
  const fences = codeFences(content);
  assert.ok(fences.length > 0, 'コード実行例が見つからない');
  const finalizeStep = fences.find(f => f.includes('push-and-declare.js'));
  assert.ok(finalizeStep, 'push-and-declare.js のコード実行例が見つからない');
  // 実行例は収束型単一入口の呼び出し（--issue/--fail/--pass を渡す）
  assert.match(finalizeStep, /node "{{SCRIPTS_PATH}}\/push-and-declare\.js" --issue \$ISSUE --fail <失敗件数> --pass <成功件数> --workspace \$WORKSPACE/);
});

test('coder-workflow.md: コード実行例のフェンス内に素の git commit / git push / gh pr create が無い', () => {
  const content = fs.readFileSync(CODER_WORKFLOW, 'utf8');
  const fences = codeFences(content);
  assert.ok(fences.length > 0, 'コード実行例が見つからない');
  for (const fence of fences) {
    for (const line of fence.split(/\r?\n/)) {
      const trimmed = line.trim();
      // 実行コマンド行（`git commit` / `git push` をそのまま打つ行、`gh pr create` 行）を禁止
      assert.doesNotMatch(trimmed, /^git\s+(commit|push)\b/, `素の git コマンドが実行例に含まれる: ${trimmed}`);
      assert.doesNotMatch(trimmed, /^gh\s+pr\s+create\b/, `素の gh pr create が実行例に含まれる: ${trimmed}`);
    }
  }
});

test('coder-workflow.md: push-and-declare.js の実行例は単一のアセット呼び出しで完結する', () => {
  const content = fs.readFileSync(CODER_WORKFLOW, 'utf8');
  const fences = codeFences(content);
  const finalizeStep = fences.find(f => f.includes('push-and-declare.js'));
  // 素の git commit / git push / gh pr create / declare-test-result.js の直接実行に戻していない
  assert.doesNotMatch(finalizeStep, /declare-test-result\.js/);
  assert.doesNotMatch(finalizeStep, /gh-create-pr\.js/);
});

test('coder-workflow.md: 計画ファイルの置き場所（worktree外 per-workspace）が明記されている', () => {
  const content = fs.readFileSync(CODER_WORKFLOW, 'utf8');
  assert.match(content, /\$WORKSPACE\/\.gh-maestro\/plans\/<issue>\.md/);
});

test('coder-workflow.md: 素の git commit/push/gh pr create の直接実行を禁止する制約が明記されている', () => {
  const content = fs.readFileSync(CODER_WORKFLOW, 'utf8');
  const constraintsSection = content.slice(content.indexOf('## 制約'));
  assert.match(constraintsSection, /git commit.*git push.*gh pr create/);
});
