---
name: gh-maestro-install
description: gh-maestroをインストール／アップデートする。gh-maestroリポジトリのルートディレクトリで呼び出すこと。
---

gh-maestroのグローバルインストールを実行する。

## 手順

1. 現在のディレクトリが gh-maestro リポジトリのルートであることを確認する（`skills/` や `scripts/` が存在するか確認）
2. **現在のブランチが `dev`（または `main`）であることを確認する。WIPブランチでの実行は禁止。** 確認には `git branch --show-current` を使用する。
3. インストーラを実行する：`node scripts/install.js`
4. 完了メッセージを確認してユーザーに報告する

## インストール後

ターゲットリポジトリへの AI Code Review CI 導入（`reviewer` ワークフローのデプロイ）は、
対象プロジェクトで `/gh-maestro` を初回起動したときに自動的に実行される。
手動操作は不要。
