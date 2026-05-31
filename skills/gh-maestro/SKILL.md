---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。wmuxに2ペインを追加してcoder/reviewerエージェントを起動し、自身がorchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
shell: powershell
---

## 前提

このスキルは **wmuxペイン内** から呼び出すこと。wmuxが未起動の場合、Named Pipe接続に失敗する。

## セットアップ手順

以下のスクリプトを実行する：

```powershell
& "$env:USERPROFILE\.gh-maestro\scripts\gh-maestro-setup.ps1"
```

スクリプトが成功すると `.gh-maestro/session.json` が書き込まれ、coder/reviewerペインで agy が起動する。

## セッション情報の読み込み

スクリプト成功後、session.jsonを読み込む：

```powershell
Get-Content '.gh-maestro/session.json' | ConvertFrom-Json
```

取得したJSONの各フィールド：
- `repo`: 対象GitHubリポジトリ（owner/repo形式）
- `coderPtyId`: coderエージェントのptyId（A2A送信先）
- `reviewerPtyId`: reviewerエージェントのptyId（A2A送信先）
- `orchestratorPtyId`: 自分自身のptyId

## 以降の動作

session.jsonの読み込みが完了したら、`gh-maestro-orchestrator` スキルに定義されたワークフローに従って動作する。
