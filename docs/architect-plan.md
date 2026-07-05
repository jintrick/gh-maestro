# gh-maestro Architect 導入計画書

策定日: 2026-07-04
ステータス: 計画
きっかけ: Issue起草前の要求定義・批判的対話・Issue分割の品質を、orchestratorの実行管理責務から分離したい

## 目的

`gh-maestro-architect` を追加し、人間と直接対話して要求を鍛える上流ロールを導入する。

architect は最高品質のモデルを使う前提のため、雑務・状態管理・実装管理はさせない。役割は Issue 化前の要求定義に限定する。

## 問題

現在の `gh-maestro-orchestrator` は、Issue作成・worker起動・PR検出・レビューコメントのトリアージ・反省会までを担う。実行管理ロールとしては妥当だが、Issue起草前の会話では以下の弱さがある。

- 人間の要望に従順になりすぎ、要求そのものを疑いにくい
- 代替案、反論、スコープ削減、Issue分割の提案が弱い
- 「このIssueだけでcoderが設計判断なしに実装できるか」の検査はあるが、その前段の要求形成が薄い
- orchestratorをさらに高性能モデル化すると、実行管理やポーリング判断にも高価なモデルを使うことになり、quota経済に合わない

## 基本方針

architect は orchestrator の配下workerではない。人間と直接対話する独立した上流ロールとする。

```text
Human
  <-> Architect
        |
        | send-pane.js による自然言語のIssue化依頼
        v
      Orchestrator
        |
        v
      GitHub Issue -> Coder -> PR -> Review -> Merge
```

責務境界:

| ロール | 責務 |
|---|---|
| architect | 人間との要求定義対話、反論、代替案提示、スコープ調整、Issue分割、acceptance criteria作成 |
| orchestrator | architectの成果物をIssue草稿へ変換し、人間承認後にIssue作成、worker起動、PR監視、レビューtriage、反省会 |
| explorer / investigator | architectまたはorchestratorが必要と判断した事実調査を実行する |
| coder | 合意済みIssueを実装しPRを作成する |

## 非目標

- architect にGitHub Issueを作らせない
- architect にworkerを起動させない
- architect にPR監視・レビューtriage・merge調整をさせない
- architect を `spawn-worker.js` の通常workerとして扱わない
- architect と orchestrator の通信に固定イベント名プロトコルを作らない
- 人間が architect の成果物を手動で orchestrator に貼り付ける運用にしない

## 通信設計

architect から orchestrator への主通信路は `send-pane.js`（内部的にはファイルシステムキューの enqueue）とする。

固定イベント名は使わない。`ARCHITECT_HANDOFF_READY` のような機械向け識別子は不要。`send-pane.js` は内部的にメッセージを `.gh-maestro/queue/inbox/` へ enqueue し、poller が WezTerm 通知を担当する。本文は自然言語で十分に長く書け、人間にも読める。

architect は、Issue化可能な状態になったら orchestrator に自然言語で依頼する。

```text
アーキテクトからIssue化依頼です。

以下の内容を読み、未解決事項がなければIssue草稿にしてください。
Issue化に必要な不足があれば、私に差し戻してください。

## Problem
...

## Recommended Direction
...

## Scope
...

## Acceptance Criteria
...

## Issue Split
...

## Open Questions
なし
```

大量の成果物や再開性が必要な場合のみ、architect は補助的に handoff file を作成し、そのパスを自然文に含めてよい。

```text
アーキテクトからIssue化依頼です。

handoff: C:\...\ .gh-maestro\architect\handoffs\20260704-auth-refactor.md

このhandoffを読み、未解決事項がなければIssue草稿にしてください。
Issue化に必要な不足があれば、私に差し戻してください。
```

重要: handoff file は耐久ログであり、主プロトコルではない。常時ポーリングは導入しない。

## 差し戻し

orchestrator は architect の依頼を受けたとき、不足があれば人間ではなく architect に `send-pane.js` で差し戻す。

```text
アーキテクトへ差し戻します。

Issue化には以下が不足しています。
- acceptance criteria が動作確認可能な形になっていません
- Issue 2 が大きすぎてcoderに渡す単位として危険です
- scope out が未定義です

人間と再確認して、Issue化依頼を更新してください。
```

要求判断が必要な不足は architect が人間と再対話する。orchestrator は要求定義の議論を引き取らない。

## architect スキル

`skills/gh-maestro-architect/SKILL.md` を追加する。

フロントマター案:

```yaml
---
name: gh-maestro-architect
description: gh-maestroアーキテクト。Issue化前に人間と直接対話し、要求を批判的に整理し、代替案・スコープ・Issue分割・acceptance criteriaを作る。orchestratorに自然言語でIssue化依頼を送る上流ロールとして使う。
---
```

