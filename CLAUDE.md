# gh-maestro

GitHubを永続ストアとして複数のAIエージェントを協調動作させるシステム。

## 設計思想: Quota経済

gh-maestro の最も重要な価値は **Quota経済を回すこと** である。

生成AIの開発ワークフローにおいて、すべての判断を最高級モデルに任せるのは経済的に破綻する。一方、安価なモデルだけでは複雑な設計判断や人間との協働が成立しない。

このシステムは、**タスクの性質によってモデルを使い分ける**ことでこの矛盾を解決する：

| 役割 | 要求される能力 | モデル特性 |
|---|---|---|---|
| オーケストレーター | 設計判断・要件整理・リスク評価・人間との協働・レビューコメントのトリアージ | **高価で賢い**（Opus / Pro High） |
| コーダー | 指示された実装の遂行 | 中程度（Sonnet / Pro Low） |
| インベスティゲーター | 調査・grep・ログ解析 | 安価で高速（Flash / Haiku） |

レビューは GitHub Code Assist が提供する（gh-maestro のトークンを消費しない）。オーケストレーターは Code Assist の指摘をトリアージし、「ありえないエッジケース」をフィルターし、命名異常や実害のある指摘のみをコーダーにフィードバックする。この判断に高価なモデルを使うことにQuota経済的な正当性がある。

高価なモデルのトークン消費を「判断が必要な瞬間」だけに抑え、量をこなす実行フェーズは安価なモデルに振り分ける。これにより、**高速かつ低コスト**に開発サイクル全体を回すことが gh-maestro の存在意義である。

この思想はアーキテクチャのすべてに影響する：
- オーケストレーターがコードを書かないのは、高価なトークンを実装に消費させないため
- ワーカーが判断せず指示に従うのは、判断という高コスト操作をオーケストレーターに集約するため
- オーケストレーターが人間と協働して Issue を起草するのは、最も高コストな「要件の曖昧さ解消」を人間の知性と高価モデルの組み合わせで一発で決着させるため

モデル選択の実装は Antigravity のモデルラインナップ（Gemini Flash / Pro / Claude Opus / Sonnet）とサブエージェント機構（`invoke_subagent` / `define_subagent`）を活用する。

## git操作のルール

- ファイル変更が承認されたら、その場でコミット・pushまで完結させる。別途指示されるまで待たない
- `git reset --hard` は実行前に必ずユーザーに確認を取ること。無断実行禁止
- pushがnon-fast-forwardで失敗した場合は `git reset --hard` を使わず、状況をユーザーに報告して方針を確認する

## エージェント動作のテストルール

エージェントのCLI起動方法（フラグ・サブコマンド・引数の組み合わせ）を変更・追加したとき、
**コミット前に実際にそのコマンドを実行して動作を確認すること。**

- `reasonix run "hello"` のような最小の動作確認コマンドを手で打って exit 0 を確認する
- `--help` でフラグ一覧を確認するだけでは不十分。実際に動かせ

## スキル編集のルール

スキルファイルは必ずリポジトリ（`skills/`）を編集すること。
`~/.claude/skills/` や `~/.gemini/antigravity/skills/` はインストール先であり、直接編集しない。
編集後は `node scripts/install.js` を実行して反映する。

## スキルとスクリプトの整合性ルール

`scripts/spawn-worker.js` または `scripts/link-node-modules.js` のワーカー起動挙動を変更したとき、
**コミット前に `/audit-worker-skills` を実行して SKILL.md との整合性を確認すること。**

- 自動化した手順がスキルに手動手順として残っていないか
- 新しく提供する環境変数がスキルに記載されているか
- 廃止した動作がスキルに参照されていないか

このスキルは `.claude/skills/audit-worker-skills/SKILL.md` に定義されている（プロジェクトローカル）。

## `.claude/rules/` について

`.claude/rules/*.md` はパス別のルールファイル。コンテキストを消費するため**簡潔に書くこと**。

- `paths` frontmatter なし → 毎セッション強制ロード（CLAUDE.md と同等のコスト）
- `paths` frontmatter あり → 該当パターンのファイルを開いた時のみロード（path-scoped）
- 200行超えると adherence が下がる。詳細は `docs/rag/claude-code/guide/claude_code_memory_guide.md` 参照

## agy の `.agents/rules/` について

`.agents/rules/*.md` はプロジェクトルートに置くワークスペースルールファイル。
**エージェントの行動制約（何を実行してよいか）を定義するもの**であり、CLAUDE.md のようなプロジェクト指示書ではない。

- YAML frontmatter でトリガー種別（`glob` / `always_on` / `manual` / `model_decision`）を指定する
- autonomy レベルを `strict` にすると最大限に適用される
- ファイルシステムアクセス・ツール実行・ブラウザ操作などの許可／禁止を記述するもの

**`AGENTS.md` は agy がデフォルトで読むファイルではない。** agy にはプロジェクト指示書の自動ロード機能がない（`.agents/rules/` はあくまで制約定義）。Claude Code 側は `CLAUDE.md` に `@AGENTS.md` と書くことでインポートできる（`docs/rag/claude-code/guide/guide/claude_code_memory_guide.md` 参照）。

## エージェントCLI

- **claude (Claude Code CLI)**: ドキュメント → `docs/rag/claude-code/`
- **agy (Antigravity CLI)**: ドキュメント → `docs/rag/antigravity/`
- **WezTerm**: ドキュメント → `docs/rag/wezterm/`

## RAGドキュメントの必須参照ルール

各CLIのファイルパス・設定・コマンド・インストール先・動作仕様について実装・変更・回答する前に、
必ず対応する `docs/rag/` のドキュメントを読んで根拠を確認すること。
**推測・類推・訓練データの知識で実装してはならない。**

| 対象 | 参照先 |
|---|---|
| agy のパス・スキル・設定・コマンド | `docs/rag/antigravity/` |
| claude / Claude Code のパス・設定・コマンド | `docs/rag/claude-code/` |
| WezTerm のパス・設定・コマンド | `docs/rag/wezterm/` |
