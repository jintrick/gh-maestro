---
source_url: https://github.com/openwong2kim/wmux/blob/main/TODOS.md
original_title: TODOS
fetched_at: 2026-05-30T16:00:11.079849+00:00
---

# TODOS

## Daemon reconnection retry on tray restore
- **What:** DaemonClient에 reconnection retry loop 추가
- **Why:** 트레이 복원 시 데몬이 아직 이전 shutdown 시퀀스 중일 수 있음. 현재 daemon.onConnected는 "늦은 연결"만 처리하고, "재연결"은 미지원. Outside voice가 지적한 레이스 컨디션.
- **Pros:** 트레이 UX의 안정성 확보. 창 닫기 → 즉시 다시 열기가 안정적으로 동작.
- **Cons:** DaemonClient에 retry loop + backoff 추가 필요 (~15분 CC 작업)
- **Context:** `src/main/index.ts` before-quit에서 daemon.shutdown RPC를 보내는데, 트레이 모드에서는 이걸 skip하게 변경 예정. 하지만 edge case(강제 종료, 데몬 크래시 후 재시작)에서는 여전히 reconnect가 필요.
- **Depends on:** 트레이 아이콘 구현

## Pane split max depth/count guard
- **What:** splitPane에 max leaf count 가드 추가 (예: 20개)
- **Why:** 무한 split 시 xterm.js 인스턴스 폭증 → 메모리 목표(200MB for 10 panes) 초과 가능
- **Pros:** 안정성 + 메모리 보호. 1줄 가드.
- **Cons:** 사용자에게 에러 메시지 표시 필요
- **Context:** `src/renderer/stores/slices/paneSlice.ts:46` splitPane 함수 시작 부분에 leaf count 체크 추가.
- **Depends on:** 없음 (즉시 가능)

## DESIGN.md 작성
- **What:** 디자인 시스템 문서 생성 (CSS 변수 목록, 스페이싱 스케일, 폰트, 컴포넌트 패턴)
- **Why:** 커뮤니티 테마 제작자가 어떤 변수와 패턴을 사용해야 하는지 알아야 함. 현재 디자인 결정이 themes.ts와 개별 컴포넌트에 흩어져 있음.
- **Pros:** 커뮤니티 테마 지원 용이, UI 일관성 유지, 새 컴포넌트 개발 시 참조
- **Cons:** 문서 작성/유지 비용
- **Context:** /design-consultation 스킬로 자동 생성 가능. 기존 themes.ts의 CSS 변수, StatusBar/Sidebar의 스타일 패턴에서 추출.
- **Depends on:** v1.0 출시 후

## destroyCompanyWithCleanup race condition
- **What:** PTY dispose가 완료되기 전에 store.destroyCompany()가 호출되는 레이스 컨디션 수정
- **Why:** dispose 중 UI 리렌더가 company === null을 만나 에러 가능성. 기존 inline 코드에도 동일한 문제가 있었음.
- **Pros:** company mode 종료 시 안정성 향상
- **Cons:** async/await 변환 필요
- **Context:** `src/company/renderer/provisioner.ts` destroyCompanyWithCleanup. await Promise.all(disposePromises) 후 destroyCompany() 호출하도록 변경.
- **Depends on:** 없음

## Member workspace PTY leak on company destroy
- **What:** company destroy 시 member workspace 내 분할된 pane의 PTY가 정리되지 않는 문제
- **Why:** m.ptyId만 dispose하고 workspace 내 다른 surface의 PTY는 무시됨
- **Pros:** 메모리 누수 방지
- **Cons:** collectLeafSurfaces로 workspace별 PTY 수집 로직 필요
- **Context:** `src/company/renderer/provisioner.ts` 및 기존 CompanyPanel.tsx의 destroy 로직
- **Depends on:** 없음

## (E3) Agent status dot transient flash on completed/waiting
- **What:** `agentStatusIcon.ts`/`MiniSidebar` dot animation을 `completed`/`waiting` 전환 시점에 한 번만 발화 (예: 2s flash). 현재 `running`만 `animate-pulse`이고 나머지는 정적.
- **Why:** wmux 창에 포커스가 있어도 측면 시야에서 변화를 잡을 수 있어야 함. inline toast가 transient라 놓치기 쉬움.
- **Pros:** 다중 agent 워크플로우에서 시각 신호 강화. CSS만으로 가능.
- **Cons:** 여러 workspace가 동시에 completed로 변하면 시각 노이즈. tuning 필요.
- **Context:** `src/renderer/components/Sidebar/agentStatusIcon.ts` className 매핑 + `MiniSidebar.tsx:133-140` / `WorkspaceItem.tsx:177-178`. `useEffect`로 status 변경 detect + setTimeout으로 transient class. CC 추정 15분.
- **Depends on:** validated-pondering-grove plan (알림 파이프라인 복구) ship 후 사용자 피드백
- **Priority:** P3 (cosmetic)

<!-- (E4) Per-workspace notification mute/snooze — DELIVERED 2026-05-22 in
     `team/2026-05-21/notification-system-expansion`. WorkspaceMetadata gained
     `notificationsMuted?: boolean`; SettingsPanel exposes a per-workspace mute
     list; `useNotificationPolicy` skips toast/sound/ring/flashFrame for muted
     workspaces while still recording the entry in the panel (policy A4). -->

