---
source_url: https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/
original_title: Actions steps can now be run in parallel
fetched_at: 2026-06-28T00:00:00+00:00
note: >-
  GitHub Actions ネイティブ機能（gh-aw 上流ドキュメント未収録）。
  本ファイルは公式 changelog の意味論記述のみに基づく。
  正確な YAML 書式は公式 workflow-syntax リファレンスに未反映のため、
  書式が公開され次第このファイルを書式付きで更新すること。
---

# GitHub Actions: ステップの並列実行（Parallel Steps）

2026-06-25 に GitHub Actions に追加された機能。**同一ジョブ内のステップを並列実行**できるようになった。

従来 GitHub Actions では、並列実行は**ジョブ単位**（ジョブはデフォルト並列、`needs:` で逐次化）でしか制御できず、**同一ジョブ内のステップは逐次実行のみ**だった。今回、ステップを非同期で起動し、任意の同期点で待ち合わせる仕組みが導入された。

## 新設キーワード

出典: [公式 changelog (2026-06-25)](https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/)

| キーワード | 意味（changelog の記述に基づく） |
|---|---|
| `background: true` | そのステップを**非同期で起動**し、完了を待たず即座に次のステップへ進む |
| `wait` | 指定した**名前付き background ステップ**の完了まで実行を一時停止する。1個または複数のステップを対象にできる |
| `wait-all` | それまでの**全 background ステップ**が完了するまで一時停止する |
| `cancel` | 不要になった background ステップを**正常終了（graceful terminate）**させる。長時間動くサービスを起動しておき、用が済んだら止める用途 |
| `parallel` | ステップ群をまとめて `background` 化し、後ろに `wait` を付与する**糖衣構文**。「複数ステップを並列で走らせて、終わったら次へ」を簡潔に書ける |

## 想定ユースケース（公式）

1. **独立タスクの同時実行** — 複数ビルドなど、互いに依存しないタスクを並行実行する
2. **サービス起動 → 依存処理 → 後始末** — `background` で長時間サービスを起動し、依存処理を実行したのち `cancel` でクリーンに停止する
3. **ノンブロッキング処理の併走** — 主処理の裏で別処理を走らせる

シェルのバックグラウンド実行（`&`）による従来の回避策と異なり、**各ステップが独立したログを保持**する点が利点。

## YAML 書式について（重要）

> [!WARNING]
> 本機能の**正確な YAML 書式は、本ファイル作成時点（2026-06-28）で公式 workflow-syntax リファレンスにまだ反映されていない**。
> 公式 changelog にも YAML 例は含まれていなかった。
> 以下は未確定のため、ここには書式例を記載しない（推測での記載は禁止）。
>
> - `wait` が background ステップを参照する際のキー（`id` か `name` か）
> - `parallel` 配下のステップのネスト構造
> - `cancel` の対象指定方法
>
> 公式 syntax ドキュメント（`jobs.<job_id>.steps[*]` 配下）に書式が掲載され次第、
> 検証済みの YAML 例を付してこのファイルを更新すること。

## 並列実行の3階層（位置づけ）

GitHub Actions の「並列実行」制御は、今回の追加で3階層になった。

| レイヤー | 制御対象 | 主なキーワード |
|---|---|---|
| ワークフロー間 | 同時走行・キャンセル・キュー | `concurrency` / `concurrency.queue`（`single`/`max`） |
| ジョブ間 | デフォルト並列、依存で逐次化、matrix の並列度 | `needs` / `strategy.matrix` / `max-parallel` |
| **ステップ間** | **ステップの並列・待機・キャンセル** | **`background` / `wait` / `wait-all` / `cancel` / `parallel`（2026-06-25 新設）** |

## gh-aw との関係

- gh-aw 上流ドキュメント（2026-06-27 取得時点）は本機能を未収録。gh-aw のコンパイラ／safe-outputs が `background` 等を生成・サポートするかは未確認。
- gh-aw 側の並列・並行制御は `concurrency` / `queue` / `job-discriminator` / matrix ファンアウトが担う。詳細は [Concurrency Control](./gh_aw_concurrency_job_control_reference.md) を参照。

## 関連ドキュメント

- [公式 changelog: Actions steps can now be run in parallel (2026-06-25)](https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/)
- [Concurrency Control](./gh_aw_concurrency_job_control_reference.md) — ワークフロー／ジョブ単位の並行制御
- [GitHub Actions Primer](../guide/gh_aw_github_actions_primer_guide.md) — ジョブ／ステップの基礎概念
