---
source_url: gh-maestro-supplement
original_title: cross_repo_reusable_workflow_integration
fetched_at: 2026-06-17
---

# Cross-Repo Reusable Workflow + gh-aw 統合ガイド

gh-aw でコンパイルされた workflow を **cross-repo reusable workflow** として
別リポジトリから呼び出す際に発生する問題と対処法をまとめる。

## アーキテクチャ概要

```
gh-maestro (provider)
  .github/workflows/reviewer-*.yml    ← コンパイル済み reusable workflow
  workflows/reviewer-*.lock.yml       ← lock ファイル（setup-ai-review.js が deploy）
  workflows/reviewer-*.md             ← ソースファイル（同上）

target repo (e.g. ShiftMaker)
  .github/workflows/ai-review.yml    ← caller テンプレート
  .github/workflows/reviewer-*.lock.yml ← lock ファイル (deploy 済み)
  .github/workflows/reviewer-*.md      ← ソースファイル (deploy 済み)
```

`ai-review.yml` は以下のように gh-maestro の workflow を参照する：

```yaml
jobs:
  review-maintainability:
    uses: jintrick/gh-maestro/.github/workflows/reviewer-maintainability.yml@main
    with:
      pr_number: ${{ github.event.pull_request.number }}
    secrets: inherit
```

gh-maestro が更新されると、hooks が `setup-ai-review.js` を起動して
lock/source ファイルを target に自動同期する。workflow コード本体は
`@main` 参照なので再デプロイ不要で即反映される。

---

## 問題 1: runtime-import がクロスリポジトリで失敗する

### 症状

```
ERR_API: Failed to process runtime import for reviewer-maintainability.md:
ERR_SYSTEM: Runtime import file not found:
  /home/runner/work/ShiftMaker/ShiftMaker/.github/workflows/reviewer-maintainability.md
```

### 原因

`gh aw compile` が生成するコンパイル済み `.yml` は activation job に以下の
ステップを持つ：

```yaml
- name: Checkout .github and .agents folders
  if: steps.resolve-host-repo.outputs.target_repo == github.repository
```

`target_repo`（reusable workflow の提供元 = gh-maestro）と
`github.repository`（caller = ShiftMaker）が異なるため、チェックアウトが
**スキップ**される。

続く "Interpolate variables and render templates" ステップが
`{{#runtime-import reviewer-maintainability.md}}` を処理しようとするが、
ワークスペースにファイルが存在せず失敗する。

### 対処

`{{#runtime-import reviewer-*.md}}` をコンパイル済み `.yml` 内で
プロンプト本文そのものに置き換える（コンパイル時インライン化）。

