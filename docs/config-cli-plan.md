# gh-maestro 設定プロファイル切替CLI 導入計画書

`config.json` の設定（主に `skillAgentMap`）を、事前に定義したパターン（プロファイル）に基づいて高速かつ安全に切り替える CLI ツール (`scripts/config.js`) の設計・実装計画です。

---

## 1. 背景と目的

現在、時間帯（ピーク時）や利用クォータ（制限）などの状況に応じてワーカーのエージェント割り当てを変更するには、`config.json` を手動でテキスト編集する必要がありますが、以下の課題があります。

1. **手間の多さと速度**: ピーク時間帯やクォータ枯渇時に、エディタを開いて JSON を書き換える作業は「コマンド一発で切り替える」のに比べて遅く、ミスの原因になります。
2. **依存関係の肥大化の回避**: 前回の Web GUI 計画は、20行程度の JSON 編集に対して Web サーバー（Fastify）やフロントエンドビルド（Vite）、さらにはセキュリティ対策（CSRF）など過剰な依存関係と保守コストをプロジェクトに持ち込む懸念がありました。
3. **安全性の担保**: 手動書き換えでは、エージェントIDのタイポや、ワークスペース固有の設定におけるコマンド上書き禁止制約（[resolve-config.js](file:///C:/Users/amg/work/gh-maestro/scripts/shared/resolve-config.js#L168-L180)）に起因するミスに気づきにくい課題があります。

これらを解決するため、**標準ライブラリ（依存関係ゼロ）のみ** で動作し、事前定義したプロファイルを一発で適用・検証できる管理用 CLI スクリプトを導入します。

---

## 2. システム構成とデータモデル

### `config.json` の拡張設計

グローバル（`~/.gh-maestro/config.json`）またはワークスペース固有の `config.json` に `profiles` セクションを追加します。

```json
{
  "profiles": {
    "default": {
      "skillAgentMap": {
        "gh-maestro-coder": "claude-ds",
        "gh-maestro-base": "claude-ds",
        "gh-maestro-senior-coder": "claude-ds-pro",
        "gh-maestro-investigator": "reasonix",
        "gh-maestro-explorer": "agy"
      }
    },
    "peak": {
      "skillAgentMap": {
        "gh-maestro-coder": "agy",
        "gh-maestro-base": "agy"
      }
    },
    "codex-out": {
      "skillAgentMap": {
        "gh-maestro-senior-coder": "claude-ds-pro"
      }
    }
  },
  "skillAgentMap": {
    "gh-maestro-coder": "claude-ds",
    "gh-maestro-base": "claude-ds",
    "gh-maestro-senior-coder": "claude-ds-pro",
    "gh-maestro-investigator": "reasonix",
    "gh-maestro-explorer": "agy"
  }
}
```

---

## 3. CLI コマンド仕様 (`scripts/config.js`)

追加されるスクリプトは `node scripts/config.js <subcommand>` として呼び出します。

### ① `node scripts/config.js list`
定義されているプロファイルの一覧と、それぞれがどのようなマッピングを持っているかを表示します。また、現在アクティブなプロファイル名（完全に一致するマッピングを持つプロファイル）をハイライトします。

### ② `node scripts/config.js use <profile-name>`
指定したプロファイルに含まれる `skillAgentMap` の設定を、現在の `skillAgentMap` にマージして上書き保存します。
- `--global` または `-g` フラグ: `~/.gh-maestro/config.json` を書き換えます（デフォルト）。
- `--workspace` または `-w` フラグ: 現在のワークスペースの `.gh-maestro/config.json` を書き換えます。

> [!NOTE]
> 反映時には自動的に「指定されたエージェントIDが定義に存在するか（タイポがないか）」のスキーマチェックを自動的に実行し、警告を発します。

### ③ `node scripts/config.js status`
現在のマッピング状態と、各エージェントの疎通確認結果を一覧表示します。

- **エージェント疎通検証**: 
  現在割り当てられている各エージェントの起動コマンド（`command`）が、システム上で実行可能（[checkAgentExists](file:///C:/Users/amg/work/gh-maestro/scripts/agent-exec.js#L30) でパスが通っているか）かをチェックし、`[✓]` または `[✗]` で可視化します。
- **セキュリティ・制約の可視化**: 
  ワークスペースの `config.json` で定義しようとした `command` や `extraArgs` が無視されている場合、「*Warning: ワークスペースの command 設定はセキュリティ制約により無視されています。グローバル設定で定義してください*」と警告を出します。

---

## 4. セキュリティと設計方針

- **依存パッケージの追加禁止**: `npm install` なしで即座に動くよう、Node.js 標準モジュール（`fs`, `path`, `child_process`）のみで記述します。
- **破壊的変更の防止**: `config.json` を書き換える際、パースに失敗した場合や例外が発生した場合は書き込みを中断し、元のファイルを破壊しないよう一時ファイル（`config.json.tmp`）を介して安全に上書きします。
- **既存解決ロジックとの調和**: `scripts/shared/resolve-config.js` 側は読み込み専用のロジックとして維持し、今回の CLI スクリプトは「JSONのライター・検証機」として完全に分離します。これにより、既存の読み込みフローへの影響を最小限に抑えます。

---

## 5. 実装ステップ

1. **`scripts/config.js` のスケルトン作成**
   - コマンドライン引数の簡易パースロジック。
   - グローバルおよびワークスペースの `config.json` を見つけてロードするヘルパー。
2. **`list` および `use` コマンドの実装**
   - プロファイル定義の上書き・マージ処理。
   - 上書き書き込みの安全なトランザクション処理。
3. **`status` コマンドの実装**
   - [agent-defaults.json](file:///C:/Users/amg/work/gh-maestro/scripts/agent-defaults.json) と `config.json` のマージ状況の算出。
   - `checkAgentExists` によるパス疎通テストと警告表示。
4. **テストの追加**
   - `tests/config-cli.test.js` を作成し、プロファイルの書き換えが正しく行われるか、バリデーションが動作するかを確認。
