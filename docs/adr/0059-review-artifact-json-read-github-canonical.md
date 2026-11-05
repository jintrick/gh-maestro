---
normative-file: skills/gh-maestro-orchestrator/SKILL.md
---

# レビュー結果はJSONから読み、正本はGitHubのPRとし、PRへの掲載を確かめてからJSONを破棄する

## 決めたこと

Review Managerのレビュー結果をorchestratorが読む経路は、ローカルの成果物JSON（`<workspace>/.gh-maestro/records/pr/<PR>/review/manager.json`）から読む1つのコマンドに統一する。ただし正本はGitHubのPRに掲載されたレビューとする。JSONは正本ではなく、Issueのクローズ時に破棄する。破棄してよいのは、その内容がPRに掲載されていることを確かめた場合に限る（Issue #742）。

## なぜ

JSONを手元に残すのは、GitHubが不調のときにレビューの成果物が消えるのを防ぐためである。読むときもJSONの方が速く、通知経路での本文の切り詰めや、GitHub APIの取得失敗の影響を受けない。

一方で、gh-maestroはGitHubを永続的な状態として使う設計であり、レビュー結果の正本がローカルのJSONに移ると、PRに載っていない指摘がJSONにだけ残る状態（投稿失敗など）が見えなくなる。JSONをIssueのクローズで破棄すれば、正本は常にPR側に残る。掲載を確かめずに破棄すると、GitHub不調のときに守るはずだった成果物を失うため、掲載の確認を破棄の条件にする。

## 却下した案

- orchestratorがレビュー本文をGitHub APIから直接読む案。gh-maestroの名前どおりGitHubを正本として読む形で一見自然だが、GitHub不調時に読めず、JSONを残す目的と重複する経路を増やすため採らなかった。
- JSONを正本として扱い、クローズ後も残す案（従来の実態。手順書が manager.json をレビュー完了の目印と再レビューの入力に使っている）。GitHubを状態の正本とする設計と食い違い、PRとJSONの内容のずれを放置するため採らなかった。
