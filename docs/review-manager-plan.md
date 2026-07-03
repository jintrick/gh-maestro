# Review Manager 体制 計画書

策定日: 2026-07-03
ステータス: 設計合意済み・未実装

## 背景

現行のPRレビューは`run-review.js`が単一エージェント(claude-ds)をヘッドレスspawnし、
`scripts/review-prompt.md`に従って Correctness / Maintainability / Resilience & Security の
3観点を**同一セッション内で逐次**検証する構成。以下の課題がある。

- PR情報・diff・既存レビューの取得は1回だが、3観点は同一コンテキスト内で処理するため
  観点間の汚染(後の観点が前の指摘に引きずられる)リスクがある
- ターン予算(50ターン)を3観点で分け合うため、後半の観点が息切れしやすい
- 単一エージェントが「指摘」と「投稿」と「最終判定」を全部担っており、責務が分離されていない

本計画は、Review Manager(RM)が3体のReviewerサブエージェントを並列に立てて観点ごとに
分離しつつ、findingの集約・投稿・最終提出をRMに一元化する体制への移行を定義する。

## 全体構成

```
wezterm
├─ Orchestrator (人間と協働、採否判断)
└─ Review Manager = Codex CLI
   ├─ PR情報取得
   ├─ diff取得
   ├─ 既存レビュー取得
   ├─ 3レビュワーへ同一コンテキスト配布(並列spawn)
   ├─ finding集約
   ├─ 重複統合
   ├─ line_anchor → 行番号の解決
   ├─ GitHubインラインコメント投稿
   └─ 最終レビュー提出(機械的event判定)

Correctness Reviewer / Maintainability Reviewer / Resilience & Security Reviewer
```

## 責務分離

| 役割 | やること | やらないこと |
|---|---|---|
| **Reviewer** ×3 | 担当観点でコードを検証し、findingを多めに返す。diffが参照する外部シンボル・型・設定は自分で実ファイルを確認する | 採否判断・優先度判断・投稿・severity付与 |
| **Review Manager** | PR情報・diff・既存レビューの収集、Reviewer起動、finding集約、重複統合、line_anchor解決、投稿 | トリアージ(採用/却下の判断)、外部定義の事前収集(Reviewerが必要に応じて自分で行う) |
| **Orchestrator + 人間** | 採用・却下・保留・追加調査・修正指示を決める | — |

## RMの実行主体

RMは`gh-maestro-reviewer`スキルとして`spawn-worker.js`経由で起動する
(現行`run-review.js`のヘッドレスspawn方式の後継)。**RMはCodex CLI**を使う。

Reviewer3体は、RMが自分のCLIのネイティブなサブエージェント機構で並列spawnする。
CLI固有のツール呼び出し構文はスキルの指示書に書かない — 「3観点それぞれについて
独立したサブエージェントを並列に立てて検証させよ」という自然言語の指示だけで、
claude code(`Agent`ツール)・codex(自律スポーン/`.codex/agents/*.toml`)いずれでも
各CLIが自分のネイティブな委任機構を使って解釈する。モデル差別化(RM=高価、
Reviewer=中〜安価)も同様に自然言語のヒントとして伝え、強制はしない。

### 検討の結果、不採用にした案

- **agy の `invoke_subagent`**: 親と同じモデルでしか起動できない仕様がQuota経済(RM=高価、
  Reviewer=中価)の設計思想と衝突するため、Reviewer側の実行CLIとしては不採用
- **workers.json 登録・WezTermペイン分割方式**: 現行の単一レビュアーもこの方式を使っていない
  (`run-review.js`はヘッドレスspawn)。RM配下のReviewer3体も同様にworkers.json管理の外に置く

## 判定基準の伝達

各観点の判定基準(現行`review-prompt.md`の「観点1〜3」セクション相当、150行前後)は
`gh-maestro-reviewer`スキルのアセットとして3ファイルに分割する。

