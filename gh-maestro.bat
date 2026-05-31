@echo off
setlocal enabledelayedexpansion

echo [gh-maestro] Initializing workspace...

:: 1. Read owner/repo from .git/config
for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command "$url = git config --get remote.origin.url; if ($url -match 'github\.com[:/](.+?/.+?)(\.git)?$') { $matches[1] }"`) do (
    set "OWNER_REPO=%%a"
)

if "!OWNER_REPO!"=="" (
    echo [Error] Failed to determine owner/repo from remote origin.
    exit /b 1
)

echo [gh-maestro] Target Repository: !OWNER_REPO!

:: 2. Prepare initial prompts
set "ORCHESTRATOR_PROMPT=リポジトリ: !OWNER_REPO!。あなたの役割はオーケストレーター（ペイン名: orchestrator）です。人間と対話してIssueの内容を共同起草し、gh issue create でIssueを作成してください。Issue作成後、A2A送信（terminal_send + terminal_send_key(enter)）を用いて coder ペインに「Issue #N を実装してください」と通知してください。"
set "CODER_PROMPT=リポジトリ: !OWNER_REPO!。あなたの役割はコーダー（ペイン名: coder）です。オーケストレーターからの実装指示を待機してください。指示を受け取ったら実装を開始し、テストを行って自己修正したのち、完了したら gh pr create でPRを作成してください（本文に Closes #N を含める）。PR作成後、A2A送信で reviewer ペインに「PR #N をレビューしてください」と通知してください。"
set "REVIEWER_PROMPT=リポジトリ: !OWNER_REPO!。あなたの役割はレビュアー（ペイン名: reviewer）です。コーダーからのレビュー依頼を待機してください。PRのdiffとIssue要件を照合し、問題なければ gh pr review --approve を提出して orchestrator ペインに通知、修正が必要なら --request-changes を提出して coder ペインに修正内容を通知してください。"

:: 3. Create panes and start agents
echo [gh-maestro] Starting agents in wmux panes...

:: Rename current pane to orchestrator
wmux rename-pane orchestrator 2>nul

:: Create coder pane
wmux split-pane -v -n "coder" -c "agy ""!CODER_PROMPT!"""

:: Create reviewer pane
wmux split-pane -h -n "reviewer" -c "agy ""!REVIEWER_PROMPT!"""

:: Start orchestrator in the current pane
echo [gh-maestro] Starting Orchestrator (Claude)...
claude "!ORCHESTRATOR_PROMPT!"

endlocal
