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
  // 実行例は収束型単一入口の呼び出し。テスト件数は成果物から自動取得する。
  assert.match(finalizeStep, /node "{{SCRIPTS_PATH}}\/push-and-declare\.js" --issue \$ISSUE --workspace \$WORKSPACE/);
  assert.doesNotMatch(finalizeStep, /--(?:fail|pass)\b/);
  assert.match(content, /run-tests\.js" --workspace \$WORKSPACE --list/);
  assert.match(content, /run-tests\.js" --workspace \$WORKSPACE <一覧で確認した層名>/);
  assert.doesNotMatch(content, /config\.json/);
  assert.doesNotMatch(content, /`npm test`/);
  assert.doesNotMatch(content, /`npm run test:slow`/);
  assert.doesNotMatch(content, /tests\/slow/);
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

test('coder-workflow.md: 素の git commit/push/gh pr create は push-and-declare 手順で禁止する', () => {
  // 禁止文の一字一句には依存しない。「直接実行しない」と3つのコマンド名が同じ行にあることで判定する。
  // 実行例に素のコマンドが現れないこと自体は、上の「フェンス内に素の …が無い」検査が見ている。
  const content = fs.readFileSync(CODER_WORKFLOW, 'utf8');
  const commands = ['git commit', 'git push', 'gh pr create'];
  const prohibitionLine = content
    .split('\n')
    .find((line) => line.includes('直接実行しない') && commands.every((cmd) => line.includes(cmd)));
  assert.ok(prohibitionLine, '素の git commit / git push / gh pr create の直接実行を禁止する文がある');
});

// テストの質の基準（.claude/rules/test-quality-criteria.md）を、書き手（coder）と
// レビュー（test-quality 葉）の両方が参照することを固定する（Issue #671）。
// 文言そのものは検査しない。参照先のパスが残っているかだけを確かめる。
const TEST_QUALITY_CRITERIA_REF = '.claude/rules/test-quality-criteria.md';
const TEST_QUALITY_CRITERIA_CONSUMERS = [
  path.join(ROOT, 'skills', '_partials', 'coder-workflow.md'),
  path.join(ROOT, 'skills', 'gh-maestro-reviewer', 'test-quality', 'test-quality', 'pre-review.md'),
  path.join(ROOT, 'skills', 'gh-maestro-reviewer', 'test-quality', 'test-quality', 'post-review.md'),
];

test('テストの質の基準を書き手とレビューの手順書が参照している（Issue #671）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, TEST_QUALITY_CRITERIA_REF)), '基準ファイルが存在する');
  for (const file of TEST_QUALITY_CRITERIA_CONSUMERS) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes(TEST_QUALITY_CRITERIA_REF), `${path.relative(ROOT, file)} が基準ファイルを参照していない`);
  }
});
