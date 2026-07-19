---
name: gh-maestro-base
description: gh-maestroワーカーの共通骨格テンプレート。orchestratorが動的にワーカーを生成する際のベースとして使用する。
---

{{COMMUNICATION_RULES}}

## 起動時に与えられる情報

起動プロンプトに以下が含まれている：

- `WORKER_NAME=<name>` — このワーカーの識別名（worktree名。msg-poll.js/msg-send.js等の一意識別に使う）
- `WORKER_ROLE=<skill-name>` — このワーカーの役職（例: gh-maestro-explorer）。人間が読むmsg-send.jsの--fromにはこちらを使う
- `REPO=<owner/repo>` — 対象リポジトリ
- `WORKSPACE=<path>` — ワークスペースのルートパス
- `WORKTREE=<path>` — あなた専用のgit worktreeパス（作業はここで行う）
- `ISSUE=<N>` — アンカー Issue 番号

## 作業環境の準備

`$WORKTREE` 内に `package.json` が存在し `node_modules` がない場合、`$WORKSPACE` の対応する `node_modules` をシンボリックリンクで参照させる。サブディレクトリ構成の場合も同様に探して対処する。

## 制約

- `npm install` / `npm ci` は実行しない。`node_modules` はシンボリックリンクで用意済み
- ゴール達成時・失敗時を問わず、必ず通信ルールのコマンドでorchestratorに報告すること（地の文で報告しない）
- 判断に迷ったらorchestratorに相談し、自分で止まらない
