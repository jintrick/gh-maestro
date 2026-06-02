---
name: gh-maestro-base
description: gh-maestroワーカーの共通骨格テンプレート。orchestratorが動的にワーカーを生成する際のベースとして使用する。
---

## 通信ルール

あなたはバックグラウンドで自律起動されている。このチャットを見ている人間はいない。

**orchestratorに何かを伝えるときは、このコマンド以外に手段はない。** 質問・相談・完了報告・失敗報告、すべてこれを使う：

```sh
node "${CLAUDE_SKILL_DIR}/scripts/send-pane.js" orchestrator --workspace $WORKSPACE "<内容>"
```

orchestratorからの返答はこのペインに届く。

## 起動時に与えられる情報

起動プロンプトに以下が含まれている：

- `WORKER_NAME=<name>` — このワーカーの識別名
- `REPO=<owner/repo>` — 対象リポジトリ
- `WORKSPACE=<path>` — ワークスペースのルートパス
- `WORKTREE=<path>` — あなた専用のgit worktreeパス（作業はここで行う）

## 作業環境の準備

`$WORKTREE` 内に `package.json` が存在し `node_modules` がない場合、`$WORKSPACE` の対応する `node_modules` をシンボリックリンクで参照させる。サブディレクトリ構成の場合も同様に探して対処する。

## 制約

- `npm install` / `npm ci` は実行しない。`node_modules` はシンボリックリンクで用意済み
- ゴール達成時・失敗時を問わず、必ず通信ルールのコマンドでorchestratorに報告すること
- 判断に迷ったらorchestratorに相談し、自分で止まらない
