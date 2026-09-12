---
paths:
  - "scripts/create-adr.js"
  - "tests/create-adr.test.js"
---

# ADRの作成は参照行の書き込みまで行う

参照行の欠落を検査して拒否するだけで終えない。規範文書への参照行の書き込みを、ADR作成と同じ操作に含める。

呼び出し側に規範文書を手で編集させる前提の経路を残さない。

理由と経緯: docs/adr/0039-adr-creation-writes-the-normative-reference.md
