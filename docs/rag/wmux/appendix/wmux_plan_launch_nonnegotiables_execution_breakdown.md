---
source_url: https://github.com/openwong2kim/wmux/blob/main/plans/wmux-nonnegotiables-execution-plan-2026-05-29.md
original_title: wmux-nonnegotiables-execution-plan-2026-05-29
fetched_at: 2026-05-30T16:00:11.379049+00:00
---

# wmux 출시 필수 과제(Non-Negotiables) — 실행 계획서 / 작업 분해

> 작성일: 2026-05-29 · 근거: 전략 보고서 `plans/wmux-number-one-terminal-strategy-2026-05-29.md` §5 · 방법: 6-영역 병렬 소스조사 워크플로우(영역별 general-purpose 에이전트가 `D:\wmux` 실제 코드를 file:line 검증) + 시퀀싱 비평
> 범위: 성장/런치 푸시 *이전에* 반드시 끝내야 하는 6개 필수 과제를 **41개 빌드 가능 task**로 분해. 각 task = id · 파일(file:line) · 변경 · effort · risk · 의존성 · 수용기준 · 테스트. 상세 원본은 `D:\wmux\.local-scratch\nn-{1..6}.json`, 교차검토는 `nn-critic.json`.
> 전제(소스 검증 완료): wmux는 릴리스에 `wmux-<ver>.Setup.exe`를 이미 발행(`release.yml:31-39`), SHA-256도 이미 계산(`release.yml:48-54`)하나 choco nupkg에만 주입. install.ps1·서명·AutoUpdater·partial-list reconcile·README보안문구의 갭은 전부 실재 확인.

---

## 0. 먼저 내려야 할 결정 (계획을 가르는 분기 — 권고안 포함)

| # | 결정 | 권고 (근거) | 영향 task |
|---|---|---|---|
| **D1 ⭐** | **NN1(미서명 exe 다운로드 기본화)을 NN2-T1 서명 전에 공개 런치할 것인가?** | **NN1 엔지니어링은 지금 진행하되, 성장/런치 푸시는 서명(NN2-T1) 착지 후로 게이트.** 미서명 다운로드 기본화는 SmartScreen 'Run anyway'를 그대로 유발 — 전략 §5가 엔터프라이즈 실격이라 부른 바로 그 패턴. 그 사이 SHA-256 핀(NN1-T3 / NN2-T3·T4)이 임시 무결성 바닥. | NN1 전체, NN2-T0/T1 |
| **D2** | install.ps1 `--from-source` 진입 방식 (`irm\|iex`는 인자 못 받음) | **`$env:WMUX_FROM_SOURCE=1` 환경변수 + `-FromSource` 스위치 병행**, 기본은 다운로드 | NN1-T1 |
| **D3** | 서명 공급자 | **SignPath.io Foundation(OSS 무료, 서버측 서명)** 우선 — 솔로/무자금에 최적. 캘린더 리드타임이 더 짧으면 Azure Trusted Signing(~$10/월, SmartScreen 평판 축적 빠름) | NN2-T0/T1 |
| **D4** | AutoUpdater 서명검증 정상상태 정책 | **토글 뒤에서 출시 → 모든 릴리스가 안정적으로 서명됨이 확인된 후 fail-closed 상시화.** 미서명 릴리스가 섞이면 업데이트가 막히므로 롤아웃 창에선 토글 | NN2-T5 |
| **D5** | EditorPanel Save | **버튼 숨김(NN5-T5-ALT)** — 거의 무위험. 임의 파일 쓰기 권한 확장(T5a)은 트러스트 바운더리 확대라 데모용으론 과함 | NN5-T5a/b vs T5-ALT |
| **D6** | ligature 렌더러 | **NN5-T2 스파이크 결과에 종속.** xterm ligature 애드온은 DOM 렌더러 전용(WebGL에서 no-op 가능성). 스파이크가 WebGL 비호환 확정 시 → 데모에서 ligature 제외 or 기본 Cascadia Code만 보장 (L 공수 가능성) | NN5-T1~T4 |
| **D7** | 토큰 엔트로피 문서 불일치 | **A: 문서 수정**(`UUIDv4/122-bit, 디스크 영속`)이 NN4 범위에 맞음. 엔트로피 강화 원하면 B: `crypto.randomBytes(32)` 코드 변경(med risk, 토큰 호환 회귀테스트 필요) | NN4-T5 |
| **D8** | 텔레메트리 동의 모델·엔드포인트·보존 | **명시적 default-OFF + 1회 동의 프롬프트**(silent default-OFF만이면 런치 퍼널 과소집계). 엔드포인트=프라이버시 친화 SaaS or 자체 집계기, 보존창=90일 권고 | NN6-T1/T4/T6/T7 |
| **D9** | winget vs squirrel 채널 구분 | 초기엔 winget을 'squirrel'에 folding 허용(단순) → 이후 winget 매니페스트 마커로 분리 | NN6-T2/T3 |

