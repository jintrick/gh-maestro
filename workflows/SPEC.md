# レビュアーワークフロー仕様

## 構成概要

PR が opened / reopened されると 3 つの AI レビュアーが並列起動する。

| レビュアー | 観点 |
|---|---|
| reviewer-correctness | システム不変条件の破壊・境界値・状態遷移・後方互換性 |
| reviewer-maintainability | 命名・アンチパターン・複雑性・責務分離 |
| reviewer-resilience | エラー処理・非同期バグ・セキュリティ・外部依存障害 |

---

## ファイル構成

```
.github/
  workflows/
    ai-review.yml                        # エントリポイント（3レビュアーを並列呼び出し）
    reviewer-{correctness,...}.yml       # 実行ワークフロー（lock.yml のコピー）
    shared/
      reviewer-output-policy.md          # 共有フォーマットポリシー（runtime-import で読込）

workflows/
  reviewer-{correctness,...}.md          # gh-aw ソースファイル（人間が編集する）
  reviewer-{correctness,...}.lock.yml    # gh-aw コンパイル出力（編集禁止）
  caller-template/
    ai-review.yml                        # ai-review.yml のテンプレート（デプロイ元）
  shared/
    reviewer-output-policy.md            # 廃止済み（.github/workflows/shared/ に移動済み）
```

---

## コンパイルの仕組み

gh-aw（GitHub Agentic Workflow）が `.md` フロントマターを読んで GitHub Actions YAML を生成する。SHA ピン・権限・ツール・safe-outputs 定義はコンパイル時に固まる。

### コンパイルコマンド

```bash
gh aw compile -d workflows
```

`workflows/*.lock.yml` が再生成される。その後、`.github/workflows/` にコピーする：

```bash
cp workflows/reviewer-correctness.lock.yml .github/workflows/reviewer-correctness.yml
cp workflows/reviewer-maintainability.lock.yml .github/workflows/reviewer-maintainability.yml
cp workflows/reviewer-resilience.lock.yml .github/workflows/reviewer-resilience.yml
```

---

## runtime-import による共有

コンパイル後のロックファイルには gh-aw が以下のマクロを生成する：

```
{{#runtime-import reviewer-correctness.md}}
{{#runtime-import shared/reviewer-output-policy.md}}
```

CI 実行時に `runtime_import.cjs` がこれらを解決する。

gh-aw はパスを `.github/workflows/` からの相対で解決する。`shared/reviewer-output-policy.md` → `.github/workflows/shared/reviewer-output-policy.md`。

---

## 更新手順

| 変更対象 | 手順 |
|---|---|
| フォーマットポリシー（SUGGESTION / BLOCKER 形式・ターン予算） | `.github/workflows/shared/reviewer-output-policy.md` を直接編集。**コンパイル不要**。次の CI 実行から反映 |
| プロンプトボディ（重点観点・禁止事項など） | `workflows/reviewer-*.md` を編集 → `gh aw compile -d workflows` → `.github/workflows/` にコピー |
| フロントマター（権限・ツール・エンジン・max-turns） | 同上 |

---

## 注意点

- `.github/workflows/reviewer-*.yml` は `workflows/reviewer-*.lock.yml` のコピー。**直接編集しない**
- `.md` ファイルのボディには `{{#runtime-import shared/reviewer-output-policy.md}}` を書く（gh-aw はパスを `.github/workflows/` 基準で解決する）
- `ai-review.yml` の各ジョブには `aw_context: '{"reviewer":"<name>"}'` が必須（artifact prefix 衝突防止）
- トリガーは `opened` と `reopened` のみ。`synchronize` は含めない。既存 PR の再レビューは close→reopen

---

## 廃止済み

| 廃止物 | 理由 |
|---|---|
| `scripts/compile-reviewers.js` | gh-aw の `gh aw compile` で代替。`{{#include}}` は独自構文で gh-aw 仕様変更に脆弱だった |
| `lib/compile-reviewers-utils.js` | 上記スクリプトのユーティリティ |
| `tests/compile-reviewers.test.js` | 上記に付随するテスト |
| `workflows/shared/reviewer-output-policy.md` | `.github/workflows/shared/` に移動済み |
