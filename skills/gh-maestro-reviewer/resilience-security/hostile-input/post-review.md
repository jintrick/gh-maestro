# Resilience & Security / Hostile Input — 事後確認表

## 重点

- スタックトレースやsecretの露出
- SQL/Shell/HTML injection、path traversal
- 認証バイパス、認可漏れ、認可境界、他ユーザーデータへの影響
- 危険なデシリアライゼーション、`eval`, `new Function`
- リソース枯渇攻撃(DoS)
- 設定・引数経由での安全機構の無効化
