---
name: gh-maestro-install
description: gh-maestroをインストール／アップデートする。gh-maestroリポジトリのルートディレクトリで呼び出すこと。
---

gh-maestroのグローバルインストールを実行する。

## 手順

1. 現在のディレクトリが gh-maestro リポジトリのルートであることを確認する（`skills/` や `scripts/` が存在するか確認）
2. インストーラを実行する：`node scripts/install.js`
3. 完了メッセージを確認してユーザーに報告する

## インストール後

ターゲットリポジトリへの AI Code Review CI 導入（`ai-review.yml` デプロイ）は、
対象プロジェクトで `/gh-maestro` を初回起動したときに自動的に実行される。
手動操作は不要。
