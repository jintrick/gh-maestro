---
source_url: https://github.com/openwong2kim/wmux/blob/main/handoff.md
original_title: handoff
fetched_at: 2026-05-30T16:00:11.004052+00:00
---

# Teammate Handoff — M0-c/d/e/f Team Mode

## Session State
- **current_phase**: 0 (Init complete) → Phase 3 (Implementation) 진입
- **completed_tasks**: M0-a (MetadataStore), M0-b (handler rewrite) — PR #34 base 7 commits
- **blocked_items**: (none)
- **next_steps**: M0-c teammate 스폰
- **active_worktrees**: (none — sequential mode)

## Context

### Branch
- `feature/m0-b-handler-rewrite` (PR #34 open)
- 7 commits already
- 새 commit 추가 방식 (squash X, force-push X)

### Baseline
- Tests: 1019 pass
- tsc clean, eslint 0 errors
- MetadataStore (`src/main/metadata/MetadataStore.ts`) day-one API 갖춤
- `pane.resolveActiveLeaf` IPC 가 paneId resolve 통일 (M0-b)
- paneSlice 는 더 이상 RPC metadata path 에서 mutate 안 됨 → M0-d 거의 no-op

### Plan 문서
- `C:\Users\rizz\.claude\plans\generic-wandering-teapot.md`
- 메모리: `project_substrate_10_plan.md`, `project_m0_progress.md`

## Implementation Order (sequential)

### 1. M0-c
- File: `src/main/pipe/handlers/pane.rpc.ts` (`pane.list` handler)
- Envelope: `{ asOfSeq, bootId, panes: [{ ...paneInfo, metadata, version }] }`
- `asOfSeq` / `bootId` 는 이미 v2.8.0 에 있음. metadata + version 만 inject.
- Tests 2개

### 2. M0-d
- File: `src/renderer/stores/slices/paneSlice.ts`
- Compile-time write protect. M0-b 이후 거의 no-op.
- Test 1개

### 3. M0-e
- Files: `src/main/session/SessionManager.ts`, `src/main/pipe/handlers/pane.rpc.ts`
- persist-then-publish 순서, hydrate, schema_version
- Tests 2개

### 4. M0-f
- Files: `src/shared/rpc.ts`, `src/shared/events.ts`, `src/main/pipe/handlers/system.rpc.ts`, `src/preload/index.ts`, `src/renderer/hooks/useRpcBridge.ts`, `src/mcp/index.ts`
- Wire-format spec, features.paneMetadata 객체화
- Tests 3+

## Gotchas

1. **PR #34 외부 리뷰어** — alphabeen, codex 가 PR 추적 중. force-push 금지.
2. **codex 단계별 리뷰** — 각 단계 commit 후 codex review skill 호출. P1 이상 finding 즉시 fix commit.
3. **paneSlice authority** — main process 가 authority. renderer mirror only.
4. **wire-format additive** — v2.8.x client 호환성 유지.
5. **persist-then-publish** — `MetadataStore.set() → SessionManager.persist() → EventBus.publish()` 순서 필수 (race spec #1).
6. **schema_version** — SessionManager dump 에 추가. 기존 v1 없는 dump 는 v1 normalize.
7. **테스트 인프라** — vitest, in-process. flaky 1회 재실행 허용.

## Test Discipline
- `npm test` 전체 실행. 1019 → +N pass 유지 (회귀 0)
- tsc clean, eslint 0 errors mandatory

## Key File Paths
- Main process metadata authority: `src/main/metadata/MetadataStore.ts` (read-only for c/d/e/f, snapshot() 호출)
- RPC handlers: `src/main/pipe/handlers/pane.rpc.ts`, `system.rpc.ts`
- Session: `src/main/session/SessionManager.ts`
- Renderer: `src/renderer/stores/slices/paneSlice.ts`, `src/renderer/hooks/useRpcBridge.ts`
- Shared: `src/shared/rpc.ts`, `src/shared/events.ts`, `src/shared/types.ts`
- Preload: `src/preload/index.ts`
- MCP: `src/mcp/index.ts`

## Interface Changes (다른 모듈에 영향)
- `pane.list` 응답 — `panes[].metadata` + `panes[].version` 추가 (M0-c, additive)
- `setMetadata` 응답 — `version` (M0-a 추가됨, M0-f spec 화)
- `system.capabilities.features.paneMetadata` — boolean → 객체 (M0-f). 객체 truthy → boolean 호환.
- `PaneMetadataChangedEvent.version` — optional (additive)
- session.json dump — `schema_version` 필드 추가 (M0-e)

## 사용자 정책
- `git push` 전 반드시 사용자 확인 (memory `feedback_push_confirm.md`)
- 코드/commit/PR body 모두 영어, 대화만 한국어 (memory `feedback_pr_commit_english.md`)
- merge 후 누락 파일 반드시 스캔 (memory `feedback_merge_missing_files.md`)