> ⭐ **D1이 마일스톤 구조를 결정한다.** 아래 계획은 권고안(NN1 엔지니어링 즉시 + 런치는 서명 게이트)을 전제로 시퀀싱했다.

---

## 1. 전체 작업 목록 (41 task)

| id | 제목 | effort | risk | dependsOn | 트랙/게이트 |
|---|---|---|---|---|---|
| **NN1 — install.ps1 펀널 (총 1-2d)** |
| NN1-T1 | `-FromSource`/env 진입 방식 결정·문서화 | s | med | — | 키스톤 |
| NN1-T2 | 최신 릴리스에서 Setup.exe 자산 URL 해석·다운로드 | m | med | T1 | |
| NN1-T3 | 다운로드본 SHA-256 검증(릴리스에 `.sha256` 사이드카 발행) | m | med | T2 | **safe-gate(무결성)** · release.yml 공유⚠ |
| NN1-T4 | 검증된 Setup.exe 실행 + 메시징 정리 | s | low | T2,T3 | |
| NN1-T5 | 소스빌드(clone+npm+rebuild+make)와 툴체인 자동설치를 `-FromSource` 뒤로 게이트 | m | **high** | T1,T4 | 회귀위험 — 늦게 |
| NN1-T6 | docstring '거짓말' 수정 + README 카피 일치 | xs | low | T1,T5 | |
| **NN2 — 코드서명 + 업데이트 무결성 (총 3-5d, 외부 인증서 리드타임 별도)** |
| NN2-T0 | [소유자/외부] 서명 신원 취득(SignPath OSS or Azure Trusted Signing) | m | high | — | **롱폴 — 즉시 시작, 엔지니어링 0** |
| NN2-T1 | make 단계에서 wmux.exe + Setup.exe 서명 | l | high | T0 | **런치 게이트(D1)** |
| NN2-T2 | 자동업데이트 아티팩트(.nupkg 내장 exe + RELEASES) 서명 + CI 미서명 가드 | m | med | T1 | |
| NN2-T3 | Setup.exe SHA-256를 `update-manifest.json`로 발행 | s | low | — | **safe-gate** · release.yml 공유⚠ |
| NN2-T4 | 업데이터: 디스크 다운로드 → SHA-256 핀 검증 → 실행(fail-closed) | l | **high** | T3 | **safe-gate(공급망)** |
| NN2-T5 | 업데이터: Authenticode 서명 검증(토글 뒤, 서명 후) | m | med | T4,T1,T2 | |
| NN2-T6 | 서명/무결성 문서 + 보안 불릿 일치 | xs | low | T1,T4,T5 | |
| **NN3 — 신뢰성 (총 2-3d, 3개 독립 트랙)** |
| NN3-T1 | reconcile 2-strike 재조회 가드(비어있지 않은 리스트 누락 ptyId 파괴 전 재조회) | m | med | — | **safe-gate(최우선 — 라이브 세션 파괴 경로)** |
| NN3-T2 | 2-strike 결정을 순수·주입가능 헬퍼로 추출(테스트성) | s | low | T1 | |
| NN3-T3 | `daemon.ping`에 event-loop lag 메트릭 추가(busy vs hung 구분) | s | low | — | Track2 |
| NN3-T4 | health-probe 강화: 3→5 / 3s→5s + busy 관용 | m | med | T3 | Track2 |
| NN3-T5 | health-probe 기존 테스트 갱신 + busy 매트릭스 | s | low | T4 | Track2 |
| NN3-T6 | 데몬측 localhost TCP fallback 리스너 + 포트파일(`~/.wmux-daemon-tcp-port`) | m | med | — | Track3(선결) |
| NN3-T7 | DaemonClient.connect TCP fallback(win32) | m | med | T6,T8 | Track3 |
| NN3-T8 | DaemonClient.connect 재시도+백오프+에러분류(EPERM/ECONNRESET=transient) | m | med | — | Track3(이것만으로 대부분 회복) |
| NN3-T9 | 통합테스트: transient connect 실패 end-to-end 회복 | s | low | T7,T8 | Track3 |
| **NN4 — 보안 문서/코드 불일치 (총 ~0.5d)** |
| NN4-T1 | README §6 'RunAsNode disabled' 거짓 수정 | xs | low | — | **safe-gate(유일한 명백 허위)** |
| NN4-T2 | asar 무결성 OFF 자세를 SECURITY.md에 명문화 | xs | low | — | |
| NN4-T3 | SECURITY.md §1.2 토큰-ACL 문구를 icacls 실제 의미로 정정 | xs | low | — | |
| NN4-T4 | 코드↔문서 교차참조 주석(드리프트 재발 방지) | xs | low | T1,T2,T3 | 맨 마지막 |
| NN4-T5 | 토큰 엔트로피 드리프트(256-bit vs UUIDv4) 결정·수정 | s | med | — | D7 |
| **NN5 — 데모 크레더빌리티 (총 1.5-2.5d, 2개 독립 트랙)** |
| NN5-T1 | `@xterm/addon-ligatures` 의존성 추가(xterm6 호환) | s | med | — | ligature 트랙 |
| NN5-T2 | WebGL vs ligature 렌더러 충돌 스파이크·결정 | m | **high** | T1 | **리스크 게이트** |
| NN5-T3 | LigaturesAddon를 애드온 라이프사이클에 로드 | m | med | T2 | |
| NN5-T4 | ligature+WebGL caveat 코드 주석 | xs | low | T3 | |
| NN5-T5-ALT | **[권고]** Save 버튼 제거(읽기전용 명확화) | s | low | — | editor 트랙(D5) |
| NN5-T5a | (대안) FS_WRITE_FILE를 비민감 임의파일로 완화 | m | **high** | — | T5-ALT와 배타 |
| NN5-T5b | (대안) Save 버튼을 fs.writeFile에 연결 | m | med | T5a | T5-ALT와 배타 |
| **NN6 — 퍼널 텔레메트리 (총 2-3d, 런치 안전게이트 아님)** |
| NN6-T1 | PII-free 이벤트 스키마 + 공유 타입 + `assertNoPii` | s | low | — | 기반 |
| NN6-T2 | 설치 시점 채널 마커 기록(4채널) | m | med | T1 | NN1과 충돌⚠ |
| NN6-T3 | ChannelDetector — 런타임 채널 해석 | m | med | T1,T2 | |
| NN6-T4 | TelemetryService — local-first 큐·동의 게이트·배치 전송 | l | med | T1,T3 | 코어 |
| NN6-T5 | activation/first-run/install 신호 훅포인트 배선 | m | med | T4 | |
| NN6-T6 | 동의 UI + IPC 브리지(opt-in 토글) | l | med | T4,T1 | |
| NN6-T7 | 프라이버시·데이터거버넌스 문서 + 엔드포인트 문서 | s | low | T1 | |