主な指示:

- 人間と直接対話する
- 人間の要求をそのまま肯定しない
- 曖昧さ、矛盾、過剰スコープ、不足情報を指摘する
- 反対意見があれば明確に述べる
- 代替案とトレードオフを出す
- 最終的なIssue候補をcoderが設計判断なしに実装できる粒度へ落とす
- 成果物は自然言語のIssue化依頼としてorchestratorに送る
- GitHub操作、worker起動、PR監視、merge判断をしない
- コード調査やgrepが必要な場合は自分で実行せず、必要な調査依頼をorchestratorに送る

## orchestrator スキル更新

`skills/gh-maestro-orchestrator/SKILL.md` に architect 連携を追加する。

追加する要点:

- architect から自然言語のIssue化依頼を受け取ったら、要求定義をやり直さずIssue草稿化する
- 不足がある場合は人間ではなく architect に差し戻す
- architect の成果物に `Open Questions` が残っている場合は、原則としてIssue化せず architect に戻す
- architect の提案に重大な実行上の問題がある場合だけ、orchestratorとして指摘して差し戻す
- Issue作成前の人間承認は従来通り必要

## 起動導線

architect は通常workerではないため、`spawn-worker.js` ではなく専用起動スクリプトを追加する。

候補: `scripts/start-architect.js`

責務:

- `~/.gh-maestro/agents.json` から architect 用agent設定を読む
- 現在のworkspaceで新しいpaneを開く
- `gh-maestro-architect` スキルを起動プロンプトに含める
- `.gh-maestro/workers.json` に `architect: { paneId, agentId }` を記録する
- orchestratorへ送信する場合は既存の `send-pane.js orchestrator --workspace <path> "<自然文>"` を使わせる

`workers.json` に `architect` を登録する理由は、orchestrator から `send-pane.js architect ...` で差し戻せるようにするためである。

## agent 設定

`scripts/install.js` のデフォルト `agents.json` に architect 用の枠を追加する。

実際の最高モデルCLIは環境依存なので、初期値は保守的にし、ユーザーが `~/.gh-maestro/agents.json` で差し替えられる形にする。

候補:

```json
{
  "id": "architect",
  "label": "Architect",
  "command": "<user-configured>",
  "extraArgs": [],
  "promptDelivery": "system-prompt-file",
  "enterSequence": "\r\n"
}
```

ただし `<user-configured>` のような実行不能デフォルトを入れると起動時に失敗する。実装時は以下のどちらかを選ぶ。

1. 既存の実行可能agentを暫定デフォルトにする
2. `start-architect.js` で architect agent 未設定時に明示エラーを出し、設定例を表示する

最高モデル利用を前提にするなら、2の方が誤起動を避けられる。

## handoff file

handoff file は必須にしない。`send-pane.js` が本文を `.gh-maestro/queue/inbox/` に enqueue するため、通常は自然言語本文だけで十分である。

以下の場合のみ architect が明示的に `.gh-maestro/architect/handoffs/` へMarkdownを書く。

- 成果物が非常に長い
- 複数Issueの分割案を後で参照したい
- architectの対話結果をセッションを跨いで再利用したい
- orchestratorが落ちていて後で再送したい

形式はJSONではなくMarkdownを第一候補にする。人間が読む文書であり、固定プロトコルではないため。

推奨テンプレート:

```md
# Architect Handoff

## Problem

## Recommended Direction

## Rejected Alternatives

## Scope

### In

### Out

## Acceptance Criteria

## Issue Split

## Open Questions

## Orchestrator Notes
```

## 復旧設計

常時ポーリングは導入しない。

復旧は以下で十分とする。

- `send-pane.js` が `.gh-maestro/queue/inbox/` に送信本文を enqueue する
- architect が必要に応じて `.gh-maestro/architect/handoffs/` にMarkdownを残す
- orchestrator 再起動時に未処理handoffを自動探索する機能は初期実装では入れない

将来、セッション復旧要求が増えた場合のみ、`start-architect.js` または orchestrator 起動時に `.gh-maestro/architect/handoffs/` を一覧表示する補助を追加する。

## 実装ステップ

1. `skills/gh-maestro-architect/SKILL.md` を追加する
2. `skills/gh-maestro-orchestrator/SKILL.md` に architect からのIssue化依頼と差し戻しルールを追加する
3. `scripts/start-architect.js` を追加する
4. `scripts/install.js` に architect 起動設定の扱いを追加する
5. 必要なら `scripts/resolve-agent.js` / `scripts/agent-launch.js` の既存機構だけで専用起動できるか確認し、不足分のみ補う
6. `node scripts/install.js` を実行して配布物を更新する
7. `npm test` を実行する
8. `start-architect.js --help` と、最小の実起動パスを確認する

