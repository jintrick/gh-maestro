# DeepSeek用エージェント CLIラッパー

DeepSeek APIを使ってClaude Codeなどを快適に使うための設定ファイルです。
APIキーを平文で保存せず、GPGを用いて暗号化して管理します。

## 事前準備（APIキーの暗号化）

APIキーをパスワードで暗号化し、ファイルに保存します。

1. 以下のコマンドを実行します。
   ```bash
   gpg -c -o ~/.deepseek-api-key
   ```
2. APIキーを入力（または貼り付け）して **Enter** を押します。
3. パスワードを2回入力します。これで `~/.deepseek-api-key` が作成されます。

## インストール手順

### Linux / macOS の場合

このディレクトリにある `.bashrc` の設定をホームディレクトリの `.bashrc` に適用します：

```bash
cat .bashrc >> ~/.bashrc
source ~/.bashrc
```

## 使用方法

通常モデル（Pro）で起動する場合：
```bash
claude-ds
```

高速・低価格モデル（Flash）で起動する場合：
```bash
claude-ds-flash
```

※ 初回起動時やキャッシュ（`gpg-agent`）が切れた際に、設定したパスワードの入力を求められます。
