---
normative-file: skills/gh-maestro-orchestrator/SKILL.md
---

# 人間への通知は、orchestrator の応答が終わるたびに Stop hook で送る

## 決めたこと

orchestrator から人間への通知（`notify-human.js`）は、Claude Code の Stop hook で、`/gh-maestro` を実行したセッションの応答が終わるたびに送る。応答の内容（末尾が問いかどうか等）で送るかどうかを判定しない。セッションの見分けは、既存のセッション初期化で記録したセッションIDで行う（Issue #611、PR #612）。

## なぜ

hook が見られるのは応答の形だけであり、人間に用があるかどうかは判定できない。人間に知らせるべき応答は、判断や承認を求める問いだけではない。作業の完了や結果の報告も含まれ、それらは問いで終わるとは限らない。形で絞ると、知らせるべき応答が黙って落ちる。

また、問いで終えることを通知の条件にすると、通知されるかどうかが再び orchestrator が規範を思い出せるかに依存する。Stop hook に移したのは、その依存（Issue #611）をなくすためだった。

## 却下した案

- 応答の末尾が問いで終わるときだけ通知する案（`docs/adr/0044-notify-human-by-stop-hook-on-question.md`）。hook には人間に用があるかを判定できず、問いで終わらない完了報告などが通知されない。問いで終える規範を守れるかに通知が依存し、Stop hook に移した目的と矛盾するとして人間が破棄した。
- Notification hook の idle_prompt で送る案。鳴る時機が遅れ、受信監視の稼働中に発火するかも資料から確認できなかったため採らなかった。
- 人間の発言ごとに UserPromptSubmit hook で規範の要約を文脈へ差し込み、通知を含む発言ごとの規範を想起させる案。発言のたびに同じ文をコンテクストへ積み増す浪費になるとして人間が却下した。
- orchestrator セッションの記録用に `/gh-maestro` の UserPromptExpansion へ新しい hook を足す案。同じ契機で動く既存のセッション初期化 hook があり、二重になるため採らなかった。
