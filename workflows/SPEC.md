# レビュアーワークフロー仕様

## 構成概要

PR が opened / reopened されると、**単一の AI レビュアー** `reviewer` が起動し、1回のランで3観点すべてをレビューする。

| 観点 | 内容 |
|---|---|
| Correctness | システム不変条件の破壊・境界値・状態遷移・後方互換性・認可 |
| Maintainability | 命名・lint抑制・アンチパターン・複雑性・責務分離・テスト品質 |
| Resilience & Security | エラー処理・非同期バグ・無限ループ・タイムアウト・外部依存障害・セキュリティ |

> **2026-06-24: 3並列レビュアー構成を廃止し、1本に統合した。**
> 理由: reusable workflow（`workflow_call`）+ caller（`ai-review.yml`）の二重構造が
> runtime-import パス解決・concurrency グループ衝突・artifact prefix 衝突など
> 多数のバグ源となり、管理コストが過大だった。単一の direct-trigger ワークフローに
> 集約することで、これら構造由来のバグをすべて排除した。

---

## ファイル構成

```
.github/
  workflows/
    reviewer.lock.yml                    # 実行ワークフロー（gh-aw コンパイル出力のコピー / on: pull_request）
    reviewer.md                          # runtime-import される本体プロンプト
    shared/
      reviewer-output-policy.md          # SUGGESTION/BLOCKER 形式・ターン予算（runtime-import で読込）

workflows/
  reviewer.md                            # gh-aw ソース（人間が編集する）
  reviewer.lock.yml                      # gh-aw コンパイル出力（編集禁止）
  shared/
    reviewer-output-policy.md            # 廃止予定の重複（正準は .github/workflows/shared/）
```

`reviewer.lock.yml` は `on: pull_request: [opened, reopened]` で**直接起動する**。caller も
reusable workflow も存在しない。

---

## コンパイルの仕組み

gh-aw（GitHub Agentic Workflow）が `reviewer.md` のフロントマターを読んで GitHub Actions YAML
（`reviewer.lock.yml`）を生成する。SHA ピン・権限・ツール・safe-outputs 定義はコンパイル時に固まる。

### コンパイルコマンド

```bash
gh aw compile -d workflows
```

`workflows/reviewer.lock.yml` が再生成される。その後 `.github/workflows/` にコピーする：

```bash
cp workflows/reviewer.lock.yml .github/workflows/reviewer.lock.yml
```

---

## runtime-import による本体読込

コンパイル後のロックファイルには gh-aw が以下のマクロを生成する：

```
{{#runtime-import reviewer.md}}
{{#runtime-import shared/reviewer-output-policy.md}}
```

CI 実行時に `runtime_import.cjs` がこれらを解決する。**パスは `.github/workflows/` を基準とした相対**
で解決される（リポジトリルート基準ではない）。

- `reviewer.md` → `.github/workflows/reviewer.md`
- `shared/reviewer-output-policy.md` → `.github/workflows/shared/reviewer-output-policy.md`

そのため `reviewer.md` と `shared/` も対象リポジトリにデプロイする必要がある（`setup-ai-review.js` が行う）。

---

## PR番号の参照

direct trigger（`pull_request`）なので、プロンプト内では `${{ github.event.pull_request.number }}` を使う。
`inputs.pr_number` は `workflow_call` 専用であり、現構成では解決されない（使用禁止）。

---

## 更新手順

| 変更対象 | 手順 |
|---|---|
| フォーマットポリシー（SUGGESTION / BLOCKER 形式・ターン予算） | `.github/workflows/shared/reviewer-output-policy.md` を直接編集。**コンパイル不要**。次の CI 実行から反映 |
| プロンプト本体（重点観点・禁止事項など） | `workflows/reviewer.md` を編集 → `gh aw compile -d workflows` → `.github/workflows/` にコピー |
| フロントマター（権限・ツール・エンジン・max-turns・トリガー） | 同上 |

---

## デプロイ・再トリガ

**デプロイ**: `node scripts/setup-ai-review.js <owner/repo>` が `buildManifest()` の定義に従い、
`reviewer.lock.yml`・`reviewer.md`・`shared/*` を対象リポジトリの `.github/workflows/` に API デプロイする。
旧構成のファイル（`reviewer-correctness.*` 等・`ai-review.yml`）は自動で削除する（`pruneStaleFiles`）。

**再トリガ**: トリガーは `opened` と `reopened` のみ。既存PRの再レビューは **close→reopen**。
`synchronize` は含めない。

> デプロイ済みリポジトリで作成された PR ブランチは、その時点のワークフローファイルを抱える。
> gh-aw activation は PR head の `.github/` を読むため、ワークフロー修正後は各 PR ブランチへ
> base ブランチをマージして伝播させる必要がある（毎回手作業）。

---

## 注意点

- `.github/workflows/reviewer.lock.yml` は `workflows/reviewer.lock.yml` のコピー。**直接編集しない**
- `reviewer.md` のボディには `{{#runtime-import shared/reviewer-output-policy.md}}` を書く（gh-aw 公式構文。独自の `{{#include}}` は廃止済み）
- PR番号は `${{ github.event.pull_request.number }}`（`inputs.pr_number` 禁止）

---

## 廃止済み

| 廃止物 | 理由 |
|---|---|
| 3並列レビュアー（`reviewer-correctness/-maintainability/-resilience`） | 単一 `reviewer` に統合。reusable+caller 二重構造のバグ源を排除 |
| `caller-template/ai-review.yml` | direct trigger 化で caller 不要に |
| `aw_context`（artifact prefix 衝突防止） | 並列でなくなったため不要 |
| `scripts/compile-reviewers.js` / `lib/compile-reviewers-utils.js` / `tests/compile-reviewers.test.js` | gh-aw の `gh aw compile` で代替。`{{#include}}` は独自構文だった |
