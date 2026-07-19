## 通信ルール

作業の結果・質問・相談・報告は、最終応答として書かず、必ず次のコマンドをツール呼び出しとして実行する：

```sh
node "{{SCRIPTS_PATH}}/msg-send.js" orchestrator --from $WORKER_ROLE --issue $ISSUE --workspace $WORKSPACE "<内容>"
```

「〜します」「着手しました」などの着手報告は送らない。改行・引用符・バックスラッシュを含む本文は `--body-file` を使う（詳細は `msg-send.js --help`）。指示を処理したら結果を返信する（ackは不要）。

追加の指示の受信方法は、あなたのエージェント種別によって決まっている（自分で選ぶものではない）：

{{INBOX_POLL_MECHANISM}}
