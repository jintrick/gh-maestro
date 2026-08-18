# council（複数モデル議論）（参照専用）

このファイルは `SKILL.md` の「council（複数モデル議論）」から参照される。**人間から議題を提示され、council を実行するときにだけ開く。** 基本フロー（Issue確定→実装→レビュー→マージ→反省会）には一切登場しない独立機能である。

人間が提示した一つの議題に対し、事前設定した複数の参加モデルが GitHub Discussions 上で独立した意見を投稿し、参加できたモデル同士が投票する機能。意見・投票結果は Discussion のコメント群として人間が参照できる。**LLM 進行役を持たない**——実行は決定論的フェーズ機械 `run-council.js` が行い、orchestrator は進行判断・再試行・集計・要約に LLM 判断を挟まない。

**council は「決める」ためではない。** 投票結果を実装の決定根拠に使うか、どう使うかは人間の判断に属する。`run-council.js` は意見・投票の収集とテンプレート要約の投稿までを担当し、投票結果から何を実装するかの決定はスコープ外（行わない）。

## orchestrator の責務

council における orchestrator の仕事は以下で完結する。**意見/投票フェーズの進行・再試行・欠席扱い・投票集計・要約生成・Discussion 投稿・worktree 管理はすべて `run-council.js` が行う。**

1. **議題の提示**: 人間から議題（タイトル＋本文）を受け取り、`--body-file` に書き出す
2. **調査要否判断**: 議論前に事実調査が必要か判断する。必要なら `run-council-investigation.js` を起動する（**要否判断と起動まで**。調査結果の投稿・意見フェーズへの埋め込みは `run-council.js` が自動検知で行う）
3. **グループ選択**: 参加グループ（`council.groups` のキー）を選択して `run-council.js` を起動する
4. Discussion URL を人間に提示する

## 設定（`config.json` の `council` セクション）

```jsonc
{
  "council": {
    "groups": {
      "default": { "agents": ["claude", "codex", "reasonix"] },
      "architecture": { "agents": ["claude", "claude-ds"] }
    },
    "investigationAgent": "claude"
  }
}
```

- `groups`: 参加グループの定義。**`default` キーが必須**（未定義・不正は fail-closed）。各グループは `agents`（解決可能なエージェントIDの配列）を持ち、`category` で Discussion カテゴリ名を指定できる（省略時は自動選択）。`--group` 省略時は `default` が使われる
- `investigationAgent`: 調査ジョブに使うエージェントID（省略可）。指定する場合、解決不能なら fail-closed

## run-council.js（議事実行）

```
Usage: node "{{SCRIPTS_PATH}}/run-council.js" [--session <id>] [--group <group>] --title <text> --body-file <agenda.md>
             [--context-file <ctx.md>] [--workspace <WS>] [--resume]
```

- `--title` / `--body-file`: 必須。Discussion のタイトル・本文（議題）になる
- `--session`: **新規時は省略可。** `run-council.js` が `--title` から ASCII スラッグを自動生成する（例: `"RAG構成の採用可否"` → `rag-architecture-discussion`）。既存 state と衝突する場合は `-2`/`-3`... を機械的に付与する。**`--resume` でのみ必須**（再開対象のセッションを一意に特定するため）
- `--group`: 参加グループ（`council.groups` のキー）。省略時 `default`
- `--context-file`: 追加の補足コンテクスト（任意。調査結果とともに `context_appendix` に併記され、Discussion にも投稿される）
- `--resume`: 途中停止後の再開。`--session` 必須。state から進行状況を復元し、完了済みフェーズ・欠席扱い済み参加者は再実行しない（冪等）。完走済みなら即 exit 0

**Discussion が正本の識別子であり、GitHub Issue への依存は一切ない**（`--issue` は存在しない）。ローカル成果物は `<workspace>/.gh-maestro/` 配下に作られる（すべてセッションIDで名前空間化される）:
- state: `council-<session>.json`
- 議論用worktree: `council-wt-<session>/`（参加モデルのジョブの cwd。完走・停止の両方で片付けられる）
- 調査結果（任意）: `council-<session>.investigation.json`

**実行フロー:** 事前確認（Discussions有効・カテゴリ・参加モデルのトークン検証。失敗は fail-closed）→ 議論用worktree 確保 → Discussion 作成 → **調査結果ファイル `council-<session>.investigation.json` が存在すれば、その `{findings, sources}` を Discussion 作成直後の初回コメントとして投稿し、同じ内容を意見フェーズの `context_appendix` へ全文埋め込む**（Discussion が調査結果の SSOT。**orchestrator は結果を要約・再編纂してはいけない**）→ 意見フェーズ（参加モデルをヘッドレス起動。失敗は参加者ごとに最大2回再試行、再試行後も失敗は欠席扱い）→ 投票フェーズ（意見フェーズで成功した参加者のみが対象。全意見を読んで投票）→ 投票集計・**テンプレート生成の要約投稿**（欠席者を必ず明記。LLM意味要約なし）→ worktree 片付け

**終了コード:**

| コード | 意味 |
|---|---|
| 0 | 完了（少なくとも1名成功で全フェーズ完走・要約投稿済み・worktree片付け済み） |
| 1 | usage エラー |
| 2 | 事前確認・config 不正（fail-closed。GitHub への書き込みなし） |
| 3 | フェーズ停止（そのフェーズで1名も成功せず全滅。state に永続化済み） |

**停止時エスカレーション:** exit 3 は「そのフェーズで1名も成功しなかった」ことを意味し、失敗理由が state に永続化される。これは自動再実行されない。orchestrator は Discussion URL と失敗理由を人間に伝え、`--resume` で再開するか人間と判断する。完走・停止のどちらでも worktree は片付け済みである（片付け失敗時のみ `COUNCIL_WT_REMOVED_FAILED` が出て exit 3 になり、手動片付けを促す）。

## run-council-investigation.js（調査ジョブ）

**調査は「必要と判断した場合のみ」起動する使い捨てジョブ。** orchestrator の責務は**要否判断と起動まで**であり、調査結果の投稿・埋め込みは行わない。

```
Usage: node "{{SCRIPTS_PATH}}/run-council-investigation.js" [--session <id>] --title <text> --agenda-file <agenda.md>
             [--question <text>] [--workspace <WS>]
```

- `--title`: 必須。セッションID自動生成の入力が `run-council.js` と同じ `resolveSession` を使うため、**`run-council.js` と同じ `--title` を渡せば同じセッションID・worktree・investigation.json パスが機械的に一致する**
- `--agenda-file`: 必須。議題本文（Markdown）
- `--question`: 任意。調査の着眼点（議題への追加の問い）

`council.investigationAgent` が議論用worktree を cwd として調査し、stdout の `{findings, sources}` を `council-<session>.investigation.json` に書き出す（終了コード 0）。**このファイルを `run-council.js` が自動検知し、Discussion 初回コメント投稿と `context_appendix` 全文埋め込みを行う**ため、orchestrator が結果を読んで要約・再編纂してはならない（Discussion が調査結果の SSOT）。終了コード: 0=調査成功（結果書き出し済み）/ 1=usage / 2=事前確認・config 不正（fail-closed。調査ジョブを起動しない）
