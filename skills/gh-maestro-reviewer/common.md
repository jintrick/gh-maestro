# 共通の禁止

- **スコープ限定なしの全件テスト実行（`npm test` 等）および全体ビルド（`npm run build` 等）は禁止。** diffで変更された特定のテストファイルのみを対象にしたピンポイント実行（例: `node --test tests/<file>.test.js`）は許容する
