# DeepSeek Claude Code ラッパー

DeepSeek APIを使ってClaude Codeを快適に使うための設定ファイルです。

## ファイル構成

- `.bashrc`                          → Linux/macOS 用シェル設定
- `Microsoft.PowerShell_profile.ps1` → Windows PowerShell 用プロファイル設定

## インストール手順

### 1. Linux / macOS の場合

```bash
cd ~/deepseek

# .bashrc をホームディレクトリに適用
cp .bashrc ~/.bashrc
# または安全に追記する場合
cat .bashrc >> ~/.bashrc
```

その後実行：
```bash
source ~/.bashrc
```

### 2. Windows Powershellの場合

```PowerShell
cd ~\deepseek

# プロファイルを適用
Copy-Item -Path Microsoft.PowerShell_profile.ps1 -Destination $PROFILE -Force
```

Powershellを再起動してください。


## 使用方法
```
claude-ds
```
