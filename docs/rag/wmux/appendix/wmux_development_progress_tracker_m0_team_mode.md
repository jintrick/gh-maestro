---
source_url: https://github.com/openwong2kim/wmux/blob/main/progress.md
original_title: progress
fetched_at: 2026-05-30T16:00:11.034969+00:00
---

# Progress Tracker — M0-c/d/e/f Team Mode

## Summary
- **Phase**: 0 (Init complete) → 3 (Implementation) 진입
- **Started**: 2026-05-12
- **Branch**: `feature/m0-b-handler-rewrite` (PR #34)
- **Base**: `main` (PR #34 merge target)
- **Size**: Large (Full Path, Phase 1·2 skip)
- **Effort**: 1-1.5일 (4 단계 + 단계별 codex + 최종 2회 리뷰)
- **Mode**: 순차 (worktree 안 씀)
- **Done**: 4/4 | In Progress: 0 | Waiting: 0 | Blocked: 0

## DAG
```
M0-c (pane.list snapshot integration):    []
M0-d (paneSlice mirror-only):              [M0-c]
M0-e (SessionManager persist-then-publish): [M0-c]
M0-f (wire-format additions):              [M0-c, M0-d, M0-e]
```

순차 실행 (M0-d / M0-e 병렬 X — 같은 브랜치 충돌 회피).

## Phases
- [x] Phase 0: Init (decisions, progress, handoff 생성)
- [ ] Phase 3: Implementation
  - [ ] M0-c → codex review → P1 fix (필요 시)
  - [ ] M0-d → codex review → P1 fix
  - [ ] M0-e → codex review → P1 fix
  - [ ] M0-f → codex review → P1 fix
- [ ] Phase 4: 최종 리뷰 (2회)
  - [ ] Codex full-diff review (별도 세션, P1+P2 모두)
  - [ ] Claude code-reviewer agent (별도 세션, opus)
- [ ] Phase 5: 마무리 (테스트 전체 / 머지 옵션)

## Tasks

### M0-c — `pane.list` snapshot integration
- **Owner**: backend-developer (opus)
- **Files**:
  - `src/main/pipe/handlers/pane.rpc.ts` — `pane.list` handler
- **Spec**:
  - Handler 응답 envelope: `{ asOfSeq, bootId, panes: [{ ...paneInfo, metadata, version }] }`
  - `asOfSeq` + `bootId` 는 이미 v2.8.0 envelope. metadata + version 만 추가.
  - `MetadataStore.snapshot()` 호출하여 paneId → metadata + version map 빌드
  - paneId 매칭 안 되는 entry 는 metadata/version 없이 (또는 빈 객체 + version 0)
- **Tests** (~2):
  1. `pane.list snapshot ≡ MetadataStore` — list 결과의 metadata + version 이 store.get() 와 일치
  2. `stale renderer 아님` — burst write 후 list 가 최신 version 반환
- **검증**: `npm test` 전체 통과 (1019 → 1021+) + tsc clean

### M0-d — paneSlice mirror-only conversion
- **Owner**: frontend-developer (opus)
- **Files**:
  - `src/renderer/stores/slices/paneSlice.ts`
- **Spec**:
  - metadata write 로직 제거 (M0-b 이후 거의 비어있을 것)
  - paneSlice 가 metadata write API 노출 안 함 (compile-time write protect)
  - `pane.metadata.changed` event subscriber 만 유지 → mirror only
- **Tests** (1):
  1. paneSlice 가 direct metadata write export 안 함 (type-level guard or runtime throw)
- **검증**: 회귀 0 + tsc clean

### M0-e — SessionManager persist-then-publish + hydrate
- **Owner**: backend-developer (opus)
- **Files**:
  - `src/main/session/SessionManager.ts`
  - `src/main/pipe/handlers/pane.rpc.ts` (write 순서)
- **Spec**:
  - `MetadataStore.set() → SessionManager.persist() → EventBus.publish()` 순서
  - SessionManager 가 `MetadataStore.serialize()` 호출하여 metadata + version + schema_version 포함하여 저장
  - hydrate 시 `MetadataStore.hydrate(serialized)` 호출
- **Tests** (2):
  1. `persist-then-publish` — persist 실패 시 publish 안 됨 (race spec #1)
  2. `crash window` — persist 도중 죽으면 다음 hydrate 시 마지막 atomic write 까지 복원
- **검증**: 회귀 0 + tsc clean

### M0-f — wire-format additions
- **Owner**: fullstack-developer (opus)
- **Files**:
  - `src/shared/rpc.ts` — setMetadata params: expectedVersion, mergeMode + VERSION_CONFLICT (이미 M0-a 에 일부)
  - `src/shared/events.ts` — `PaneMetadataChangedEvent.version` (이미 optional 추가됨, 정리)
  - `src/main/pipe/handlers/system.rpc.ts:36` — `features.paneMetadata` 객체화 `{ optimisticConcurrency, mergeModes }`
  - `src/preload/index.ts` — pane.setMetadata 단방향화 + wire-format
  - `src/renderer/hooks/useRpcBridge.ts` — wire-format
  - `src/mcp/index.ts` — pane_set_metadata tool description 업데이트
- **Tests** (3+):
  1. wire-format 회귀 가드 (RPC schema)
  2. `features.paneMetadata` 객체화 (truthy 호환)
  3. v2.8.x client `merge: false` → 'replace' 변환 호환
- **검증**: 회귀 0 + tsc clean

## Codex Review Gates
| 단계 | Codex review | Status |
|------|--------------|--------|
| M0-c commit | 단계별 (skill: codex review) | pending |
| M0-d commit | 단계별 | pending |
| M0-e commit | 단계별 | pending |
| M0-f commit | 단계별 | done (1028 tests pass, tsc clean) |
| Final | codex full-diff (별도 세션) | pending |
| Final | claude code-reviewer (별도 세션) | pending |

## Notes
- 기준 테스트: 1019 pass (baseline) → 1028 pass after M0-f (+10: 6 pane.rpc M0-f + 4 system.rpc)
- 회귀 0 mandatory. tsc clean, eslint 0 errors.
- PR #34 force-push 금지. 새 commit 만 추가.
- 사용자 확인 필요: `git push` 전 반드시 (memory `feedback_push_confirm.md`)
- PR body + commit message + 코드 주석 모두 영어 (memory `feedback_pr_commit_english.md`)
