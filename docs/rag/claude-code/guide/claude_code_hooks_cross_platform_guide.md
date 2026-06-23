# Claude Code フック クロスプラットフォーム実装ガイド

フックコマンドの環境依存を避けるための実装パターン。

## Shell form と Exec form の違い

### Shell form（`args` なし）

```json
{
  "type": "command",
  "command": "node \"$HOME/.my-tool/scripts/setup.js\" --workspace \"$(pwd)\""
}
```

`command` 文字列をシェルに渡して実行する：
- macOS / Linux: `sh -c`
- Windows（Git Bash あり）: Git Bash
- Windows（Git Bash なし）: PowerShell

**問題**: `$(pwd)` は bash 記法。Git Bash がなければ展開されない。`$HOME` も環境によって未定義になる。

### Exec form（`args` あり）

```json
{
  "type": "command",
  "command": "node",
  "args": ["C:\\Users\\amg\\.my-tool\\scripts\\setup.js", "--workspace", "${CLAUDE_PROJECT_DIR}"]
}
```

シェルを介さず `node` を直接 spawn する。シェル記法は一切使えないが、**OS・シェル非依存**。

## 環境依存を避けるための原則

### 1. スクリプトパスはインストール時に絶対パスに解決する

```js
// install.js
const scriptPath = path.join(
  expandHome('~/.my-tool/scripts'),
  'setup.js'
);
// → "C:\\Users\\amg\\.my-tool\\scripts\\setup.js"
// → "/home/amg/.my-tool/scripts/setup.js"
// これを settings.json に書き込む
```

ランタイムに `$HOME` を展開させるのではなく、`install.js` 実行時に解決した絶対パスを settings.json に埋め込む。

### 2. ワークスペースパスは `${CLAUDE_PROJECT_DIR}` プレースホルダーを使う

Claude Code が提供する以下のプレースホルダーは exec form でも shell form でも使える：

| プレースホルダー | 意味 |
|---|---|
| `${CLAUDE_PROJECT_DIR}` | プロジェクトルート（Claude 起動ディレクトリ） |
| `${CLAUDE_PLUGIN_ROOT}` | プラグインのインストールディレクトリ |
| `${CLAUDE_PLUGIN_DATA}` | プラグインの永続データディレクトリ |

これらは Claude Code がスポーン前に解決するため、シェル記法に依存しない。また、スポーンされたプロセスの環境変数としても渡される（`process.env.CLAUDE_PROJECT_DIR` で参照可能）。

### 3. exec form では `command` は実行ファイルのみ

```json
// 誤: command に引数を混ぜる
{"command": "node setup.js --fix", "args": []}

// 正: command は実行ファイルのみ、引数は args へ
{"command": "node", "args": ["setup.js", "--fix"]}
```

`command` にスペース区切りで引数を書いても exec form では解釈されない。

## まとめ：クロスプラットフォーム対応フックのパターン

```json
{
  "type": "command",
  "command": "node",
  "args": [
    "/absolute/path/to/script.js",
    "--workspace",
    "${CLAUDE_PROJECT_DIR}"
  ],
  "statusMessage": "実行中..."
}
```

- `"command"`: シェル非依存の実行ファイル名（`node`, `python` 等）
- `"args"[0]`: インストール時に解決した絶対パス
- `"${CLAUDE_PROJECT_DIR}"`: Claude Code プレースホルダー（シェル記法不要）