---

## 2. 의존성·병렬 트랙

```
[즉시·캘린더] NN2-T0 서명 신원 취득 ───────(엔지니어링 0, 며칠~몇 주 대기)──► NN2-T1 ► T2 ► T5

병렬 가능한 엔지니어링 트랙 (서로 disjoint 파일):
  A. NN1 펀널        : install.ps1 (+ release.yml 체크섬 — NN2-T3와 직렬화⚠)
  B. NN2 무결성      : src/main/updater/AutoUpdater.ts + release.yml(manifest)  [서명 불필요, 먼저 가능]
  C. NN3 신뢰성      : Track1=renderer/AppLayout · Track2=daemon+Controller · Track3=DaemonClient  (3개 내부도 독립)
  D. NN4 문서        : README + docs/SECURITY.md + PROTOCOL.md  (T4만 T1-3 뒤)
  E. NN5 데모        : ligature(useTerminal) · editor(EditorPanel)  (2 트랙 독립)
  F. NN6 텔레메트리  : T1→T3→T4→T5 (critical), T6·T7 병렬  [런치 후]

⚠ 공유 파일 충돌 — 직렬화 필수:
  • release.yml 체크섬/gh-release 구간: NN1-T3(.sha256 사이드카)와 NN2-T3(update-manifest.json)가
    같은 Get-FileHash(48-54)+files(34-37)를 건드림 → 하나의 CI 스텝으로 통합, 먼저 출시하는 쪽이 소유.
  • NN6-T2가 install.ps1 clone 직후(343) 'source' 마커를 쓰는데, NN1이 기본 경로에서 clone을 제거 →
    NN6-T2는 NN1의 -FromSource 분기에 종속되게 재작성(기본 다운로드 경로는 'squirrel'/squirrel-firstrun).
  • NN5-T5a 채택 시 렌더러 임의쓰기 확대 → NN4/SECURITY.md 갱신 필요(미계획 NN5→NN4 의존). T5-ALT면 무관.
```

