---
source_url: https://github.com/openwong2kim/wmux/blob/main/decisions.md
original_title: decisions
fetched_at: 2026-05-30T16:00:10.996073+00:00
---

# Decisions Log — M0-c/d/e/f Team Mode

## [2026-05-12] Team Mode 시작 — M0-c/d/e/f + 단계별 codex 리뷰

**Background**: PR #34 (Substrate 3.0 M0 통합 작업) 의 M0-a, M0-b 완료. 남은 M0-c/d/e/f 를 팀 모드로 진행. 사용자 요구:
- 단계별 codex 리뷰
- 전체 끝나면 codex + claude 별도 세션 리뷰 2회

**Chosen**: Large path (Full Path: Phase 0 → 3 → 4 → 5, Phase 1·2 skip)

**Rationale**:
- 수정 파일 9-12개
- 아키텍처 변경: paneSlice authority 이전, persist-then-publish, wire-format 추가
- DAG 의존성 명확 (M0-c → M0-d → M0-e → M0-f)
- plan 이 이미 detailed (`C:\Users\rizz\.claude\plans\generic-wandering-teapot.md`, CEO+Eng+Codex 통과)

**Impact**:
- Phase 1·2 skip — plan 이 이미 architect/code-reviewer 통과
- 각 단계 commit 후 codex review skill 호출 (P1 이상 즉시 fix)
- M0-f 종료 후 Phase 4 = codex full-diff 리뷰 + claude code-reviewer 리뷰 (별도 세션 2회)

---

## [2026-05-12] 브랜치 전략 — 새 브랜치 안 만듦

**Background**: 팀 모드 기본은 `team/YYYY-MM-DD/<slug>` 브랜치 생성. 그러나 메모리 `project_m0_progress.md` 에 "PR #34 에 commit 추가" 방식 명시.

**Chosen**: 현재 브랜치 `feature/m0-b-handler-rewrite` 유지. M0-c/d/e/f 모두 같은 PR #34 에 commit 추가.

**Rationale**:
- 외부 리뷰어 (alphabeen, codex) 가 추적하는 단일 PR
- 메모리 `feedback_pr_strategy.md`: "외부 리뷰어 있는 ship 단위는 1 PR + commits"

**Impact**: 각 M0-X 완료 시 그 단계만의 commit 추가 (squash 안 함). force-push 금지.

---

## [2026-05-12] 실행 모드 — 순차 + 단일 backend-developer

**Background**: M0-c → M0-d → M0-e → M0-f 순서. 이론상 M0-d/M0-e 병렬 가능하나 같은 PR 단일 브랜치 → 충돌 회피 위해 순차.

**Chosen**: 순차 실행, 단계마다 새 teammate 스폰 (backend-developer, opus). worktree 안 씀.

**Rationale**:
- M0-d/M0-e 둘 다 SessionManager + pane.rpc 건드릴 가능성
- 단일 브랜치 commit 순서 보장
- 단계별 codex 리뷰가 자연스러운 commit boundary

**Impact**: 4 commit (각 단계당 1개) + codex P1 fix commit (있을 시) 추가.

---

## [2026-05-13] M0-f — wire-format error envelope deferred to future work

**Background**: M0-f spec 는 expectedVersion conflict 에 대해 JSON-RPC error code (-32001) + structured data (`{ currentVersion: N }`) 를 노출하길 권장. 그러나 `RpcRouter.dispatch()` 는 thrown Error 의 `.code` / `.data` 를 envelope 으로 전파하지 않고 `.message` string 만 사용한다.

**Chosen**: `RPC_VERSION_CONFLICT = -32001` 상수만 `src/shared/rpc.ts` 에서 export. 실제 throw 는 기존 string-message 패턴 유지 (`pane.setMetadata: VERSION_CONFLICT (currentVersion=N)`). 클라이언트는 메시지에서 `currentVersion=N` 을 파싱하여 retry.

**Rationale**:
- Router envelope 변경은 별도 commit scope (`{ id, ok, error, code?, data? }` 추가)
- M0-f 의 핵심 목표는 wire-format spec 화이며 envelope 진화는 다음 마일스톤
- v2.8.x 호환성 우선 — string error message 변경은 회귀 위험

**Impact**: Type-level surface 는 갖춰졌고, future commit 이 RpcResponse 에 optional `code` + `data` 를 추가하면 즉시 활용 가능. 메모리 `project_m0_progress.md` 에 후속 작업 메모.