## (E5) Tray icon unread badge (cross-platform)
- **What:** `src/main/tray.ts`에 unread count를 표시. macOS: `app.dock.setBadge(N)`, Windows: tray tooltip prefix `[N] wmux`, Linux: best-effort (NotificationServer 표준은 제한적).
- **Why:** wmux 창이 minimize/hide 상태에서는 OS 토스트 한 번 외에는 알림 신호 부재. tray가 영구 신호 채널.
- **Pros:** 창 안 열어도 unread 인지. macOS 사용자에게 자연스러운 UX.
- **Cons:** Cross-platform 차이 큼 — 3 OS에서 각각 QA 세션 필요. Linux fallback 정책 결정 필요.
- **Context:** memory `project_cross_platform_branch_policy` 정책에 따라 **feature branch + PR**로 진행. `src/main/notification/ToastManager.ts`와 같은 자리에 `TrayBadgeManager` 추가 고려. Renderer store unread count 변경 → main으로 push → tray 갱신. CC 추정 30-45분 + 3 OS QA.
- **Depends on:** 알림 파이프라인 복구 ship + 사용자가 minimize 사용 빈도 확인
- **Priority:** P2

## Fix B — Scrollback restore cap-aware suspended-session promote
- **What:** `daemon.listSessions`에 `{includeSuspended}` 파라미터 추가 + `daemon.promoteSession(id)` 신규 RPC. `AppLayout.reconcilePtys` fallback 직전에 promote 시도. cap=40 초과로 자동 복구되지 못한 suspended session도 reconnect 가능하게.
- **Why:** Fix 0 (mount gate + saved ptyId 보존)는 cap *안*의 graceful Quit session만 복원. cap *초과* session (50+ panes 사용자, 또는 force-kill 후 daemon snapshot은 살아있지만 cap에 밀린 case)은 여전히 fresh terminal. design doc §5 + Update에 spec.
- **Pros:** scrollback restore feature 100% 완성 (cap 안 + 초과 모두). power user 사용성 결정적.
- **Cons:** RPC 2개 추가 + dynamic test R2-R5 (cap-skipped promote 4 scenario). Effort ~3-4시간.
- **Context:** `docs/internal/scrollback-restore-design.md` §5 (Fix B) — full implementation sketch + failure modes + test matrix 이미 작성됨. 구현 시 그대로 따라가면 됨.
- **Depends on:** Fix 0 (plan `wiggly-booping-cascade.md`) ship + 최소 1주 dogfood. dogfood에서 stale-state / RPC guard / generation race 회귀 없는 것을 확인한 *후*에야 Fix B 진행 (한 번에 두 가지 architecture change 검증 어려움).
- **Priority:** P1 (Fix 0 dogfood 통과 후)

## (Phase 2 / Eureka) Agent stop-hook OSC 9 signal — promoted to design doc
- **Status:** Draft plan exists at `plans/agent-hook-integration.md` (209 lines).
  Covers PostToolUse/Stop/SubagentStop/SessionStart hooks + dedup with
  AgentDetector + marker-bounded `~/.claude/settings.json` editing + opt-in
  installer + ASAR-external bridge script. 7 hook items, ~700 LOC, dogfood-gated.
- **Why deferred:** substrate neutrality (`[[feedback_substrate_neutrality]]`) +
  no dogfood data justifying global config edit
  (`[[feedback_no_ship_without_user_verification]]`). The notification-system
  expansion shipped first; this is the next iteration after measured signal.
- **Depends on:** notification-system-expansion ship + ≥ 1 week dogfood + at
  least one of (false-positive rate / false-negative rate / user reports
  describing missed/wrong notifications that hooks would solve). If neither
  signal materializes within 4 weeks of merge, downgrade back to P3 idea.
- **Priority:** P1 (after measurement gate)

## (P3) CLI notify command
- **What:** `wmux notify --title X --body Y` CLI surface that triggers an
  in-app notification. External scripts can signal wmux directly.
- **Why:** Power-user request from external-advice-26-concepts review. MCP
  `send_message` partially covers this, but a one-liner CLI is more ergonomic
  for ad-hoc shell scripts.
- **Pros:** No new infrastructure — existing `sendNotification` helper +
  IPC route already exist. The CLI just shells into the daemon's named pipe.
- **Cons:** Yet another surface to maintain. Demand unproven.
- **Context:** Pattern matches existing `wmux` CLI subcommands. Hook into
  daemon RPC routes. CC ~20 min if scoped tight.
- **Depends on:** None.
- **Priority:** P3 (defer until user demand surfaces)

## (P3) findSurfaceByPtyId / findActiveLeaf dedup inside useNotificationListener
- **What:** `findSurfaceByPtyId` is defined twice and `findActiveLeaf` twice
  inside `src/renderer/hooks/useNotificationListener.ts` (lines 17, 32, 74,
  ~311 from quick scan). Extract to a single utility.
- **Why:** Minor DRY violation introduced during T8 refactor. The duplicates
  are identical closures; they exist because the file evolved without a
  cleanup pass.
- **Pros:** Easier maintenance. Small file size reduction.
- **Cons:** Touching the listener at all carries regression risk; isolated
  refactor + green test suite is required.
- **Context:** Extract to `src/renderer/utils/paneTraversal.ts`. The functions
  are pure and have no React/store dependencies. CC ~10 min.
- **Depends on:** None.
- **Priority:** P3 (purely a maintenance nit)

<!-- (P3) Pre-existing daemon ProcessMonitor flake — RESOLVED 2026-05-22.
     Root cause: watch() relied on the CHECK_INTERVAL_MS setInterval tick
     for the first probe; under CPU contention a 50ms interval + two tasklist
     execs (1-6s each) could exceed the test's 5s default it() timeout.
     Fix: watch() now triggers an immediate first runBatchCheck (production
     code) AND the test's outer it() timeout is bumped to 20s with a 15s
     vi.waitFor budget. Verified stable across 5 consecutive full-suite runs. -->