---

## 3. 최소 안전 출시 게이트 (트래픽 전 반드시)

> 비평가 결론: **트래픽을 끌기 전 진짜 게이트는 다음 3.5개뿐.** 나머지는 런치 후 trailing 가능.

1. **NN3-T1 (+T2)** — partial-list reconcile 2-strike 가드. *오늘 라이브 세션을 파괴할 수 있는 최고 심각도 정확성 버그*(`AppLayout.tsx:458-467`), 렌더러 자체완결·저위험. **단일 최우선.**
2. **NN2-T3 + NN2-T4** — SHA-256 발행 + 업데이터 다운로드-검증-실행(fail-closed). 현재 업데이터는 미검증 바이너리를 그대로 실행(`AutoUpdater.ts:154`). 인증서 없이도 가능, 공급망 최대 갭 차단.
3. **NN4-T1** — 'RunAsNode disabled' 허위 1줄 수정. 유일한 명백 보안 허위.
4. **NN1(T1-T6) + 런치 게이트** — 펀널 거짓말 제거. **단, 미서명 다운로드 기본을 NN2-T1 서명 전에 GA하지 말 것**(D1). 서명이 늦으면 소스빌드 기본을 잠깐 더 유지하는 편이, SmartScreen 트리거하는 미서명 다운로드 펀널보다 낫다.

**런치 후 trailing 허용**: NN2-T0/T1/T2/T5 전체 서명(인증서 롱폴; SHA-256가 임시 바닥), NN3 Track2(health-probe 튜닝)·Track3(connect 재시도/TCP — TCP는 win32-EPERM 특화라 가장 미룰 만함), NN5 ligature+editor(데모 녹화만 블록, 라이브 트래픽 무관), NN4-T2~T5 문서 철저화, **NN6 전체**(성장 계측 — 안전 게이트 아님).

