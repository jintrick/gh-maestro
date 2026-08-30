---
paths:
  - "skills/gh-maestro-orchestrator/SKILL.md"
  - "tests/orchestrator-step-numbering.test.js"
---

# 工程の構造宣言を更新する

`skills/gh-maestro-orchestrator/SKILL.md` には構造宣言のコメントがある。文書冒頭に `<!-- gh-maestro-structure: stages=13 -->`、各工程見出しの直下に `<!-- gh-maestro-structure: middle-items=N -->`。

工程や中項目を増減したら、同じ変更の中で数字も更新する。

`tests/orchestrator-step-numbering.test.js` がこの宣言を読み、同じファイルの見出しを数えて突き合わせる。数字が合わなければ落ちる。

**テストが落ちたとき、宣言の数字を実体に合わせて辻褄を合わせない。** 工程を意図して増減したのなら宣言を更新する。意図していないなら、消えた工程の方を戻す。宣言は工程の欠落を検出するためにあるので、実体に合わせて書き換えれば検出そのものが無効になる。

実障害: PR #420 以前のテストは工程名と中項目の一覧を期待値として直接持っており、正当な文書編集で落ちた。焼き込みをやめた結果、今度は工程を丸ごと削除しても通るようになった（Review Manager 指摘 MAJOR 2件、Issue #419）。宣言方式はその両方を避けるために入っている。
