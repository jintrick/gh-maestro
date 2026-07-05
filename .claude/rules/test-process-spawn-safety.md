---
paths:
  - "tests/**"
  - "scripts/queue*.js"
  - "scripts/poll-and-notify.js"
  - "scripts/spawn-worker.js"
  - "scripts/pane-notify.js"
  - "scripts/reset-session.js"
---

# テスト内での実プロセス spawn 禁止

`.gh-maestro` のプロセス群（poller / notifier / worker）は detached な常駐プロセスを起動する。**テストがこれらを実起動すると孤児プロセスが累積する。** 過去に単一のテストスイート実行で detached poller が **65 プロセス・CPU 100%** に達し、手動強制停止が必要になった。

- **テストは poller / watcher / detached child process を実起動しない。** spawn を env フラグ（例: `GH_MAESTRO_DISABLE_LAZY_POLLER=1`）でゲートするか、spawn 関数を注入してモックし、**テストは実プロセスを 0 個 spawn する**。
- **`detached` + `unref` のプロセスはテストランナーをブロックも失敗もさせない。** `node --test` は緑で完走するため「全テスト pass」ではこの被害を検出できない。緑を安全の根拠にしない。
- **間接的な spawn 経路も塞ぐ。** 直接 spawn していないテストでも、ヘルパー経由で lazy-start 等を発火させることがある（実例: `queue-ack` / `queue-status` のテストが `runSend` → `queue-send` の lazy-start を発火させ、ゲート漏れになった）。「このテストは直接 spawn しないから安全」は誤り。spawn しうるコードを**間接的にでも**呼ぶ全テストでゲートを立てる。
- **spawn しうるコードのテスト実行後は、孤児プロセスが 0 であることを確認する。** 例（Windows）: `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -like '*queue-poller*' }).Count"` が 0。
- **lazy-start / lease 取得は真にアトミックに。** poller.json 等の起動ロックは `fs.writeFileSync(path, payload, { flag: 'wx' })` で作成し、非アトミックな存在チェック＋書き込みでレースを作らない（二重起動＝プロセス増殖の温床）。
- 常駐プロセスは終了経路を確実に持つ: シグナルハンドラ内で `process.exit()` を呼ぶ、フォールバックの `setInterval` を `unref()` しない（イベントループを維持する）。