---

## 4. 마일스톤 (권고 시퀀스)

### M0 — "Day 0 즉시" (병렬, 엔지니어링 ~반나절 + 외부 착수)
- ▶ **NN2-T0** 서명 신원 취득 착수(외부 대기 — 가장 먼저 킥오프, 엔지니어링 자원 0)
- ▶ **NN4-T1** RunAsNode 허위 수정 (xs, 무위험, 무의존 — 즉시 신뢰 리스크 감소)
- ▶ **NN3-T1 → T2** reconcile 2-strike 가드 + 헬퍼 추출 (최고가치·저위험·자체완결)

### M1 — "안전 바닥" (M0와 겹쳐 진행)
- **NN2-T3 + NN2-T4** SHA-256 발행 + 업데이터 fail-closed 검증 (서명 불필요)
- **NN1-T1→T2→T3→T4→T5→T6** 펀널 수정 (T5 최고위험 — 기본 다운로드 경로 T2-T4 검증 후 착지). *NN1-T3는 NN2-T3와 release.yml 직렬화*
- **NN3 Track2** (T3→T4→T5) busy 데몬 오respawn 방지 — 병렬
- **NN3 Track3** (T8 먼저 → T6→T7→T9; 일정 빠듯하면 T8만, TCP는 보류)

### M2 — "서명 착지 시" (NN2-T0 인증서 도착 후, 비서명 트랙과 병렬)
- **NN2-T1 → T2 → T5** exe 서명 → 업데이트 아티팩트 서명 → 업데이터 Authenticode 검증(토글)
- **NN4-T2/T3/T5 → T4(맨 끝)** 문서 철저화
- **NN5** ligature 트랙(T1→T2 스파이크→T3→T4) + editor 트랙(T5-ALT 권고)
- ✅ **여기서 공개 런치 게이트 충족** (서명 + 펀널 + 신뢰성 + 데모)

### M3 — "런치 후 / 성장 계측"
- **NN6 전체** (T1→T3→T4→T5, T6·T7 병렬) — 채널 분포·활성화율 측정 시작 (NN1과 채널마커 재조율 필수)

---

## 5. 영역별 핵심 검증 사실 (요약 — 상세는 `.local-scratch/nn-*.json`)

- **NN1**: `install.ps1:303-307` 릴리스 API에서 `tag_name`만 읽음 → `339-343` git clone → `354-369` 풀 소스빌드 → `202-295` VS BuildTools 무조건 프로비저닝. docstring(5) "Downloads and installs"는 거짓. 릴리스 자산명 `wmux-<ver>.Setup.exe` 결정적(`forge.config.ts:21`). `irm|iex`는 param 못 받음 → env var 필요.
- **NN2**: CI에 Authenticode 0(`release.yml`). SHA-256는 계산되나 choco에만(`63`). `AutoUpdater.ts:154`는 미검증 URL `shell.openExternal`. `update.electronjs.org` JSON엔 hash 필드 없음 → 사이드카 manifest 필요. forge 7.11은 `packagerConfig.windowsSign` 지원.
- **NN3**: `AppLayout.tsx:424-427` 빈-리스트 가드 OK / `458-468` partial-list 파괴적 clear 여전히 열림(재조회 없음). `DaemonRespawnController.ts:79-87` 기본 3/3000. `daemon.ping`(764-769)에 lag 메트릭 없음. `DaemonClient.connect:44-77` 단발·재시도/TCP 없음. **데몬 제어전송은 named-pipe 전용**(TCP 리스너 없음 → T6 선결). 재사용 패턴: `reconnectPtyWithRetry.ts`(backoff [400,900,1500]), `shared/timeouts.ts`(single-source), `wmux-client.ts`(TCP fallback 참조).
- **NN4**: `README.md:133` 'RunAsNode disabled' vs `forge.config.ts:178` `true`(유일 명백 허위; 정당화는 코드 주석 175-177에 이미 존재). asar 무결성 OFF(184)는 문서 미기재. SECURITY.md §1.1(디렉터리 icacls 철회)는 **정확** — icacls는 토큰파일에만 매 로드 실행(`security.ts:65`, RCA A12). PROTOCOL.md:336 '256-bit'는 실제 `randomUUID`(122-bit) — 드리프트.
- **NN5**: ligature 애드온 미설치(`package.json:77-82`). 터미널/애드온 생성은 `useTerminal.ts:195-220`, WebGL 지연로드 `261-281`(컨텍스트 cap 설계 256-260). **ligature 애드온은 DOM 렌더러 전용 → WebGL no-op 가능성(핵심 리스크)**. 기본폰트 Cascadia Code(ligature 가능)만 번들. EditorPanel Save 하드 비활성(`EditorPanel.tsx:114-122`). `FS_WRITE_FILE` 핸들러 존재하나 basename `CLAUDE.md`로 잠김(`fs.handler.ts:143`).
- **NN6**: 제품 텔레메트리 전무(usage meter 토글만 존재). 4채널 모두 마커 미기록. activation 신호 후보: `McpRegistrar.getStatus`, `AgentDetector`(콘텐츠 미캡처 불변식 — 반드시 보존), `SampleTaskRunner`/`FirstRunOrchestrator`. IPC/preload/consent 패턴은 firstRun·usage 토글 미러링. local-first 저장 `~/.wmux`(atomicWriteJSON).

