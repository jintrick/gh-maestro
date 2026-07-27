# エージェント起動メカニズム整理 計画書

> ## ⚠️ この文書は策定時点の記録であり、一部は現状と異なる
>
> **今も有効な部分**: 「起動argvの組み立て方は `promptDelivery` という宣言的データで選び、実装は共通側に集約する」という設計方針そのもの。`spawn-worker.js` はこの方針で書かれている。
>
> **現状と異なる部分**（Issue #151 および保留#10/#11 の対応で変わった）:
>
> | 本文の記述 | 現状 |
> |---|---|
> | `agents.json` | ファイル名は `scripts/agent-defaults.json` |
> | `send-text-after-launch` メカニズム | headless実行では画面への入力注入ができないため**フェイルクローズで拒否**される。`agent-defaults.json` に該当エージェントは無い |
> | `sendTextDelayMs`（TUI初期化待ち） | 削除。唯一の消費者だった `launchAgentInPane` が廃止された |
> | `enterSequence` | 削除。同上 |
> | `skillsViaMd` | 撤去済み。全エージェントがネイティブなスキル発見機構を持つことが判明したため（`.claude/rules/shared-skill-agent-tools.md` 参照） |
> | `wezterm cli send-text` による注入 | ワーカー起動経路からWezTermは撤去済み。起動は `shared/headless-launch.js` |
>
> 起動基盤の現状は `scripts/shared/headless-launch.js` と `scripts/agent-exec.js` のファイル冒頭コメントを一次情報とすること。

策定日: 2026-07-03
ステータス: 策定時の実装は完了。上記のとおり一部が後続変更で置き換わっている
きっかけ: codexエージェント追加時、`spawn-worker.js`の起動分岐がこれ以上増やせない設計になっていることが判明

## 問題

`spawn-worker.js`は現在、以下3つの独立したフィールドの**組み合わせ**から「プロンプトをどう渡すか」を推測している。

```js
// 現状(scripts/spawn-worker.js の agentCmdArgs 相当)
if (agentConfig.skillsViaMd && !agentConfig.promptFlag) {
  // reasonix: 起動時は何も渡さず、後でsend-textで注入
} else if (agentConfig.promptFlag) {
  // agy: フラグ経由でargv
} else {
  // claude/claude-ds: --append-system-prompt-file 決め打ち
}
```

この設計には2つの欠陥がある。

1. **組み合わせ推測**: `skillsViaMd`(スキル内容をAGENTS.md経由で渡すか)と`promptFlag`(プロンプトをフラグ経由で渡すか)は本来無関係な軸なのに、両者の有無の組み合わせで「起動方式」を推測している。この2軸だけで3パターンしか作れず、新しい起動方式(codexのようなpositional直渡し)が来ると`else`(claude系)に落ちて誤動作する
2. **暗黙のフォールバック**: 新エージェント追加のたびに、この`if`チェーンに手を入れる必要がある。エージェント固有の知識が`spawn-worker.js`という共有スクリプト本体に蓄積し続ける

codex追加(positional引数でプロンプトを直接渡す、`--append-system-prompt-file`相当が存在しない)を機に、この場当たり的な分岐が限界に達した。

## 検討の経緯(反省込み)

最初「エージェントごとにアダプタファイル(`scripts/agents/<id>.js`)を作り、起動ロジックをそこに閉じ込める」という案を検討したが、これは誤りだった。

理由: 起動メカニズム(system-prompt-file / flag / positional / send-text-after-launch)の**実装そのもの**(argv組み立て、送信タイミング)は複数エージェントで再利用される共通ロジックであり、エージェント固有の知識ではない。これをエージェント別ファイルに分散すると、DRYを保つために結局共有ヘルパーを介する羽目になり、間接層が増えるだけで問題は解決しない。

正しい切り分けは以下の通り。

| 場所 | 持つべきもの |
|---|---|
| **agents.json**(データ) | 「どのメカニズムを使うか」の宣言 + そのメカニズムが必要とするパラメータのみ |
| **spawn-worker.js**(ロジック) | 4種類の起動メカニズムの実装そのもの(共通処理として1箇所に集約) |

エージェントを追加するたびに触るのは`agents.json`のデータだけになり、`spawn-worker.js`側は「既知の4メカニズムを超える本当に新しい起動様式」が現れたときだけ変更が必要になる(頻度は低い想定)。

## 新しいフィールド設計