- `reviewer-correctness.md`
- `reviewer-maintainability.md`
- `reviewer-resilience-security.md`

RMはReviewer起動時に「PR固有のコンテキスト(diff等)」のみをプロンプトに含め、
判定基準は「`<path>/reviewer-<aspect>.md`を読め」とファイルパス参照で伝える。
RM自身が150行×3のチェックリストを自分のコンテキストに保持する必要がない。

### 外部定義・設定の収集はRMが抱え込まない

diffが参照するが定義がdiff内にない型・シンボル・設定値(`package.json`のフィールド、
外部インターフェース、既存関数のシグネチャ等)は、RMが事前に集めてReviewerへ配らない。
**各Reviewerが必要になった時点で自分でリポジトリを読んで確認する**(現行
`review-prompt.md`の「外部参照の解決」節と同じ方針)。理由:

- どの外部定義が必要かは観点によって異なり、RMが3観点分を予測して事前収集するのは無駄が多い
- Reviewerは自分のworktree/workspaceに読み取りアクセスを持つので、都度確認するコストは低い
- RMのコンテキストを「PR差分そのもの」に絞れる

3ファイルの判定基準(`reviewer-<aspect>.md`)には、それぞれ「diffが参照する外部シンボル・型・
設定は判定前に実ファイルで裏取りせよ」という指示を含める。

## サブエージェント機構が使えない場合のフォールバック

RMのCLI(codex / claude code等)がネイティブなサブエージェント機構を持たない、または
何らかの理由で使えない場合、RMは以下にフォールバックする。

- **並列spawn**: `invoke_subagent`/`Agent`ツール/自律スポーンの代わりに、現行`run-review.js`と
  同じ方式(`spawnSync`によるヘッドレスCLIプロセスの個別起動)を観点数(3)ぶん並列実行する
- **finding受け渡し**: 各Reviewerプロセスは構造化findingを`.gh-maestro/review-<PR>-<aspect>.json`
  に書き出し、RMはプロセス終了後にこれらを読み込んで以降のパイプライン(集約・重複統合・
  line_anchor解決・投稿)に渡す。パイプライン自体のロジックはサブエージェント方式と共通
- **差し戻し**: フォールバック方式では同一スレッドへの追加メッセージ送信ができないため、
  差し戻しは「該当Reviewerプロセスを`ambiguous_anchor`/`unresolved_anchor`の内容込みで
  再spawnし、1回だけやり直させる」という形に読み替える(最大1回のルールは変わらない)

どちらの方式でも、Reviewerが返すfindingのデータ構造・RMの集約ロジック・投稿ロジックは
共通であり、変わるのは「Reviewerの起動方法とfindingの受け渡し経路」だけ。

## Reviewerの観点別重点

**Correctness Reviewer**: 不変条件・状態遷移・API契約・後方互換性・データ整合性

**Maintainability Reviewer**: 命名・重複・責務分離・複雑性・テスト品質・lint抑制

**Resilience & Security Reviewer**: 異常系・並行性・タイムアウト・リトライ・
外部依存障害・injection / secret / DoS

## finding のデータ構造

Reviewerサブエージェントは以下の構造化findingを返す(投稿はしない)。

```json
{
  "aspect": "Correctness",
  "path": "src/foo.ts",
  "line_anchor": "await saveUser(user)",
  "context_before": "if (!user.id) throw new Error('missing id')",
  "context_after": "return user",
  "summary": "...",
  "observed_fact": "...",
  "invariant": "...",
  "failure_scenario": "...",
  "minimal_fix": "...",
  "verified_references": [
    "src/foo.ts",
    "src/userRepository.ts"
  ]
}
```

- `line_anchor`: HEAD実ファイルに存在する**連続したコード断片そのもの**。
  要約・言い換え・説明文は禁止
- `context_before` / `context_after`(任意): `line_anchor`の直前・直後に実際に存在する行。
  `line_anchor`が同一ファイル内で複数箇所に一致する場合の絞り込みに使う。省略可
