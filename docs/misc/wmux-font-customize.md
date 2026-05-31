  wmux 日本語フォント美化パッチ・チートシート (v2)

  この手順は、wmux のバイナリに含まれるJavaScriptを直接書き換え、フォント設定を強制的に UDEV Gothic
  等の綺麗なフォントに固定するものだ。

  0. 事前準備
   1. Node.js がインストールされていること（npx を使用するため）。
   2. ターゲットの日本語フォント（例: UDEV Gothic JPDOC）が Windows にインストールされていること。
   3. wmux を「完全に」終了させる（重要）
       * 罠: GUI右上の「×」ボタンで閉じても、タスクトレイに常駐してプロセスが残り、ファイルのロックが解除されない。
       * 正しい終了法: メニューから File -> Exit を選ぶ。
       * 確認: それでも不安な場合は、タスクマネージャーで wmux プロセスが消えていることを確認せよ。

  1. app.asar の場所を特定
  通常、以下のパスにある（app-X.X.X の部分はバージョンにより異なる）。

   %LOCALAPPDATA%\wmux\app-2.9.1\resources\app.asar

  2. app.asar の展開
  作業用フォルダ（例: C:\temp\wmux_work）を作成し、そこに展開する。

   # 展開コマンド
   npx asar extract "上記のapp.asarのパス" "C:\temp\wmux_work"

  3. JavaScript の修正
  展開したフォルダ内の .js ファイルから、フォント設定を検索して書き換える。

   * 検索対象ファイル: .vite\renderer\main_window\assets\index-XXXXXX.js（名前はランダム）
   * 検索キーワード: fontFamily

  【修正内容】
  以下の文字列（テンプレートリテラル）を探し、${A}（変数）ごと 自分の好きなフォント名に置き換える。

  置換前（例）:

   fontFamily:`'${A}', 'Consolas', 'Courier New', 'Malgun Gothic', monospace`

  置換後（UDEV Gothic 固定）:

   fontFamily:`'UDEV Gothic JPDOC', 'UDEV Gothic JPDOC Regular', monospace`
  ※ファイル内に 2箇所 あるので、両方とも同じ値に書き換えること。これにより設定画面の選択を無視して固定される。

  4. app.asar の再パック
  修正したフォルダを再び .asar 形式に固める。

   npx asar pack "C:\temp\wmux_work" "C:\temp\app_patched.asar"

  5. デプロイ（上書き）
  元の app.asar をバックアップしてから、パッチ済みファイルを上書きする。

   # バックアップ
   copy "元のapp.asarのパス" "元のapp.asarのパス.bak"

   # 上書き
   move "C:\temp\app_patched.asar" "元のapp.asarのパス"

  6. 確認
  wmux を起動。設定画面の表示に関わらず、日本語が UDEV Gothic になっていれば成功だ。

  ---

  注意点: アプリがアップデートされるとパッチは初期化される。その際は再度この手順が必要だ。