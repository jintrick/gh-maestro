---
paths:
  - "workflows/**/*.yml"
  - "workflows/**/*.yaml"
  - ".github/workflows/**/*.yml"
  - ".github/workflows/**/*.yaml"
---

# CI ワークフロートリガーの禁止ルール

## `synchronize` トリガーの使用禁止

`pull_request` イベントの `types` に `synchronize` を含めてはならない。

```yaml
# 禁止
on:
  pull_request:
    types: [opened, synchronize, reopened]

# 正しい
on:
  pull_request:
    types: [opened, reopened]
```

**理由**: `synchronize` はPRへの追加プッシュのたびにCIが起動する。
レビューCIは1PRにつき1回だけ実行される設計であり、再実行は close → reopen で明示的に行う。
`synchronize` を含めると無限ループとAPIの過剰課金が発生する。

## 既存ファイルを書き直す際の禁止事項

`caller-template/ai-review.yml` など既存のワークフローテンプレートを書き直す場合、
訓練データの「標準的なパターン」を使ってはならない。
必ず既存ファイルを Read して現在のトリガー設定を確認し、そのまま踏襲すること。
