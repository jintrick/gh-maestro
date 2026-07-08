---
paths:
  - "tests/**"
  - "scripts/spawn-worker.js"
  - "scripts/reset-session.js"
---

# テスト内での実プロセス spawn 禁止

**アーキテクチャ原則: detached プロセスをそもそも作らない。** gh-maestro の通信基盤は GitHub Issue コメントベースに移行済み（`docs/github-comm-plan.md`）。ポーリングはすべて呼び出し元エージェントのターン内で blocking 実行され、detached な常駐プロセスは存在しない。テストが実 spawn を必要とする根拠もない。

過去に `.gh-maestro` のプロセス群（poller / notifier / worker）は detached な常駐プロセスを起動していた。単一のテストスイート実行で detached poller が **65 プロセス・CPU 100%** に達し、手動強制停止が必要になった事例がある。

- **テストは poller / watcher / detached child process を実起動しない。** spawn を env フラグでゲートするか、spawn 関数を注入してモックし、**テストは実プロセスを 0 個 spawn する**。
- **ゲートするのは実 spawn であって、テストではない。** env フラグ/注入で抑止するのは実プロセスの spawn。テスト本体は既定スイート（`npm test`）で必ず実行する。テストごと env でスキップするとその回帰カバレッジが静かに消える。実 spawn 回避と既定実行の両立にはモック注入を優先。
- **`detached` + `unref` のプロセスはテストランナーをブロックも失敗もさせない。** `node --test` は緑で完走するため「全テスト pass」ではこの被害を検出できない。緑を安全の根拠にしない。
- **spawn しうるコードのテスト実行後は、孤児プロセスが 0 であることを確認する。** 例（Windows）: `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -like '*node --test*' }).Count"` が 0（テストランナー自身が終了すれば孤児は残らない）。
- **自プロセス（`process.pid`）を registry に登録するテストは、`afterEach` 等で必ず `unregisterProcess` すること。** 残留すると後続テストの `sweepRegistry`/`killProcessTree` がテストランナー自身を対象にする事故につながる（PR #64 で実際に発生）。
