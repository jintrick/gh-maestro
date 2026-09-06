---
paths:
  - "scripts/gh-maestro-setup.js"
  - "scripts/install.js"
  - "scripts/push-and-declare.js"
  - "scripts/remove-worker.js"
  - "scripts/review-publisher.js"
  - "scripts/run-review-manager.js"
  - "scripts/spawn-worker.js"
  - "scripts/shared/child-process.js"
  - "scripts/shared/council-worktree.js"
  - "scripts/shared/git-branch.js"
  - "scripts/shared/git-head.js"
  - "scripts/shared/git-worktree.js"
  - "scripts/shared/test-content.js"
---

# git コマンドへのユーザー由来値と引数注入

スクリプトから git を実行し、ユーザー由来の値（ブランチ名・`description` 等）を operand として渡すときは、`--` セパレータで options / operands を分離する。`-` 始まりの値は git に**オプションとして解釈**され、引数注入・誤動作の原因になる。

- 実障害: `git fetch origin <branch>` で branch が `-` 始まりだと git がオプション扱いした（PR #39）。
- 対策: `git fetch origin -- <branch>`、`git branch -D -- <name>` のように、ユーザー由来 operand の**前に `--`** を置く。または値を検証する。
- これは shell 注入対策（`execFile` / `spawnSync` 化）とは**別の脆弱性**。両方必要。
