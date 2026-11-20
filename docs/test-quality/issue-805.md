# Issue #805: Test Quality 実レビューの確認

以下は、Issue #805 の受け入れ条件に指定された2件を、変更後の Test Quality 定義で実際にレビューした記録である。各実行では、設定済みの `codex-terra` を使い、`test-quality/test-quality` のみを起動した。対象Issue本文の受け入れ条件とレビュー対象HEADに一致するテスト申告を入力した。レビューは各1回目で成功し、レビューワーカー自身はテストを実行していない。

## 指定された不要テスト

- 対象: [PR #802](https://github.com/jintrick/gh-maestro/pull/802), HEAD `6cd6d281bdbcb3e78372c805b12d0e1be564d85c`, [Issue #800](https://github.com/jintrick/gh-maestro/issues/800)
- ジョブ: `test-quality-issue-805-802`、`success`、attempt 1
- 結果: `tests/run-review-jobs.test.js` の `buildJobPrompt keeps the input contract when manifest has no acceptance criteria` を削除する SUGGESTION。
- 根拠: 条件なし入力で、他テストの入力にだけある特定の一文が出ないことと、条件の有無に左右されない共通説明文を検査していた。前者は他の文言が混入しても検出せず、後者は独自の条件なし挙動を検証しない。条件なし時にその特定文言を除外する明示契約や既知の回帰も示されていない。任意フィールド自体の妥当性検証は既存の `validateManifest` テストに残すという提案だった。
- 判定: 受け入れ条件の指定どおり、強化ではなく対象テストの削除を提案した。

同じ実行では、受け入れ条件葉の手順文言を固定する4つの追加アサーションについても、意味を保つ言い換えで失敗し実効性を保証しないとして削除を提案した。

## 価値のあるテストを含む例

- 対象: [PR #783](https://github.com/jintrick/gh-maestro/pull/783), HEAD `aae143a9550f421e8fb2e399f5267f4f554ea9b7`, [Issue #777](https://github.com/jintrick/gh-maestro/issues/777)
- ジョブ: `test-quality-issue-805-783`、`success`、attempt 1
- 結果: 実Gitを使う setup とセッションフックの統合テストを削除する指摘はなかった。1件の SUGGESTION は、除外ファイル処理の失敗理由がフックの出力へ伝わることを追加で検証する提案だった。
- 判定: 重要な統合テストは維持され、失敗理由の伝達を含む追加保護を提案した。価値のあるテストを消すよう求めなかった。

## 実行範囲

2件とも対象PRの指定HEADとIssue本文を使った Test Quality 葉の実レビューである。ここに記録した結果はレビュー判断の確認であり、対象PRのコードやテストを変更したものではない。
