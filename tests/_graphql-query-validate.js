'use strict';
// tests/_graphql-query-validate.js — GraphQL クエリ文字列の構造的妥当性検証の共有テストヘルパー。
//
// 背景: テストは `_setGraphqlExec` で graphqlExec をスタブするため、gh への実呼び出し時に
// しか発生しない実行時エラー（variableNotDefined 等）がスリップする（Issue #232 指摘 #3:
// `$num` 宣言漏れが PR #231 で修正されるまで検出されなかった）。クエリ文字列自体を
// 構造検証して宣言漏れ変数を検出する。
//
// 対象: scripts/shared/discussion-graphql.js の QUERIES 定数・各関数が送信するクエリ文字列。
// 将来クエリを追加する際も QUERIES に集約される限り、discussion-graphql.test.js の
// QUERIES 全件走査テストが自動カバーする。
//
// テストランナーは tests/*.test.js のみを実行するため、本ファイルはテストとして
// 実行されない（名前が *.test.js ではない）。

/**
 * クエリ文字列で使用されているのに宣言されていない GraphQL 変数を抽出する。
 *
 * @param {string} query  GraphQL クエリ文字列
 * @returns {string[]} 宣言漏れ変数名（宣言部・使用部の両方の形式に依存しない正規表現で走査）
 */
function undeclaredVariables(query) {
  const sig = query.match(/^\s*(?:query|mutation)\s*(?:\(([^)]*)\))?/);
  const declared = new Set();
  if (sig && sig[1]) {
    for (const m of sig[1].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) declared.add(m[1]);
  }
  const used = new Set();
  for (const m of query.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!declared.has(m[1])) used.add(m[1]);
  }
  return [...used].sort();
}

/**
 * クエリ文字列の構造的妥当性を検証し、問題の説明配列を返す（妥当なら空配列）。
 * 検証項目:
 *   - 操作シグネチャ（query|mutation + 変数宣言部）が存在する
 *   - 使用変数がすべて宣言されている（undeclaredVariables が空）
 *
 * @param {string} query  GraphQL クエリ文字列
 * @returns {string[]} 構造エラーの説明（妥当なクエリなら空配列）
 */
function queryStructuralErrors(query) {
  const errors = [];
  if (!/^\s*(query|mutation)\b/.test(query)) {
    errors.push('must start with "query" or "mutation"');
  }
  const sig = query.match(/^\s*(?:query|mutation)\s*(?:\(([^)]*)\))?\s*\{/);
  if (!sig) {
    errors.push('missing operation signature (query/mutation with variable declarations)');
  }
  const undeclared = undeclaredVariables(query);
  if (undeclared.length > 0) {
    errors.push(`undeclared variables: ${undeclared.join(', ')}`);
  }
  return errors;
}

module.exports = { undeclaredVariables, queryStructuralErrors };
