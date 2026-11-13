---
paths:
  - "skills/gh-maestro-orchestrator/SKILL.md"
  - "skills/gh-maestro-orchestrator/stage-*.md"
  - "skills/gh-maestro-orchestrator/triage.md"
  - "skills/gh-maestro-orchestrator/retrospective.md"
  - "skills/gh-maestro-orchestrator/lightweight-pr.md"
  - "skills/gh-maestro-orchestrator/premise-check.md"
  - "skills/gh-maestro-orchestrator/premise-check-stage-1.md"
  - "skills/gh-maestro-orchestrator/premise-check-stage-5.md"
  - "skills/gh-maestro-orchestrator/premise-check-stage-7.md"
  - "tests/orchestrator-step-numbering.test.js"
---

# 工程の構造宣言を更新する

`skills/gh-maestro-orchestrator/SKILL.md` は工程1〜9の骨格、`stage-<N>-*.md` は各工程のスキル断片を持つ。SKILL.md 冒頭の `<!-- gh-maestro-structure: stages=9 -->` は工程数、各工程見出し直下の `middle-items=N` はその工程の中項目数を宣言する。工程・中項目の増減時は同じ変更で宣言を更新する。

中項目は、SKILL.mdの骨格上で番号と必須／任意を示し、詳細手順は対応stageファイルに置く。PR_PUSH後のexplorer確認など、工程内の必須作業は工程の番号付き中項目として数える。

stage-1〜9、`triage.md`、`retrospective.md`、`lightweight-pr.md`、`premise-check.md`、`premise-check-stage-5.md`、`premise-check-stage-7.md` の15スキル断片は先頭front matterで配信合図を宣言する。`signals: - none` はstage-1だけに使う。`premise-check.md`（共通の定義）は `PLAN_REPORTED` と `PR_REVIEW`・`REVIEW_COMMENT`、`premise-check-stage-5.md` は `PLAN_REPORTED`、`premise-check-stage-7.md` は `PR_REVIEW`・`REVIEW_COMMENT` を宣言する。`premise-check-stage-1.md` は合図を持たないためスキル断片ではなく、工程1のスキル（`stage-1-requirements.md`）が参照するファイルとして扱う。通知名はSKILL.mdの「イベントの受け口」に存在し、script合図は実在する`scripts/` CLIが共有配信関数を呼ぶこと。
理由と経緯: docs/adr/0064-skill-fragments-split-per-signal.md

`tests/orchestrator-step-numbering.test.js` は工程・中項目の数に加え、15スキル断片の存在・合図宣言、通知名、script CLIと共有関数、各合図で届くスキル断片の9,000文字上限を検証する。数字やテスト期待値を、削除後の実体に合わせて無批判に縮めない。

**テストが落ちたとき、宣言の数字を実体に合わせて辻褄を合わせない。** 工程を意図して増減したのなら宣言と中項目を更新する。意図していないなら、消えた工程の方を戻す。宣言は工程の欠落を検出するためにある。

実障害: PR #420 以前のテストは工程名と中項目の一覧を期待値として直接持っており、正当な文書編集で落ちた。焼き込みをやめた結果、今度は工程を丸ごと削除しても通るようになった（Review Manager 指摘 MAJOR 2件、Issue #419）。宣言方式はその両方を避けるために入った。

# 中項目の数え方と表記

中項目に数えるのは、独立した手順見出しと手順リスト。手順の説明文・コマンド例・通知名・結果の列挙は詳細として数えない。

**必ずどれか1つだけが通る排他分岐は数えない。** 分岐全体で1中項目とし、分岐先は詳細にする（工程6の承認／差し戻し）。通らなかった分岐は抜けではないため、番号を振ると穴が「飛ばした」のか「そもそも通らない」のか読めなくなる。

**中項目見出しにも大項目と同じく【必須】／【任意】を明記する。** 番号は人間が正本を読まずに走行を監査する住所であり、穴が正当かどうかの判断は必須／任意の表記に依存する。任意の項目から番号を外して穴自体を消すのも不可。

実障害: 排他分岐だった工程6を `6-[1/2]` と名乗って工程7へ移り、`6-[2/2]` を飛ばしたように見えた。同じセッションで任意項目を名乗らず飛ばし、後続項目だけを名乗ったため、それ以前も飛ばしたように見えた（人間の指摘）。