`promptFlag`の有無で分岐を推測するのをやめ、**`promptDelivery`という明示的なenumフィールド**を新設する。

```
promptDelivery: "system-prompt-file" | "flag" | "positional" | "send-text-after-launch"
```

`skillsViaMd`(スキル内容をAGENTS.md経由で渡すか、エージェント自身のネイティブスキットシステムに任せるか)は**別軸の独立した設定のまま残す**。プロンプトの配送方法とスキル内容の配送方法は無関係だから。

### 4メカニズムの実装(spawn-worker.js内に集約)

| `promptDelivery` | 実装 | 現在の該当エージェント |
|---|---|---|
| `system-prompt-file` | `--append-system-prompt-file <promptFile>` + 短い固定メッセージをargv末尾に渡す | claude, claude-ds |
| `flag` | `[promptFlag, shortPrompt]`をargvに追加 | agy(`-i`) |
| `positional` | `shortPrompt`をargv末尾にそのまま渡す(追加フラグ不要) | **codex(新規)** |
| `send-text-after-launch` | 起動時はプロンプト無しでspawnし、TUI初期化待ち(ms、エージェントごとに可変)後に`wezterm cli send-text`で注入 | reasonix |

`send-text-after-launch`の待機時間(reasonixは実績2000ms)は、メカニズム共通の実装に対する**パラメータ**として`agents.json`側に持たせる(例: `sendTextDelayMs: 2000`)。ハードコードしない。

## 移行後の agents.json 全体像

```js
const defaults = [
  { id: 'claude',    label: 'Claude Code (Anthropic)', command: 'claude',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'system-prompt-file', enterSequence: '\r\n' },

  { id: 'claude-ds', label: 'Claude Code (DeepSeek)',  command: 'claude-ds',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'system-prompt-file', enterSequence: '\r\n' },

  { id: 'agy',       label: 'Antigravity',             command: 'agy',
    extraArgs: ['--dangerously-skip-permissions'],
    promptDelivery: 'flag', promptFlag: '-i', enterSequence: '\r\n' },

  { id: 'reasonix',  label: 'Reasonix Code',           command: _rxCmd,
    extraArgs: _rxArgs,
    promptDelivery: 'send-text-after-launch', sendTextDelayMs: 2000,
    skillsViaMd: true, enterSequence: '\r' },

  { id: 'codex',     label: 'Codex (OpenAI)',          command: 'codex',
    extraArgs: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
    promptDelivery: 'positional', enterSequence: '\r\n'(要検証) },
];
```

`promptFlag`フィールドは`promptDelivery: 'flag'`のときだけ意味を持つパラメータとして残す(廃止しない)。

## spawn-worker.js側の変更

現在の`agentCmdArgs`のif-elseチェーンを、`promptDelivery`の値をキーにしたディスパッチに置き換える。

```js
const buildArgsByDelivery = {
  'system-prompt-file': () => [
    agentConfig.command, ...agentConfig.extraArgs,
    '--append-system-prompt-file', promptFile,
    `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。`,
  ],
  'flag': () => [agentConfig.command, ...agentConfig.extraArgs, agentConfig.promptFlag, shortPrompt],
  'positional': () => [agentConfig.command, ...agentConfig.extraArgs, shortPrompt],
  'send-text-after-launch': () => [agentConfig.command, ...agentConfig.extraArgs],
};
const agentCmdArgs = buildArgsByDelivery[agentConfig.promptDelivery]();
```

`send-text-after-launch`の場合の起動後注入処理(現在`skillsViaMd && !promptFlag`で判定している箇所)も、`agentConfig.promptDelivery === 'send-text-after-launch'`判定に置き換え、待機msを`agentConfig.sendTextDelayMs`から読む。

未知の`promptDelivery`値が来た場合は、`spawn-worker.js`の`fail()`で明示的にエラーにする(黙って`undefined`を返してwezterm起動が壊れるのを防ぐ)。

## codex起動オプション(実機確認済み)

```
codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen "<prompt>"
```

- `--dangerously-bypass-approvals-and-sandbox`: claudeの`--dangerously-skip-permissions`相当。承認プロンプト・サンドボックス両方をバイパス
- `--no-alt-screen`: WezTermペイン内でスクロールバック履歴を保持するため付与(他エージェントとの見え方の一貫性が目的、必須ではない)
- `PROMPT`(positional): interactiveモードでも直接渡せることを実機で確認済み(`codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen "reply with exactly the word PONG..."` → `PONG`と応答して正常終了)
- `--append-system-prompt-file`相当のフラグは存在しない(codexの`--help`で確認済み)