## 検証観点

- architect pane が通常worker worktreeを作らずに起動する
- `.gh-maestro/workers.json` に `architect` が登録される
- architect から `send-pane.js orchestrator ...` で自然言語のIssue化依頼を送れる
- orchestrator から `send-pane.js architect ...` で差し戻せる
- architect の自然言語依頼を受けたorchestratorが、要求定義を引き取らずIssue草稿化または差し戻しに徹する
- `node scripts/install.js` 後に `~/.agents/skills/gh-maestro-architect/SKILL.md` が配布される
- 既存worker起動、PR検出、レビュー監視に影響がない

## 段階導入

### Phase 1: スキルと運用ルール

- `gh-maestro-architect` スキル追加
- orchestrator スキルに architect 連携ルール追加
- 起動は手動でもよい

### Phase 2: 専用起動スクリプト

- `start-architect.js` 追加
- `workers.json` に `architect` 登録
- 双方向 `send-pane.js` 通信を実機確認

### Phase 3: 最高モデル設定の整備

- `agents.json` の architect 設定導線を整える
- 未設定時のエラーをわかりやすくする
- 実際に使う最高モデルCLIの起動方式を検証する

## 判断

architect は、gh-maestro の既存worker体系に入れない方がよい。workerは bounded execution のための仕組みであり、architect は人間との上流対話が価値の中心だからである。

通信は `send-pane.js` の自然言語で十分。固定イベント名や常時ポーリングを追加すると、賢いモデル同士の対話を不必要に機械的なプロトコルへ寄せてしまう。耐久性は `send-pane.js` のメッセージファイル化と、必要時のMarkdown handoffで確保する。

## 設計再検討: entrypoint と session.json

`/gh-maestro` は orchestrator 固定起動ではなく、セッション入口である。architect を導入するなら、入口で architect と orchestrator のどちらに入るかを deterministic に決める必要がある。

この判定をLLMに任せてはいけない。`/gh-maestro` 起動直後に `scripts/route-session.js` のような入口スクリプトを呼び、ローカル状態だけを見て決める。GitHub API、grep、worker起動はしない。

`session.json` は pane 配送ではなく、入口ルーティングのための状態にする。pane配送は引き続き `workers.json` の責務である。

```json
{
  "schemaVersion": 1,
  "repo": "owner/repo",
  "workspace": "C:/path/to/workspace",
  "baseBranch": "feature/session",
  "mode": "architect",
  "status": "intake",
  "active": {
    "issue": null,
    "pr": null
  },
  "last": {
    "issue": 123,
    "pr": 456
  },
  "updatedAt": "2026-07-04T00:00:00.000Z"
}
```

`active` は「いまgh-maestroが責任を持っている未完了の対象」だけを表す。最後に扱ったIssue/PRは `last` に退避する。これを分けないと、一度Issueを作った後に `/gh-maestro` が永遠にorchestrator復帰になり、新規architect intakeへ戻れない。

入口判定は以下に絞る。

1. `session.json.active.issue` または `session.json.active.pr` がある場合は orchestrator に復帰する
2. `session.json.mode=architect` かつ `status=intake` または `requirements` の場合は architect に復帰する
3. `workers.json` や `worktrees/issue-*` に未整理のworkerがある場合は orchestrator に復帰し、人間に状態確認を求める
4. どれもなければ `mode=architect,status=intake,active.issue=null,active.pr=null` を `session.json` に書いて architect として待機する

`status=intake` は「新規相談内容はまだ受け取っていないが、gh-maestro入口がarchitect待機状態に入った」という意味である。この更新は `/gh-maestro` 起動時に行う。人間が最初の相談を入力するまで待つと、起動直後に落ちた場合に復帰できず遅い。

### active を空にする確定点

ここが現在の計画の未解決点である。

`active.issue` / `active.pr` を空にする確定点を低レベルスクリプトに置くと矛盾する。

- `spawn-worker.js` は不適切。同一Issueに複数workerを起動するため、worker起動はIssue状態の遷移ではない
- `remove-worker.js` は不適切。同一Issueに複数workerがあり、最後のworkerかどうかを単体では判断できない
- `gh issue close` 相当の処理だけでは不十分。反省会や承認事項の反映、worker cleanup が残る可能性がある
- `reset-session.js` は異常系であり、通常完了の確定点ではない

