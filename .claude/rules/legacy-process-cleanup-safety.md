---
paths:
  - "scripts/remove-worker.js"
  - "scripts/reset-session.js"
---

# レガシープロセスのkillロジックは「対象ファイルの削除」と独立に扱う

`remove-worker.js` / `reset-session.js` が特定のPIDを掃除する処理（例: `notifierPid` のkill、`poller.json` を読んでのkill）は、その起動元スクリプト本体（`poll-and-notify.js`、`queue-poller.js` 等）を削除しても消してはならない。killロジックは「PIDさえ分かればプロセスを終了できる」処理であり、起動元スクリプトファイルの存在に依存しない。

- 実障害: `docs/github-comm-plan.md` 移行のPhase 2（PR #48）とPhase 3（PR #50）の**両方**で、「起動元スクリプトを削除するのでkillロジックも不要」という指示を出し、レビュー（Review Manager）で「移行前セッションが残したdetachedプロセスが検知不能なまま残り続ける」と指摘され、killロジックだけを復活させる手戻りが発生した。同一パターンが2回連続で再発した。
- 対策: 起動元スクリプトを削除・変更するIssue/PRでは、「対象プロセスを起動するコード」と「そのPIDを掃除するコード」を別項目として扱い、後者は移行期間中の後方互換の安全網として明示的に残すか、残さない理由を明記する。「削除する」と一括で書かない。
