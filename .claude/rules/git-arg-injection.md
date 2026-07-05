---
paths:
  - "scripts/**"
---

# git コマンドへのユーザー由来値と引数注入

スクリプトから git を実行し、ユーザー由来の値（ブランチ名・`description` 等）を operand として渡すときは、`--` セパレータで options / operands を分離する。`-` 始まりの値は git に**オプションとして解釈**され、引数注入・誤動作の原因になる。

- 実障害: `git fetch origin <branch>` で branch が `-` 始まりだと git がオプション扱いした（PR #39）。
- 対策: `git fetch origin -- <branch>`、`git branch -D -- <name>` のように、ユーザー由来 operand の**前に `--`** を置く。または値を検証する。
- これは shell 注入対策（`execFile` / `spawnSync` 化）とは**別の脆弱性**。両方必要。
