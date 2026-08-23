---
paths:
  - "scripts/**"
---

# GitHub Issue/PR コメント一覧取得は共有ヘルパーを使う

`gh api .../comments --paginate --slurp` で Issue や PR のコメント一覧を全ページ取得し、応答を平坦化する処理は、プロジェクト内の複数スクリプトが独立に実装していた重複パターンである（Issue #183）。以下に統合済み。

- **共有モジュール**: `scripts/shared/gh-comments.js` — `listComments(repo, issue, opts)` で REST API経由の全件取得を実行し、`parseCommentsResponse(stdout)` で応答のJSONを平坦化する。
- `listComments` は `since` と `per_page` をオプション引数として受け付ける。指定した呼び出し元だけが差分取得・ページサイズ指定を行える。
- 各呼び出し元は、このモジュールの戻り値に基づいて独自のエラーハンドリング（GraphQLフォールバック・エラー時continue等）を実装する。共通ヘルパーはビジネスロジックを持たない。

対策: 新規に `gh api .../comments --paginate --slurp` を呼び出してコメント一覧を取得するコードを書く際は、`scripts/shared/gh-comments.js` の `listComments` を使う。**自前で `spawnSync('gh', ['api', ...'--paginate'...])` を組み立てない。** 応答の平坦化も `parseCommentsResponse` を使い、自前で `JSON.parse` + `Array.isArray` の分岐を書かない。

経緯: プロジェクト内の5ファイル（`worker-supervisor.js`・`msg-poll.js`・`publish-plan.js`・`assistant-watch.js`・`worker-exit-hook.js`）がそれぞれ同等の `_ghApiComments` / `_ghListComments` / `_ghIssueComments` 関数を持ち、うち3ファイルが `parseCommentsResponse` と同名の同一実装を独立に持っていた（Issue #183 で一掃）。
