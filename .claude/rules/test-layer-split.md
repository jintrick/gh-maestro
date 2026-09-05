---
paths:
  - "scripts/**"
  - "tests/**"
---

# テストの実行範囲

実行範囲はファイル名の一致だけで決める。重要度・壊れやすさ・担当者の判断で変えてはならない。

- 毎回側は `npm test`。通常の実装変更と `tests/*.test.js` の変更では全件実行する
- `scripts/<name>.js` を変更したら `tests/slow/<name>.test.js` の有無を確認する。存在すれば `npm run test:slow -- tests/slow/<name>.test.js` を実行し、存在しなければ `npm run test:slow` を全件実行する
- 複数の `scripts/*.js` を変更したら、存在する同名テストをすべて個別に実行する。同名が1つでも存在しない場合の全件実行は1回だけ追加する
- `tests/slow/<name>.test.js` を直接変更したら、そのファイルだけを実行する
- 分離側へ置く基準は、実プロセス起動・実git操作・実シェル起動・実時間待ちのいずれかを含むことだけとする。これらを含まないテストを分離側へ移してはならない
- `node scripts/install.js` の前と障害調査時は、`npm test` と `npm run test:slow` の両方を全件実行する
