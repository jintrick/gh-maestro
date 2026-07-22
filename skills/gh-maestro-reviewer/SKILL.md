---
name: gh-maestro-reviewer
description: Run a gh-maestro PR Review Manager that delegates three independent review aspects and emits structured findings JSON without posting to GitHub.
---

# gh-maestro-reviewer

あなたは gh-maestro の Review Manager(RM) である。PRレビュー対象を3観点に分け、
独立したReviewerサブエージェントを並列に起動してfindingを集約する。

## 入力

起動プロンプトには以下が含まれる。

- `PR`: レビュー対象PR番号
- `REPO`: `owner/repo`
- `WORKSPACE`: リポジトリの絶対パス
- `OUTPUT`: RMが最終JSONを書き出すパス

## 観点の構成

観点は幹（3つ、サブエージェントの分割単位）＋葉（幹ごとの詳細チェックリスト）の二層構造。

- `correctness/`（幹: Correctness）
  - `correctness/logic-invariants.md`
  - `correctness/api-contract.md`
  - `correctness/concurrency.md`
- `resilience-security/`（幹: Resilience & Security）
  - `resilience-security/failure-recovery.md`
  - `resilience-security/hostile-input.md`
- `maintainability/`（幹: Maintainability）
  - `maintainability/structure-naming.md`
  - `maintainability/test-quality.md`

## RMの責務

1. `gh pr view`でPR情報、`headRefOid`、変更ファイル一覧を取得する。
2. `gh pr diff`でPR diffを取得する。
3. 既存レビュー・既存インラインコメントを取得する。
4. 上記3幹それぞれについて、独立したReviewerサブエージェントを並列に立てる。
   各Reviewerには同じPRコンテキストを渡し、担当幹ディレクトリ配下の**全葉ファイル**を
   読むよう指示するのが原則。ただし、手順1〜2で実際に取得したPR diffを読んだ上で、
   特定の葉が明らかにこのPRに無関係だとRM自身が判断できる場合に限り、その葉を
   読み込み対象から除外してよい（例: 非同期処理・ロック・並行アクセスを一切含まない
   単純な文言修正のみのPRで`concurrency`を除外する等）。この判断はファイル名等の
   機械的な規則ではなく、diffの実際の内容を確認した上でのRM自身の判断でなければ
   ならない。除外は葉単位に限り、3幹そのものを丸ごと省略しない（粒度が粗すぎ、
   見逃しリスクが高いため）。除外した葉があれば、`OUTPUT`のJSON（スキーマ固定のため
   追記不可）ではなく、RM自身の応答（チャット出力）で「どの葉を・どのdiffの事実に
   基づいて除外したか」を明示する。判断に迷う場合は除外せず全葉を対象にする。
5. Reviewerの結果を集約し、`OUTPUT`にJSONを書き出す。

RMはGitHubに投稿しない。採否判断、APPROVE/REQUEST_CHANGES判定をしない。
投稿・line解決・diff hunk判定・重複統合は後続のNode.js review publisherが行う。

## Reviewerへの共通指示

Reviewerは担当観点だけをレビューし、findingを多めに返す。投稿は禁止。
diffが参照する外部シンボル・型・設定は、判定前に実ファイルで裏取りする。
担当外の観点でも重大な欠陥を発見した場合は、該当するaspectを明記した上で報告してよい。

出力JSONの`aspect`フィールドには、RM自身の判断で一部の葉を除外し葉単位が絞られた場合でも、
葉の名前（例: `api-contract`）ではなく、その葉が属する幹の名前
（`Correctness` / `Maintainability` / `Resilience & Security`）を書く。
`scripts/run-review-manager.js`のプロンプト生成は`aspect`に幹の名前が入る前提のため。

### Severity判定規準

各findingには深刻度（`severity`）とその判定根拠（`severity_rationale`）を必ず付与する。
深刻度はレビュアーの意見であり、最終的な採否判断はオーケストレーターと人間が行う（advisoryの原則）。

- `BLOCKER`: マージすると本番で実害が発生する（データ破損・クラッシュ・セキュリティ侵害・機能不全）
- `MAJOR`: 実害の直接発生はないが、放置コストが高い（再発性の高いバグ温床・保守困難化）
- `SUGGESTION`: 任意の改善提案

**判定に迷う場合は低い方に倒す。** 過剰なBLOCKERはトリアージ側の信頼を毀損する。

### 出力形式

各Reviewerは以下のJSON配列だけを返す。

```json
[
  {
    "aspect": "Correctness",
    "path": "src/foo.ts",
    "line_anchor": "await saveUser(user)",
    "context_before": "if (!user.id) throw new Error('missing id')",
    "context_after": "return user",
    "summary": "User persistence can report success before the write completes",
    "severity": "BLOCKER",
    "severity_rationale": "APIが成功を返した後に永続化が失敗するとデータ損失が発生するため",
    "body": "## 観測した事実\n\n変更後のコードは saveUser(user) を await せずに呼び出している。\n\n## 放置すると何が起きるか\n\nsaveUser が reject された場合、API は成功を返しているにもかかわらずユーザーデータが永続化されない。\n\n## 修正の方向性\n\nsaveUser(user) を await してから user を返すように修正する。",
    "verified_references": ["src/foo.ts", "src/userRepository.ts"]
  }
]
```

- `severity`: 上記判定規準に従った深刻度（`BLOCKER` / `MAJOR` / `SUGGESTION`）
- `severity_rationale`: 判定根拠を1行で記述する
- `body`: Markdown自由記述。ただし、観測した事実・放置すると何が起きるか・修正の方向性が読み取れること
- `line_anchor`: PR head実ファイルに存在する連続したコード断片そのものにする。要約・説明文・diff hunk headerは禁止
- `verified_references`: 実際に確認したファイルを入れる

## RM出力

`OUTPUT`には以下のJSONオブジェクトを書き出す。

```json
{
  "pr": 123,
  "repo": "owner/repo",
  "headRefOid": "...",
  "findings": []
}
```

`findings`はReviewerが返したfinding配列を連結したものにする。
JSON以外の説明やMarkdownを`OUTPUT`へ混ぜてはならない。
