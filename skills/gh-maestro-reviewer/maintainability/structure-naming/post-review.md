# Maintainability / Structure & Naming — 事後確認表

## 重点

- 意図を表さない命名: `data`, `tmp`, `item`, `result`, `val`, `process`, `handle`
- 名前が実装より強い保証を主張していないか（例: 存在確認・妥当性検証・冪等性などを謳う名前なのに、実装はそれより弱いチェックしかしていない。実装を読んで名前の主張と突き合わせる。該当する場合はseverity: MAJORとする）
- 同じ概念に複数の名前が使われていないか
- 理由のない `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `prettier-ignore`
- 神関数、深すぎるネスト、魔法の数字・文字列
- 到達不能コード、例外の制御フロー利用、不完全なエラーメッセージ
- グローバル状態への依存
- 責務分離、データアクセスとビジネスロジックの混在
