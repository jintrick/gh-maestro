---
paths:
  - "scripts/config.js"
---

# skillAgentMap 検証ロジックの重複に注意

`skillAgentMap`（トップレベル・profiles）に対する「既知キーかどうか」の判定は、`cmdUse` と `validateConfig` で行う。

- どちらの箇所でも、`skillAgentMap` と `profiles` がプレーンオブジェクトの場合だけキーを列挙する。
- 既知スキルキーを求めるときは、`defaults.skillAgentMap` が無い場合も安全に扱う。新しい呼び出し箇所を増やす場合は、既存の検証ヘルパーを共有し、同じガードを複製しない。
