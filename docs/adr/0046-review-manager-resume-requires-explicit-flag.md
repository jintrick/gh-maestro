---
normative-file: skills/gh-maestro-orchestrator/SKILL.md
---

# Review Managerの途中再開は start-review-manager.js の --resume 指定時だけ行う

## 決めたこと

落ちた Review Manager を途中経過から再開するのは、`start-review-manager.js` に `--resume` を付けて起動したときだけとする。引数を付けない起動（`poll-pr.js` の自動起動を含む）は、途中経過が残っていても新しくレビューを始める。再開用の別スクリプト（`restart-review-manager.js`）は作らず、同じ入口への引数とする（Issue #649）。

## なぜ

`start-review-manager.js` は人間や orchestrator だけでなく、PR を検出した `poll-pr.js` からも自動で呼ばれる。途中経過があれば無条件に再開する形にすると、誰も再開を決めていない自動起動でも古い途中経過を拾う。再開・再試行の判断は orchestrator が持つ（`docs/adr/0006-no-headless-agent-retry.md`）ため、再開の意図を起動時に明示させる。入口を分けないのは、役割ごとに起動経路を増やさない判断（`docs/adr/0011-common-worker-review-manager-lifecycle.md`）に沿い、引数検証と `--help` を1つに保つためである。

## 却下した案

- 途中経過を使えるときはフラグなしで再開する案。起票案で一度採ったが、`poll-pr.js` の自動起動でも再開が起きるため採らなかった。
- 再開専用の `restart-review-manager.js` を新設する案。意図がファイル名で見える利点はあるが、引数検証と Usage が二重になり、内部では同じ起動処理を呼ぶことになるため採らなかった。