- `verified_references`: 主用途は監査ログ(実際に確認したファイル・シンボルの記録、
  根拠不足finding検出、重複統合の補助材料)。重複統合の主判定には使わない

## line_anchor の解決

RMは投稿直前に`git show <HEAD commit>:<path>`の中で`line_anchor`を突き合わせ、
実際の行番号(`resolved_line`)を確定する。

1. `line_anchor`だけで1件に一致すれば、それを採用する
2. 複数件に一致し、かつ`context_before`/`context_after`が付与されていれば、
   前後行との一致でさらに絞り込む(絞り込んだ結果1件になれば採用)
3. それでも複数件・0件のままなら、下表の通り差し戻す

| 一致件数(絞り込み後) | 挙動 |
|---|---|
| 1件 | インラインコメントとして投稿 |
| 複数件 | 投稿しない。`ambiguous_anchor`として元のReviewerスレッドに差し戻す |
| 0件 | 投稿しない。`unresolved_anchor`として元のReviewerスレッドに差し戻す |

**差し戻しのルール**:
- 新しいReviewerを立て直さない。**同じサブエージェントスレッド**に追加メッセージを送り、
  既存コンテキストのまま再開させる(claude codeのidle再起動 / codexの`/agent`スレッド継続)
- finding単位で**最大1回**のみ
- 1回で解決しなければ`ambiguous_anchor`/`unresolved_anchor`として確定し、inline投稿しない
- RMは推測でanchorを補正しない。無制限リトライは禁止

解決できなかったfindingは、最終レビュー本文に「位置未解決finding」として隔離して記載する。

## 重複統合

主判定材料: `aspect` / `path` / `resolved_line`(or `line_anchor`) / `invariant` / `failure_scenario`

- `aspect`が違っても`observed_fact` / `invariant` / `failure_scenario` / `minimal_fix`が
  実質同一なら1件に統合し、aspectラベルを併記する(例: `[Correctness][Resilience & Security]`)
- `path`・`resolved_line`が同じでも、`invariant` / `failure_scenario`が異なる別懸念なら
  統合せず別々に投稿してよい

## 最終レビューevent: 運用ポリシー

**`event`は常に`COMMENT`固定とし、`APPROVE`は使わない。**

`APPROVE`はGitHub上「このPRは問題ない」という判断シグナルであり、RMが「採否判断しない」
という設計原則(責務分離の節を参照)と矛盾する。findingが0件だったとしても、それは
「3つの機械的な観点チェックで指摘が出なかった」ことを意味するだけで、「マージしてよい」
ことを保証しない — RMは要件充足・設計妥当性・ビジネスロジックの適否を判定していない。

そのためRMの最終レビュー本文は、findingの有無にかかわらず`event=COMMENT`で提出し、
本文に「投稿したfinding件数」「位置未解決findingの一覧」「(0件なら)3観点とも機械的な
指摘なし」を明記するに留める。PRのAPPROVE状態は、Orchestrator + 人間が別途
(gh-maestroの通常フローとして)判断して出す。

将来的に運用実績が積み上がり、「findingゼロなら人間のレビュー負荷を下げるためAPPROVEを
使いたい」という要望が出た場合は、本ポリシーを別途改定する。現時点ではCOMMENT固定とする。

## 未実装項目(次フェーズ)

- `gh-maestro-reviewer`スキルの新規作成(現行`fa86528`で削除された旧reviewer skillの復活ではなく、
  本計画に基づく再設計)
- `review-prompt.md`の3ファイル分割
- `run-review.js`のRM起動方式への置き換え(`poll-pr.js`からの呼び出し変更を含む)
- RM用のfinding集約・line_anchor解決・重複統合ロジックの実装(RMへの指示書として自然言語で記述するか、
  スクリプトとして決定的に実装するかは別途検討)
- 差し戻し(スレッド再開)の具体的な実装方法をclaude code / codexそれぞれで検証
