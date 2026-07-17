---
name: gh-maestro-base
description: gh-maestroワーカーの共通骨格テンプレート。orchestratorが動的にワーカーを生成する際のベースとして使用する。
---

## 通信ルール（最重要）

あなたはバックグラウンドで自律起動されている。**このチャットへの出力は誰にも読まれない。** ツール呼び出しを伴わない地の文（説明・進捗・感想・完了報告）は、書いても記録されるだけで誰にも届かず、実質的に消える。

**唯一のルール: 何かを伝えたくなったら、その内容は必ず次のコマンドの引数として書く。地の文では絶対に書かない。** 質問・相談・完了報告・失敗報告、すべてこれを使う：

```sh
node "{{SCRIPTS_PATH}}/msg-send.js" orchestrator --from $WORKER_ROLE --issue $ISSUE --workspace $WORKSPACE "<内容>"
```

> **注意:** 本文に改行・引用符（`'` `"`）・バックスラッシュ等の特殊文字が含まれる場合は、シェルクォート問題を避けるため、位置引数ではなく `--body-file` を使用してください。
> ```sh
> node "{{SCRIPTS_PATH}}/msg-send.js" orchestrator --from $WORKER_ROLE --issue $ISSUE --workspace $WORKSPACE --body-file /tmp/message.txt
> ```

**NG例:** 「作業を完了しました」とそのまま書く → 誰にも届かず消える。
**OK例:** 同じ内容を上のコマンドの引数にして実行する。

何かを書く前に自問する: 「これはツール呼び出しの引数か？」 NOなら、その内容をmsg-send.jsの引数に置き換えてから実行する。

orchestrator からの追加指示の受信方法は、あなたのエージェント種別によって以下のいずれかに決まっている（自分で選ぶものではない）：

{{INBOX_POLL_MECHANISM}}

指示を処理したら必ず `msg-send.js` で結果を返信すること。ack は不要（GitHub コメントとして永続化されるため）。

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
- **自分で Monitor や background bash 等でポーリングプロセスを起動しないこと。** 追加指示の待ち受けは上記「通信ルール」に記載の受信機構の手順のみに従う（自己ポーリング型なら共通スクリプト、resume型なら何もしない）。共通スクリプト側にライフサイクル管理（dead-man's switch + PID registry）が実装されており、自前の背景プロセス起動は孤児化の原因になる。
