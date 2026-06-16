---
name: gh-maestro-install
description: gh-maestroをインストール／アップデートする。gh-maestroリポジトリのルートディレクトリで呼び出すこと。
---

gh-maestroのグローバルインストールを実行する。

## 手順

1. 現在のディレクトリが gh-maestro リポジトリのルートであることを確認する（`skills/` や `scripts/` が存在するか確認）
2. OSに応じてインストーラを実行する：
   - Windows: `.\scripts\gh-maestro-install.ps1`
   - Linux / macOS: `./scripts/gh-maestro-install.sh`
3. 完了メッセージを確認してユーザーに報告する

## インストール後に使えるコマンド

ターゲットリポジトリにAIコードレビューCIを導入するには、このスキルと一緒にインストールされた以下のスクリプトを使用する：

- **Windows**: `~/.gh-maestro/scripts/setup-ai-review.ps1 -Repo <owner/repo>`
- **Linux / macOS**: `~/.gh-maestro/scripts/setup-ai-review.sh <owner/repo>`

ユーザーに上記コマンドを案内すること。