```javascript
// scripts 内で実行する変換処理のイメージ
const body = mdContent.split(/^---\s*$/m).slice(2).join('---').trimStart();
const directive = `{{#runtime-import ${name}.md}}`;
// directive 行をインデントを保ちつつ本文内容に差し替える
```

これにより：
- ローカルファイルアクセスが不要になる
- プロンプト内の `${{ inputs.pr_number }}` は GHA の式評価で展開される
  （`run:` ブロック内の YAML 値として評価されるため、bash heredoc の
  single-quote 指定に関わらず展開される）
- `interpolate_prompt.cjs` の runtime import 処理はスキップされる

---

## 問題 2: concurrency グループ名の衝突

### 症状

3 つの reviewer workflow を並列呼び出しすると、うち 2 つが `cancelled`（1秒以内）になる。

### 原因

コンパイル済み `.yml` の concurrency 設定：

```yaml
concurrency:
  group: "gh-aw-${{ github.workflow }}"
```

`github.workflow` は reusable workflow 内では **caller のワークフロー名**（例：
"AI Code Review"）に解決される。3 つの reviewer が同じグループ名を共有するため、
同時に起動できるのは 1 つだけ。`cancel-in-progress` が `false`（デフォルト）の場合、
後着の pending job がキャンセルされる。

具体的な動作：

1. review-maintainability 起動 → concurrency グループ "gh-aw-AI Code Review" を取得
2. review-correctness 起動 → PENDING（グループ待ち）
3. review-resilience 起動 → PENDING の review-correctness をキャンセルしてグループ待ちへ
4. review-maintainability 完了 → review-resilience が起動
5. review-correctness は cancelled のまま

### 対処

各 reviewer 固有のグループ名に変更する：

```yaml
concurrency:
  group: "gh-aw-reviewer-maintainability-${{ github.ref }}"
```

- 同じ reviewer は同一ブランチで重複実行しない（同一ブランチへの連続 push 時の保護）
- 異なる reviewer は独立したグループで並列実行できる

---

## 問題 3: DeepSeek の detection 出力が bold markdown になる

### 症状

```
⚠️ ERR_PARSE: ❌ No THREAT_DETECTION_RESULT found in detection log.
The detection model may have failed to follow the output format.
```

safe_outputs が WTD3 warn ポリシーで review コメントをブロック。

### 原因

gh-aw の detection フェーズは Claude Code CLI を実行し、エージェントの出力の
安全性を確認する。パーサーは detection.log 内の以下のパターンを検索する：

```
THREAT_DETECTION_RESULT:{"prompt_injection":false,...}
```

しかし DeepSeek v4-flash はこの値を **bold markdown** で出力する：

```
**THREAT_DETECTION_RESULT:{"prompt_injection":false,...}**
```

detection フェーズも `engine.env` の設定を引き継ぎ、同じ DeepSeek モデルを使う：

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
  ANTHROPIC_BASE_URL: https://api.deepseek.com/anthropic
  ANTHROPIC_MODEL: deepseek-v4-flash
```

### 対処

"Parse and conclude threat detection" ステップの直前に、detection.log から
bold markdown を除去するステップを挿入する：

```yaml
- name: Normalize detection log markdown
  if: always() && steps.detection_guard.outputs.run_detection == 'true'
  run: |
    sed -i 's/**THREAT_DETECTION_RESULT:/THREAT_DETECTION_RESULT:/g; s/}**"/}"/g' \
      /tmp/gh-aw/threat-detection/detection.log || true
```

---

## 問題 4: lock ファイルが caller リポジトリにない

### 症状

```
ERR_API: Could not verify frontmatter hash for
'.github/workflows/reviewer-resilience.md'
```

または activation job が "Check workflow lock file" で失敗。

### 原因

activation job の "Check workflow lock file" ステップは
`check_workflow_timestamp_api.cjs` を実行し、caller リポジトリの
`.github/workflows/reviewer-resilience.lock.yml` を探す。
`setup-ai-review.js` が lock ファイルと source ファイル（`.md`）を
デプロイしていないと 404 になる。

### 対処

`setup-ai-review.js` に以下を追加する：

```javascript
// lock ファイルのデプロイ
const lockFiles = readdirSync(workflowsDir)
  .filter(f => f.endsWith('.lock.yml'))
  .map(f => ({ name: f, path: resolve(workflowsDir, f) }));

// source ファイルのデプロイ（frontmatter hash 検証に必要）
const sourceFiles = readdirSync(workflowsDir)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ name: f, path: resolve(workflowsDir, f) }));
```

---

## 問題 5: refs/pull/N/merge の staleness

### 症状

`gh run rerun` で再実行しても、修正前の SHA で実行される（修正が反映されない）。

### 原因

`refs/pull/N/merge` は GitHub が管理する仮想的なマージコミット。
PR の **HEAD ブランチへの push** があったときのみ更新される。
base ブランチへの変更（lock ファイルのデプロイなど）は更新をトリガーしない。

### 対処

PR の HEAD ブランチ（`issue-N-*` など）に空コミットを push して
`refs/pull/N/merge` を強制更新する：

```bash
git commit --allow-empty -m "ci: retrigger gh-aw review"
git push origin <head-branch>
```

---

## caller テンプレートに必要な permissions

private リポジトリで reusable workflow を呼び出す場合、caller の
`ai-review.yml` に以下が必須：

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: write
```

省略すると nested job が起動直後に `startup_failure` になる。
詳細は `docs/rag/gh-aw/guide/gh_aw_guide_caller_workflow_permissions_for_private_repos_guide.md` を参照。

---

## setup-ai-review.js が deploy するファイル一覧

| ファイル | 用途 |
|---|---|
| `.github/workflows/ai-review.yml` | caller テンプレート |
| `.github/workflows/reviewer-*.lock.yml` | lock ファイル（"Check workflow lock file" が参照） |
| `.github/workflows/reviewer-*.md` | source ファイル（frontmatter hash 検証に必要） |

---

## 設計上の注意

- `{{#runtime-import}}` を使う gh-aw workflow は same-repo 前提で設計されている。
  cross-repo で使う場合は compile 時インライン化が必要。
- `concurrency.group` に `${{ github.workflow }}` を使うと caller 名に解決されるため、
  複数の reusable workflow を並列呼び出しする設計では使えない。
- detection フェーズも `engine.env` を引き継ぐため、agent と同じモデルが使われる。
  Claude 以外のモデルで detection を行う場合、出力フォーマットの互換性を確認すること。