## 実機検証結果(完了)

`node scripts/spawn-worker.js --skill gh-maestro-base --agent codex ...`を実際に2回実行して確認した。

1. **1回目**: 起動直後、初回オンボーディングとして「サンドボックス初期設定ウィザード」(`1. Set up default sandbox` / `2. Use non-admin sandbox` / `3. Quit`、Enter/Escでの選択待ち)が表示され、positional promptの処理がブロックされた。`--dangerously-bypass-approvals-and-sandbox`はコマンド実行時の承認バイパスであり、**この初回セットアップウィザードは対象外**
2. **2回目**(同じ`~/.codex`状態を共有する2回目の起動): ウィザードは出ず、positional promptがそのまま処理された。gh-maestro-baseスキルがcodex側にまだインストールされていないため、codexは自律的に「スキル本体は読めないので指定された`.gh-maestro/prompt.md`を読む」と判断し、`Get-Content`でファイルを読んで指示通り"PONG"と応答して完了した
3. 承認プロンプトによる停止は発生しなかった(`--dangerously-bypass-approvals-and-sandbox`は機能している)

結論: **起動メカニズム(`promptDelivery: 'positional'`)は実装・検証ともに完了。** ただし新規マシン/新規`~/.codex`プロファイルでは初回のみ手動でウィザードを済ませる必要がある(下記フォローアップ参照)。

## 未確定・要フォローアップ

- **初回セットアップウィザードの無人化**: 新しいマシンや新しい`CODEX_HOME`で最初にcodexを起動する際、サンドボックスウィザードが対話入力を要求し、無人spawnをブロックする。CI/自動化向けにこれを事前に済ませる設定(config.tomlでの明示指定等)があるか要調査。現状は「そのマシンで一度手動で`codex`を起動してウィザードを済ませておく」ことがgh-maestro導入手順の前提になる
- **codexの`enterSequence`**: `send-pane.js`経由の追加メッセージ送信(起動後のフォローアップ)で使うEnter相当の送信terminatorは未検証。claude/agy/claude-dsは`\r\n`実績ありだが、reasonixは`\r`単体という前例があるため、codexも別途実機確認が必要
- **codexのスキル配置**: codexはSKILL.md形式(Open Agent Skills標準)のネイティブスキットシステムを持つ(`~/.agents/skills`)。claude/agyと同様に`skills/agents.yaml`へ実体インストール先を追加できるが、これは本計画のスコープ外(別タスクとして扱う)。今回の検証では未インストールのままでも、codexが自律的にprompt.mdへフォールバックして正しく動作することを確認した
- **codex向けPOLL_MECHANISM**: `skills/agents.yaml`のclaude/agyエントリにある「PRレビュー通知のポーリング機構」記述に相当するcodex版の設計(codexのsubagent機構・バックグラウンド実行の実際の使い方を要調査)。本計画のスコープ外

## 実装内容(完了)

1. `scripts/spawn-worker.js`の`agentCmdArgs`を`promptDelivery`キーのディスパッチテーブル方式に書き換え、未知の`promptDelivery`をfail扱いにした。`--agent`未指定時のagyフォールバック設定にも`promptDelivery: 'flag'`を追加した
2. `scripts/install.js`の`defaults`配列を新フィールド構成に置き換えた(`promptFlag`単体推測 → `promptDelivery`明示)。既存ユーザーの`~/.gh-maestro/agents.json`に対する移行ロジックは、command一致ガード(customize済みcommandのextraArgsを壊さないためのもの)とは独立して、`promptDelivery`欠如のエントリには常にバックフィルするよう修正した(claude-dsのようなpwshラッパーで検証済み)
3. codexエントリを追加した
4. `node scripts/spawn-worker.js --skill gh-maestro-base --agent codex ...`を2回実機実行し、exit 0・pane起動・初回メッセージ到達・応答完了を確認した(上記「実機検証結果」参照)
5. 既存3エージェント(claude/claude-ds/agy)については`node scripts/install.js`実行で新フィールドへの移行を確認済み。reasonixは実機起動未確認(既存の`send-text-after-launch`ロジック自体は変更していないため、リグレッションリスクは低いと判断)
