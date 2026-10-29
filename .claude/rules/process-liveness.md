---
paths:
  - "scripts/process-lifecycle.js"
  - "scripts/shared/*liveness*.js"
---

# プロセスの生存確認

プロセスの生死を PID で判定しない。相手が死ねば OS が解放・通知するもの（親子間のパイプの切断、名前付きパイプ／Unix domain socket への接続可否）で判定する。親子の gh-maestro プロセスは stdin EOF を使う。Claude Code plugin monitor 自体は親セッションを見張らず、同じ役割の次回起動が既存 monitor を停止して引き継ぐ。

生存確認は共通のモジュールを通す。各スクリプトが個別に生死を判定する処理を書かない。
理由と経緯: docs/adr/0047-liveness-via-os-released-resources.md
理由と経緯: docs/adr/0048-plugin-monitor-exit-by-takeover.md