したがって、`active` を空にするには「gh-maestroの1サイクルが完全終了した」ことを表す高水準の出口が必要である。

候補は `scripts/complete-cycle.js`。これは Issue close、反省会完了、承認事項の反映、対象worker削除が終わった後にだけ `active` を `last` へ退避し、`active.issue=null,active.pr=null,status=idle` にする。

ただし、このスクリプトを導入するなら orchestrator の完了フローも「最後に必ず `complete-cycle.js` を呼ぶ」形に変える必要がある。ここを曖昧にすると `session.json` はすぐ腐る。

この再検討により、architect導入だけでは不十分であることが分かる。実装順序は少なくとも以下に修正する必要がある。

1. `session.json` の `active/last` スキーマを決める
2. `/gh-maestro` 起動時の `route-session.js` を作る
3. `active` を空にする高水準の通常完了出口を決める
4. その後に architect skill と起動導線を実装する

## 設計更新: CLI を正式エントリポイントにする

`/gh-maestro` スキルをエントリポイントにする設計は撤回する。スキル起動は、何らかのエージェントが既に立ち上がっていることを前提にしてしまうため、最初の入口として不適切である。

正式な入口はターミナルコマンド `gh-maestro` とする。

```sh
gh-maestro
gh-maestro architect
gh-maestro 999
gh-maestro reset
```

`gh-maestro` と `gh-maestro architect` は同じ意味にする。どちらも新規要求定義のために architect を起動する。

```text
gh-maestro
  -> session.json を mode=architect,status=intake,active.issue=null,active.pr=null に更新
  -> architect pane を起動、または既存 architect pane に復帰

gh-maestro architect
  -> gh-maestro と同じ

gh-maestro 999
  -> 999 を Issue/PR 番号として扱う
  -> session.json を mode=orchestrator,active.issue/pr=999 相当に更新
  -> orchestrator pane を起動、または既存 orchestrator pane に通知
```

この変更により、スキル名に続く入力を利用しない。Claude Code の `$ARGUMENTS`、Codex の `$skill` 呼び出し、Antigravity のスキル起動差分に依存しない。

責務分離は以下とする。

| 要素 | 責務 |
|---|---|
| `gh-maestro` CLI | 入口、引数解釈、`session.json` 更新、pane起動、既存paneへの通知 |
| `session.json` | CLIが次に何を起動・復帰するか判断する状態 |
| `workers.json` | `send-pane.js` がpane配送に使う状態 |
| `gh-maestro-architect` skill | 起動後の要求定義対話 |
| `gh-maestro-orchestrator` skill | 起動後のIssue/PR進行管理 |

`/gh-maestro` スキルは残すとしても補助入口に格下げする。主入口ではない。補助入口として使う場合も、スキル引数を読まず、可能ならCLIの利用を促す。

この方針により、`route-session.js` は独立スクリプトではなく CLI 本体の内部処理にしてよい。CLIが `session.json` を更新してから適切なエージェントを起動するため、起動直後の「対象Issue/PRなし」判定をLLMに持ち込まない。

実装順序を以下に修正する。

1. `gh-maestro` CLI を追加する
2. CLIで `gh-maestro` / `gh-maestro architect` / `gh-maestro <number>` を解釈する
3. CLIが `session.json` の `active/last` スキーマを更新する
4. CLIが architect/orchestrator pane を起動または既存paneへ通知する
5. `gh-maestro-architect` skill を追加する
6. orchestrator skill に architect からの自然言語Issue化依頼と差し戻しルールを追加する
7. 通常完了時に `active` を `last` へ退避して空にする高水準出口を設計する

## CLI 実装言語

`gh-maestro` CLI は Node.js で実装する。

理由:

- 既存スクリプトが `scripts/*.js` に集約されている
- `install.js`, `spawn-worker.js`, `send-pane.js`, `agent-launch.js` など既存資産を直接再利用できる
- Windows/Linux 両対応で shell 差分を避けやすい
- `package.json` の `bin` で `gh-maestro` コマンドを提供できる
- npm 経由なら Windows では `.cmd` shim が生成され、shebang依存を避けられる

想定構成:

```text
bin/gh-maestro.js
scripts/session-state.js
scripts/start-architect.js
scripts/start-orchestrator.js
```

`package.json` には以下を追加する。

```json
{
  "bin": {
    "gh-maestro": "./bin/gh-maestro.js"
  }
}
```

Bash は Windows 対応が弱く、PowerShell は Linux 側の前提が増える。Python は既存Node資産と分断され、Go/Rust は現時点では重い。したがって、このプロジェクトでは Node.js が最小で自然な選択である。
