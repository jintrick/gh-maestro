---
normative-file: .claude/rules/process-liveness.md
---

# plugin monitor は親セッションを見張らず、強制終了の残骸は次の起動時の世代交代で止める

## 決めたこと

Claude Code の plugin が起動する常駐（plugin monitor）は、親である Claude Code セッションの生死を見張らない。通常の終了は、Claude Code 自身がタスクのプロセス群を止めることに任せる。Claude Code が強制終了されて plugin monitor が残った場合は、次に起動した plugin monitor が同じ役割の既存インスタンスを止めて引き継ぐ（後から起動したほうが常に正）。plugin monitor より下流の常駐は、gh-maestro 同士の親子として OS が解放するもの（stdin の EOF やパイプの切断）で plugin monitor の終了を知る。

## なぜ

Issue #654 の実機確認で、plugin monitor の stdin は親が生きているうちから起動直後に EOF になり、親の終了通知に使えないことが分かった。通常終了（/exit）では Claude Code が monitor とその子を約0.15秒で止める一方、Claude Code だけが強制終了されると monitor と子は残る。Node 標準の範囲には、強制終了した Claude Code の死を OS が通知してくれる資源が無い。

強制終了の残骸の一番の実害は、次のセッションの plugin monitor が「既に動いている」と判定して自分が降り、新しいセッションへ通知が届かなくなることである。起動時の世代交代はこれを直接なくす。残骸が次のセッションまで空回りする時間は残るが、外部プロセスを起動しない周期処理だけなので、#654 の問題（PowerShell の連続起動による Defender 負荷）は起きない。

## 却下した案

- plugin monitor に限り、PID による親の見張りを ADR 0047 の例外として残す案。放置中の残骸も数秒で止められるが、直接の親は強制終了でも残る Git Bash のラッパーであり、その上のターミナルまで行き過ぎずに Claude Code の PID だけを環境に依らず特定する処理が要る。従来の親探索は実際にターミナルの PID を掴んでおり、Claude Code の強制終了を検知できていなかった（ADR 0029 の経緯）。壊れやすい探索を再び抱え込み、PID 判定の例外も生むため採らない。
- OS が解放する別の資源で親の終了を知る案。stdout の切断は書き込むまで分からず、間に残るシェルがハンドルを持ち続ける。フックは短命な子プロセスでセッションの寿命を表せない。Claude Code はセッション寿命と一致する IPC を公開していない。プロセスハンドルの待機は Node 標準 API に無い。いずれも成立しないため採らない。
