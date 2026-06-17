---
source_url: gh-maestro-supplement
original_title: caller_workflow_permissions_for_private_repos
fetched_at: 2026-06-17
---

# Caller Workflow Permissions for Private Repositories

gh-aw でコンパイルされた reusable workflow を private repository から呼び出す場合、
caller 側のワークフローに **`permissions:` ブロックを明示的に宣言する必要がある**。

## 背景

GitHub Actions では、private repository のデフォルト GITHUB_TOKEN 権限は `none` に近い。
Reusable workflow を `uses:` で呼び出す際、callee (gh-aw workflow) は caller から権限を引き継ぐ。
`permissions:` を省略すると callee が要求する権限がすべてブロックされ、`startup_failure` になる。

Public repository ではデフォルト権限が `read` のため同じ caller template でも動いてしまい、
この問題が見落とされやすい。

## gh-aw workflow が要求する標準的な権限

gh-aw コンパイラが生成する reviewer 系ワークフローは以下の権限を各ジョブで要求する:

| ジョブ | 要求権限 |
|---|---|
| `pre_activation` | `actions: read`, `contents: read` |
| `activation` | `actions: read`, `contents: read` |
| `agent` | `contents: read`, `pull-requests: read` |
| `safe_outputs` | `contents: read`, `pull-requests: write` |
| `detection` | `contents: read` |

## Caller Template の必須記述

gh-aw reusable workflow を呼ぶ caller ワークフローには必ず以下を含めること:

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: write
```

`pull-requests: write` は `read` を包含するため、上記3行で全ジョブの要件を満たす。

## エラーの見分け方

caller に `permissions:` がない場合、GitHub Actions は `startup_failure` を返す。
ジョブが1件も起動されず、ログも存在しない（`log not found`）。

エラーメッセージ例:
```
Invalid workflow file: .github/workflows/ai-review.yml#L7
The nested job 'activation' is requesting 'actions: read', but is only allowed 'actions: none'.
The nested job 'agent' is requesting 'pull-requests: read', but is only allowed 'pull-requests: none'.
```

このメッセージは GitHub Actions UI でのみ確認できる（API からは取得不可）。

## 参照

- [GitHub Actions: permissions for GITHUB_TOKEN](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token)
- [Reusable workflows and permissions](https://docs.github.com/en/actions/using-workflows/reusing-workflows#supported-keywords-for-jobs-that-call-a-reusable-workflow)
