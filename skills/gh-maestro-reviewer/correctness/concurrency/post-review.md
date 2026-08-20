# Correctness / Concurrency & Ordering — 事後確認表

## 重点

- 初回実行、再実行、中断後再開
- 二重登録・二重課金・二重通知
- トランザクション境界、部分成功、ロールバック漏れ
- グローバル状態・イベント発行・コールバック順序
- await漏れ、未処理Promise
- race condition、deadlock
