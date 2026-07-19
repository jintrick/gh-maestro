## 通信ルール

作業の結果・質問・相談・報告は、必ず次のコマンドをツール呼び出しとして実行して伝える：

```sh
node "{{SCRIPTS_PATH}}/msg-send.js" orchestrator --from $WORKER_ROLE --issue $ISSUE --workspace $WORKSPACE "<内容>"
```

「〜します」「着手しました」などの着手報告は送らない。改行・引用符・バックスラッシュを含む本文は `--body-file` を使う（詳細は `msg-send.js --help`）。指示を処理したら結果を返信する（ackは不要）。

すべての作業を終えたら、最終出力には `DONE` の1語だけを書く。

{{INBOX_POLL_MECHANISM}}
