---
name: audit-worker-skills
description: ワーカースキル定義（SKILL.md）と実装コード全体の整合性を検証する。スクリプト変更後にSKILL.mdが陳腐化していないか監査する。
disable-model-invocation: true
allowed-tools: Read Agent
---

# ワーカースキル整合性監査

スキルとスクリプト実装の乖離を検出します。以下の3フェーズで実行してください。

## Phase 1: コントラクト抽出

以下のファイルを読み、ワーカー起動時にシステムが**保証する**事項を網羅的に抽出してください：

- `scripts/spawn-worker.js` — ワーカー起動フロー全体
- `scripts/link-node-modules.js` — node_modules自動リンクの動作
- `scripts/poll-and-notify.js` — coderへの自動ポーリング動作
- `scripts/install.js` — エージェント設定（agents.json）の初期値と更新ロジック

抽出すべき内容:
- ワーカーに渡される環境変数（WORKER_NAME / REPO / WORKSPACE / WORKTREE / ISSUE / BASE_BRANCH など）
- 自動実行される前処理（git worktree作成 / node_modules junction / AGENTS.md書き出し / poll-and-notifyデタッチなど）
- エージェント種別ごとのプロンプト配信方法（--append-system-prompt-file vs send-text injection）
- ワーカーが**手動でやる必要がなくなった**操作（自動化により不要になったもの）

これを「コントラクト」として把握したうえで Phase 2 に進んでください。

## Phase 2: 並列スキル検証

以下4スキルに対して、**Agent ツールで並列に**サブエージェントを起動してください。
各サブエージェントには Phase 1 で把握したコントラクトの全文を埋め込んで渡すこと。

対象:
- `skills/gh-maestro-coder/SKILL.md`
- `skills/gh-maestro-investigator/SKILL.md`
- `skills/gh-maestro-explorer/SKILL.md`
- `skills/gh-maestro-orchestrator/SKILL.md`

各サブエージェントへの指示テンプレート（コントラクトを埋め込んで使うこと）:

```
あなたはスキル整合性検証エージェントです。以下のシステムコントラクトと指定スキルを比較し、不整合を報告してください。

## 現在のシステムコントラクト
[Phase 1で抽出したコントラクト全文をここに貼る]

## 検証対象
[対象 SKILL.md のパス] を Read ツールで読んでください。

## 報告フォーマット
以下の3カテゴリで簡潔に報告してください。問題なければ「整合性OK」とだけ書いてください。

CONTRADICTION（矛盾）: コントラクトと相反する記述
STALE（陳腐化）: 自動化済みなのに手動手順として残っている記述
MISSING（欠落）: コントラクトが提供しているのにスキルが一切言及していない重要情報
```

## Phase 3: 統合レポート

以下の形式で出力してください:

```
## ワーカースキル整合性監査レポート

### ❌ CONTRADICTION（矛盾）
- **スキル名**: 「引用」
  → コントラクト上の実際: ...

### ⚠️ STALE（陳腐化）
- **スキル名**: 「引用」
  → spawn-worker.js L** で自動化済み

### ℹ️ MISSING（欠落）
- **スキル名**: 欠落している情報

### ✅ 整合性OK
- スキル名（問題なし）
```

問題が見つかった場合は、修正対象ファイルと修正方針を最後に箇条書きで示してください。
