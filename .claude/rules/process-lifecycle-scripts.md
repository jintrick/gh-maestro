---
paths:
  - "scripts/process-lifecycle.js"
  - "scripts/msg-poll.js"
  - "scripts/poll-pr.js"
  - "scripts/poll-reviews.js"
  - "scripts/remove-worker.js"
  - "scripts/reset-session.js"
  - "scripts/start-review-manager.js"
  - "scripts/run-review-manager.js"
---

# プロセスライフサイクル管理スクリプトの落とし穴

- 外部由来のpid引数はshell/fs操作に使う前に `parseInt` + `Number.isFinite(pid) && pid > 0` で検証する
- Linuxのプロセス開始時刻はprocfsの`birthtime`でなく`mtime`を使う（`birthtime`は`1970-01-01`を返すことがある）
- `.gh-maestro/pids/` 等の1ファイル1レコードJSON stateを読むときは、`JSON.parse`結果が期待するオブジェクト型か検証してからプロパティアクセスする
- detachした子プロセスを起動する場合、lock/registryのPIDは子プロセス自身が起動直後に自PIDで上書きする（launcherのPIDのまま生死判定しない）
- `process-lifecycle.js`の`registerProcess`をワーカー起因のプロセスから呼ぶ場合は必ず`workerName`を渡す（`remove-worker.js`のターゲット削除に必要）
- lock/temp等のリソースを作成する処理は、生成箇所すべてを`try/finally`または対応するエラーハンドラ（`child.on('error')`/`('exit')`等）でカバーする。一部だけ（例: lockFileのみ）をカバーし他（briefFile等）を見落とすと、異常系でファイルが残留する（PR #84 Review Manager指摘）