---

## 6. 비코드 산출물 (별도 추적 — 어떤 분해에도 없음)
- **20-30초 모션 데모** (Claude Code+Codex+Gemini 3-pane, 하나가 실제 브라우저 구동, 완료가 OSC-133로 표면화) — README GIF + 랜딩. **NN5/NN6 모두 코드범위 밖이라 명시적으로 누락** → 별도 자산 제작 task로 추적해야 조용히 슬립 안 함.
- 랜딩 페이지(`wmux.dev` 등) + Show HN/r/ClaudeAI 런치 조율 + Sponsors/FUNDING.yml — 전략 §6 GTM, 코드 외.

## 7. 시퀀싱 리스크 (비평가 적출 — 계획에 반영됨)
- **NN1 GA가 미서명이면 SmartScreen 그대로** → D1 게이트로 해소.
- **release.yml 이중 체크섬**(NN1-T3 ↔ NN2-T3) → 단일 CI 스텝 통합.
- **NN6-T2가 NN1의 새 기본경로를 오라벨** → NN1 -FromSource 분기 종속으로 재작성.
- **NN2-T5 fail-closed 브릭 위험** → 토글 + 정상상태 정책(D4) 사전 결정.
- **NN1-T5 회귀**(소스빌드 깨짐) — install.ps1 자동테스트 부재 → 최소 PSScriptAnalyzer + mock-download dry-run CI 추가 권고.
- **NN3-T1 2-strike 백오프가 RECONCILE_TIMEOUT_MS(15s) 예산 초과 금지** → 예산 단언 추가.
- **NN3-T8 connect 재시도 × Controller respawn 백오프 이중 백오프** → 수치 상한 명시(T9에서 단언).
- **NN5-T2 스파이크가 WebGL 비호환 확정 시 ligature는 S/M가 아니라 L** → 폴백(Cascadia Code 기본 수용 or 데모서 ligature 제외) 준비.

---

## 8. 지금 당장 (Next actions)
1. **D1·D3·D5·D8 결정 확정** (서명 게이트 / 공급자 / Save / 텔레메트리 동의) — 나머지 결정은 권고 기본값으로 진행 가능.
2. **NN2-T0 서명 신원 취득 착수** (외부 롱폴 — 오늘 시작).
3. **M0 3종 즉시 구현 가능**: NN4-T1(허위 1줄) · NN3-T1+T2(라이브 세션 파괴 경로 차단) · NN2-T3+T4(업데이터 fail-closed) — 전부 인증서 불필요.

