---
normative-file: skills/gh-maestro-orchestrator/SKILL.md
---

# 反省会で承認された対象プロジェクトの .claude/rules/ の変更は、orchestratorが承認後すぐにベースブランチへ直接commit・pushする

## 決めたこと

反省会で人間が承認した、対象プロジェクトの `.claude/rules/` の変更は、軽量PR経路（アンカーIssue・PR・slow層・マージ依頼）に乗せない。承認を得たらすぐ、orchestrator自身がベースブランチへ直接commit・pushする。これは「ベースブランチへ直接commit・pushしない」規範に対する、ADRの追加・改訂と並ぶ2つ目の例外である。例外は判断基準・不変条件・`skills/gh-maestro-orchestrator/lightweight-pr.md`・`skills/gh-maestro-orchestrator/retrospective.md` のすべてに同じ形で書き、どこから読んでも直接commit・pushと読めるようにする。

## なぜ

反省会では、ルールファイルの内容そのものを人間に示して承認を得ている。そのあと軽量PR経路に乗せると、同じ内容に対してマージ依頼という2回目の承認を求めることになる。承認済みの内容に再承認を求めないという規範（`docs/adr/0007-one-question-per-human-message.md`）に反する。

`.claude/rules/` の文書はslow層の検証の対象にならず、`push-and-declare.js` もドキュメントだけの変更にはテスト成果物を求めない。PRに乗せても、検証の面で得るものが無い。

実際に、直接commit禁止の規範が例外にADRだけを挙げていたため、orchestratorは `skills/gh-maestro-orchestrator/retrospective.md` の「承認後に追記する」よりそちらを優先して読んだ。その結果、承認済みの `.claude/rules/` の変更を軽量PR経路に乗せてしまった。

## 却下した案

- 反省会で承認された `.claude/rules/` の変更も、他の変更と同じく軽量PR経路で提出する案。実際にorchestratorがこの読み方で動き、人間が誤りと判断した。上の理由で、得るものが無いまま再承認だけを求めることになるため採らなかった。
