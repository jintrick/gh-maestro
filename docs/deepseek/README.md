# DeepSeek用エージェント CLIラッパー

DeepSeek APIを使ってClaude Codeなどを快適に使うための設定ファイルです。

## APIキーの保管場所

キーは reasonix が使う `.env` ファイルから取得します。

- Windows: `%APPDATA%\reasonix\.env`
- Linux / macOS: `~/.reasonix/.env`

中身は次の1行：

```
DEEPSEEK_API_KEY=<your-key>
```

> reasonix はプロセス環境変数を受け付けず、この `.env` に平文でキーを置くしかありません。
> 同じキーが既に平文でディスク上に存在するため、gpg / SecretStore で別途暗号化して保管しても
> 実効的な保護にならず、二重管理になるだけです。よってこの `.env` を**キーの単一の源**とし、
> claude-ds ラッパーもここから読みます。

## インストール手順

### Linux / macOS の場合

このディレクトリにある `.bashrc` の設定をホームディレクトリの `.bashrc` に適用します：

```bash
cat .bashrc >> ~/.bashrc
source ~/.bashrc
```

### Windows (PowerShell) の場合

`claude-ds` は PowerShell プロファイル（`$PROFILE`）に関数として定義します。
関数は `%APPDATA%\reasonix\.env` から `DEEPSEEK_API_KEY` を読み、`ANTHROPIC_AUTH_TOKEN` を
セットして `claude` を起動します。

## 使用方法

通常モデル（Pro）で起動する場合：
```bash
claude-ds
```

高速・低価格モデル（Flash）で起動する場合（Linux のみ）：
```bash
claude-ds-flash
```

> 認証は `ANTHROPIC_AUTH_TOKEN` を使います。`ANTHROPIC_API_KEY` と併用すると Claude Code が
> 警告を出すため、`AUTH_TOKEN` に一本化しています。