> 어느 것이든 바로 착수 가능: ① M0 세트 구현(브랜치+PR), ② NN1 펀널 수정, ③ NN3-T1 2-strike 가드 구현 + 테스트, ④ release.yml 통합 체크섬 스텝. 지시 주시면 해당 task의 코드 작업을 시작합니다.

---

## 9. 구현 상태 (2026-05-29, 브랜치 `team/2026-05-29/launch-non-negotiables`)

전체 vitest **2049/2049 통과(162 파일), 회귀 0.** 인증서가 필요 없는 항목은 전부 구현·테스트·로컬 커밋 완료. push/PR은 사용자 승인 대기로 보류.

| 영역 | 상태 | 커밋 / 비고 |
|---|---|---|
| **NN3-T1/T2** partial-list 2-strike 가드 | ✅ 완료 | `reconcileWithReQuery.ts`(순수 헬퍼) + AppLayout 배선 + 8 테스트. **안전게이트 최우선** |
| **NN2-T3/T4** 업데이터 fail-closed SHA-256 | ✅ 완료 | `verifyUpdate.ts`(11 테스트) + AutoUpdater 다운로드-검증-실행 + release.yml `update-manifest.json` |
| **NN4-T1** README RunAsNode 허위 | ✅ 완료 | |
| **NN3-T8** connect 재시도+분류(A6) | ✅ 완료 | `daemonConnectRetry.ts`(순수) + DaemonClient + 14 테스트 |
| **NN3-T3/T4/T5** health-probe(A4) | ✅ 완료 | daemon.ping eventLoopLagMs + DEFAULTS 5/5000 + busy 관용 + 2 신규 테스트 |
| **NN4-T2/T3/T4/T5** 문서/코드 보안 일치 | ✅ 완료 | SECURITY.md §1.2/§1.4, PROTOCOL.md 토큰, 코드 교차참조. (T5=문서수정 옵션A) |
| **NN5-T5-ALT** EditorPanel Save 숨김 | ✅ 완료 | |
| **NN1** install.ps1 다운로드 기본화 | ✅ 구현(PS AST 파싱검증) | 소스빌드 `-FromSource`/`WMUX_FROM_SOURCE` opt-in. **⚠ 깨끗한 Windows VM end-to-end 검증 필요** |
| **NN3-T6/T7** 데몬 TCP fallback | ⏸ 보류 | win32-EPERM 특화·데몬 TCP 리스너 신설 필요. 비평가도 "가장 미룰 만함". T8이 회복력 대부분 제공 |
| **NN2-T0/T1/T2/T5** Authenticode 서명 | ⏸ 보류 | **외부 인증서(SignPath/Azure) 취득 = 소유자 작업.** 서명 인프라는 인증서 도착 후. SHA-256 핀이 임시 무결성 바닥 |
| **NN5-T1~T4** ligature | ⏸ 보류 | xterm ligature 애드온이 WebGL 비호환 가능성 → **GUI 런타임 스파이크(T2) 필요**, 헤드리스 불가. 결과에 따라 L 공수 |
| **NN6** 텔레메트리 7 task | ⏸ 보류 | 런치 안전게이트 아님(성장 계측). 엔드포인트/보존/동의 = 소유자 결정 필요. 대형(2-3d) |
| 모션 데모 자산 | ⏸ 보류 | 비코드 산출물 |

**남은 게이트:** 공개 런치 전 D1(서명 게이트) 결정 + NN2 서명 착지 + NN1 VM 검증 + 모션 데모. 그 외 안전게이트(신뢰성·무결성·문서)는 이 브랜치에서 충족.

**커밋 9개** (안전게이트 3.5 + 신뢰성 하드닝 + 문서 + 펀널). 다음: 사용자 승인 시 push + PR(필요 시 영역별 분할), 또는 보류 항목(서명·ligature 스파이크·NN6) 착수.
