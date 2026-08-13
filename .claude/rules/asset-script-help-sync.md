---
paths:
  - "scripts/**/*.js"
---

# アセットスクリプト編集時は `--help` を必ず同期させる

`scripts/` 配下のCLIアセットは `--help`/`-h` の記述内容（Usage・Arguments・Options・Output）が、実装の実際の挙動を表す唯一の一次情報として扱われる（orchestrator・ワーカーはSKILL.mdではなくこれを見て使い方を確認する）。フラグの追加・削除・意味変更、引数の必須/任意の変更、出力フォーマットの変更を行うときは、**同じコミットで `--help` のUsage文字列も必ず更新する。** 片方だけ変更してコミットしない。

- 実障害: `view-file.js` は `--help` のUsageに `[--workspace <path>]` を記載していたが、実装は一切そのフラグを読んでおらず完全に無効だった。ヘルプに書かれているのに実装が追随していない・存在しない、という乖離がそのまま放置されていた。
- 実障害: `start-review-manager.js` は独自の手書きargvパーサーを使っており、`--help` の説明文自体は正しく見えても、実装側が `argv.includes('--help')` で生のargv全体を判定していたため、`--brief-file` の値としてたまたま `--help` を渡すと誤ってヘルプ表示で終了してしまっていた。ヘルプ文言と実装が字面上一致していても、パース処理自体の欠陥で挙動が乖離することがある。

編集後は必ず実際に `node <script>.js --help` を実行し、表示内容が今回の変更後の実装と一致しているかを目で確認する（`--help` を書き換えただけで実装を試さない、実装を変えただけで `--help` を確認しないの両方を禁止する）。既存フラグとの衝突判定（値がたまたま既知フラグ文字列と一致する等）が心配なケースは `.claude/rules/argv-parsing-pitfalls.md` の共有パーサー（`scripts/shared/workspace.js::parseFlags` 仕様オブジェクト形式。catch でのヘルプ判定は `hasGenuineHelpRequest`）を使っているか確認する。旧 `hasHelpFlag` は Issue #275 で廃止済み。
