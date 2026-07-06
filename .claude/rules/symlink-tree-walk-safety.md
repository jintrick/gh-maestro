---
paths:
  - "scripts/**"
---

# ファイルツリーの再帰処理は lstat を使う

ファイルツリーを再帰的に走査・比較・削除するコードは `fs.statSync` ではなく `fs.lstatSync` を使い、シンボリックリンク/junctionを追従しないこと。

- 実障害: `scripts/install.js` の `pruneStaleRecursive` が `fs.statSync` を使っていたため、`destChild` が別ディレクトリへのシンボリックリンクの場合にリンク先が解決されて `isDirectory()` が `true` になり、再帰的なpruneがリンク先ディレクトリの中身を意図せず削除する危険があった（PR #44 レビュー指摘）。
- 本プロジェクトは worktree の `node_modules` を junction でリンクする設計（`scripts/unlink-junctions.js` 等）を他所でも使っており、再帰的なファイルツリー操作全般に共通するリスクである。
- 副次的な注意点: `srcChild`/`destChild` でファイル/ディレクトリの型が食い違う場合（旧バージョンではファイル、新バージョンではディレクトリ等）、単純な存在比較では型不一致を見落として stale なエントリが残留する。型が一致しない場合は削除してから再作成する（in-place コピーではなくアトミックな置き換え）。
