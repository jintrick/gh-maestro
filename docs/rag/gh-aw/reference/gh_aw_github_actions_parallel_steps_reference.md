---
source_url: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsbackground
original_title: Workflow syntax for GitHub Actions — Background / parallel steps
changelog_url: https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/
fetched_at: 2026-06-28T00:00:00+00:00
note: >-
  GitHub Actions ネイティブ機能（gh-aw 上流ドキュメント未収録）。
  YAML 例・仕様は公式 workflow-syntax リファレンス本文から逐語で取得・検証済み。
---

# GitHub Actions: ステップの並列実行（Background / Parallel Steps）

2026-06-25 に GitHub Actions に追加された機能。**同一ジョブ内のステップを並列実行**できるようになった。

従来は並列実行が**ジョブ単位**（ジョブはデフォルト並列、`needs:` で逐次化）でしか制御できず、**同一ジョブ内のステップは逐次実行のみ**だった。今回、ステップを非同期で起動し（`background`）、任意の同期点で待ち合わせる（`wait` / `wait-all`）、不要になれば停止する（`cancel`）仕組みが入った。`parallel` はその糖衣構文。

## キーワード一覧

| キーワード | 役割 |
|---|---|
| `background: true` | ステップを非同期起動し、完了を待たず次へ進む |
| `wait` | 指定した background ステップ（`id` 参照）の完了まで待つ。単一 id か id 配列 |
| `wait-all` | それまでの**全 active background ステップ**の完了まで待つ（引数なし） |
| `cancel` | background ステップ（`id` 指定・単一）を正常終了させる |
| `parallel` | ステップ群を並列実行し、末尾で暗黙の wait。糖衣構文 |

## `background`

ステップを非同期実行し、ジョブは完了を待たず次のステップへ進む。DB・サーバー・監視タスクなど、他ステップと並走させたい長時間プロセス向け。後で `wait` / `wait-all` で同期、または `cancel` で停止する。

- `run` ステップ・`uses` ステップどちらにも付与可
- `wait` / `cancel` から参照するには、そのステップに **`id` を付ける**
- **1ジョブ内で同時に走れる background ステップは最大 10 個**。超過分はスロットが空くまでキューされる
- background ステップの**出力・環境変更は、それを含む `wait` / `wait-all` を通過した後でのみ**後続から参照可能
- background ステップが失敗した場合、それを含む次の `wait` / `wait-all` の時点でジョブが失敗する（そのステップに `continue-on-error` が無い限り）
- ジョブの後処理（post-job cleanup）の前に**暗黙の `wait-all` が走る**

```yaml
steps:
  - name: Start server
    id: server
    run: npm start
    background: true

  - name: Run tests against the server
    run: npm test

  - name: Wait for the server step to finish
    wait: server
```

## `wait`

1つ以上の background ステップが完了するまでジョブを一時停止する。`wait` ステップ自体は何もせず、参照先の完了までブロックするだけ。**単一の step `id`（文字列）**、または**複数 `id`（配列）**を渡す。

- 通過後、参照先 background ステップの出力が後続で利用可能になる
- 参照先 background ステップが失敗していれば `wait` も失敗する

```yaml
steps:
  - name: Build frontend
    id: build-frontend
    run: npm run build:frontend
    background: true

  - name: Build backend
    id: build-backend
    run: npm run build:backend
    background: true

  - name: Run linter while builds run
    run: npm run lint

  - name: Wait for both builds to finish
    wait: [build-frontend, build-backend]

  - name: Run tests
    run: npm test
```

## `wait-all`

**全 active background ステップ**の完了まで待つ。複数の background が走っていて全部終わらせてから進みたいときに使う。`wait` 同様、待ち対象のいずれかが失敗すれば `wait-all` も失敗する（`continue-on-error: true` を設定しない限り）。**引数を取らない。**

```yaml
steps:
  - name: Start database
    id: db
    run: docker run -d postgres:15
    background: true

  - name: Start cache
    id: cache
    run: docker run -d redis:7
    background: true

  - name: Run integration tests
    run: npm run test:integration

  - name: Wait for all services to stop
    wait-all:
```

## `cancel`

走っている background ステップを正常終了させる。ランナーはプロセスに **`SIGTERM`** を送って後始末させ、短い猶予内に終了しなければ **`SIGKILL`** で強制停止する。**単一の background ステップを `id` で指定**する。

```yaml
steps:
  - name: Start long-running monitor
    id: monitor
    run: ./scripts/monitor.sh
    background: true

  - name: Run the main task
    run: npm test

  - name: Stop the monitor
    cancel: monitor
```

## `parallel`

ステップ群を並列実行し、全完了を待ってから次へ進む。糖衣構文で、**グループ内の各ステップが background 化され、グループ末尾に暗黙の `wait` が入る**。個別に参照する必要がない独立ステップ群向け。

- グループ内各ステップも**同じ 10 ステップ同時実行上限**の対象
- 個別参照（`wait`/`cancel` でのターゲット指定）はできない → 細かい制御が要るなら `background` を使う

```yaml
steps:
  - uses: actions/checkout@v6

  - parallel:
      - name: Build frontend
        run: npm run build:frontend

      - name: Build backend
        run: npm run build:backend

      - name: Build docs
        run: npm run build:docs

  - name: Run tests after all builds complete
    run: npm test
```

上記グループは「各ステップを `background: true` で宣言し、後ろに `wait` ステップを置く」のと等価。

## `background` と `parallel` の使い分け（公式）

- **`parallel`**: 限定的だが便利。「このグループを一斉に実行し、全部終わってからジョブを進める」用途（複数コンポーネントの同時ビルド等）
- **`background`**: 汎用プリミティブ。長時間プロセスを起動して後続ステップ実行中も生かす／特定ステップを `wait`・`cancel` で参照する／background 作業を他ステップと交互に挟む、といった細かい制御が要る場合

## 並列実行の3階層（位置づけ）

| レイヤー | 制御対象 | 主なキーワード |
|---|---|---|
| ワークフロー間 | 同時走行・キャンセル・キュー | `concurrency` / `concurrency.queue`（`single`/`max`） |
| ジョブ間 | デフォルト並列、依存で逐次化、matrix の並列度 | `needs` / `strategy.matrix` / `max-parallel` |
| **ステップ間** | **ステップの並列・待機・キャンセル** | **`background` / `wait` / `wait-all` / `cancel` / `parallel`（2026-06-25 新設）** |

## gh-aw との関係

- gh-aw 上流ドキュメント（2026-06-27 取得時点）は本機能を未収録。gh-aw のコンパイラ／safe-outputs が `background` 等を生成・サポートするかは未確認。
- gh-aw 側の並列・並行制御は `concurrency` / `queue` / `job-discriminator` / matrix ファンアウトが担う。詳細は [Concurrency Control](./gh_aw_concurrency_job_control_reference.md) を参照。

## 関連ドキュメント

- [公式 workflow-syntax: background / wait / wait-all / cancel / parallel](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsbackground)
- [公式 changelog: Actions steps can now be run in parallel (2026-06-25)](https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/)
- [Concurrency Control](./gh_aw_concurrency_job_control_reference.md) — ワークフロー／ジョブ単位の並行制御
- [GitHub Actions Primer](../guide/gh_aw_github_actions_primer_guide.md) — ジョブ／ステップの基礎概念
