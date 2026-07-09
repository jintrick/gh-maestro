---
paths:
  - "scripts/config.js"
---

# skillAgentMap 検証ロジックの重複に注意

`skillAgentMap`（トップレベル・profiles・cmdUse/cmdStatus/validateConfig）に対する「既知キーかどうか」の判定ロジックは、複数関数にほぼ同じ形で存在する。ガードを一箇所にまとめず複製すると、2種類のガード漏れが起きうる。

- 実障害1（既存の正しいパターンからの複製漏れ）: `validateConfig` にはあった `!Array.isArray()` ガードが `cmdStatus` の同種チェックには実装されておらず、`skillAgentMap` が配列だと `Object.keys()` が返す数値インデックス文字列（`'0'`,`'1'`...）を未知キーとして誤警告していた（PR #77 Review Manager指摘）。
- 実障害2（原本自体に無かったガードの踏襲）: `Object.keys(defaults.skillAgentMap)` は元々どの呼び出し箇所にも undefined/null ガードが無く、新規コードで呼び出し箇所が増えたことで `TypeError` のリスクが顕在化した（同PR指摘）。
- 対策: 「既知スキルキーかどうか」を判定するロジックを追加・変更する際は、既存の呼び出し箇所（cmdUse / cmdStatus / validateConfig）すべてに同じガード（`!Array.isArray()`、`defaults.skillAgentMap` の undefined/null チェック）が揃っているか横並びで確認する。新規に増やすなら、コピーではなく共通ヘルパーへの抽出を検討する。
