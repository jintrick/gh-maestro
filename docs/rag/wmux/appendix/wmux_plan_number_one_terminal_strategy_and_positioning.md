---
source_url: https://github.com/openwong2kim/wmux/blob/main/plans/wmux-number-one-terminal-strategy-2026-05-29.md
original_title: wmux-number-one-terminal-strategy-2026-05-29
fetched_at: 2026-05-30T16:00:11.388024+00:00
---

# wmux를 "1위 터미널"로 만드는 길 — 전략 보고서

> 작성일: 2026-05-29 · 대상 버전: v2.14.0 · 방법: 20-에이전트 멀티 워크플로우(내부감사 5축 + 경쟁리서치 5세그먼트 + 전략테제 4종 + 투자심사 채점 + 적대적 CEO 검증 + 완전성 비평), 핵심 사실은 `D:\wmux` 소스 line-level 검증
> 한 줄 결론: **"종합 1위 터미널"은 구조적으로 불가능하다. 그러나 "Windows에서 AI 코딩 에이전트를 여러 개 돌리는 1위 터미널/콕핏"이라는 카테고리는 현재 무주공산이며 2~3년간 방어 가능하다 — 거기서 1위가 되는 것이 유일하게 이길 수 있는 1위다.**

---

## 0. 임원 요약 (먼저 읽으세요)

**상황(S).** wmux는 v2.14.0까지 58개 태그를 거쳐 진짜로 희소한 기술 자산 두 개를 만들었다: ① CDP 기반 브라우저 자동화(47+ `browser_*` MCP 툴, React 제어입력·CJK·DNS-rebinding SSRF 방어 — 수주~수개월짜리 작업), ② 데몬 측 OSC 133 시맨틱 이벤트 로그(exit code까지 붙은 `agent.lifecycle`, 데몬 재기동에도 생존). 이건 "LSP-for-terminals"라는 말이 코드로 실재하는 부분이다.

**문제(C).** 그런데 목표가 "1위 터미널"로 잡혀 있다. 내부감사 5명 중 5명, 경쟁리서치 5명 전원, 그리고 적대적 CEO 검증자가 **독립적으로 같은 결론**에 도달했다: 종합 1위는 죽은 목표다. wmux는 Electron(메모리·콜드스타트 세금 구조적), Windows 전용(macOS/Linux 코드 경로는 CI에서 한 번도 실행된 적 없음 — informational 표기), 코드서명 없음, ligature/SSH/프로파일/설정파일 없음. 상대는 OS 기본 탑재 Windows Terminal(무료·서명·선탑재), 네이티브 Ghostty/WezTerm/Alacritty(2~3ms 레이턴시, 30~45MB), $73M Warp다. 솔로 메인테이너(주 8~12시간 무급)가 이 축들에서 동시에 이길 길은 없다. 그리고 그 축들 중 일부(레이턴시·유휴 RSS·네이티브 도달)는 **유일한 해자인 Chromium/CDP 스택을 지우지 않는 한 고칠 수 없다.**

**질문(Q).** 그럼 무엇의 1위가 되어야 하는가? 어떻게?

**답(A).**
1. **카테고리를 재정의한다.** "1위 = 'Windows에서 WSL 없이 Claude Code/Codex/Gemini를 여러 개 병렬로 돌리는 가장 추천받는 방법'." 이 슬롯은 현재 **비어 있다**(Ghostty/Kitty/cmux는 Windows 미지원, psmux는 MCP·브라우저 없음, Warp는 범용·클라우드 의존). 측정 가능하고, 솔로가 12개월 내 도달 가능하며, 2~3년 방어 가능하다.
2. **전략 = Thesis D(유통 우선)를 0~6개월 척추로, Thesis A(포지셔닝 "Windows 에이전트 콕핏")를 서사로, Thesis B(서브스트레이트/프로토콜)를 12~24개월 병렬 해자 트랙으로. Thesis C(크로스플랫폼)는 기각.** (4개 테제 채점: A 71 / D 68 / B 47 / C 33)
3. **성장 푸시 전에 반드시 고쳐야 하는 6개 — 전부 소스로 검증됨**: ① install.ps1의 거짓말(소스 빌드) ② 코드서명 + 자동업데이트 무결성 ③ partial-list reconcile 파괴적 clear(아직 열려 있음) + 데몬 health-probe/재연결 강화 ④ README↔코드 보안 불일치(RunAsNode) ⑤ 모션 데모 ⑥ 퍼널 텔레메트리.
4. **가장 날카로운 통찰**: wmux는 자기 서브스트레이트가 대체하려고 만든 바로 그 휴리스틱 위에 제품을 얹어 놨다(Company mode가 OSC-133 이벤트를 두고 글자(❯) 감시 + `setTimeout(8000)` + 자연어 프롬프트 주입을 쓴다). "자기 서브스트레이트를 먹어라(eat your own substrate)" — 이 한 수가 가장 깊은 기술 자산을 가장 눈에 띄는 제품 주장으로 바꾼다.

**가장 큰 위협**: IDE 내장 멀티에이전트(VSCode 1.109·Cursor·Windsurf, 전부 2026 Q1; 개발자 75.9%가 VS Code에 산다 — **existential 등급**). wmux의 진짜 싸움은 다른 터미널이 아니라 "에디터가 터미널 카테고리를 통째로 삼키는 것"이다.

---

## 1. "1위"의 정직한 재정의

"1위 터미널"은 세 가지 전혀 다른 주장으로 쪼개진다. 솔직하게 분리하지 않으면 전략 전체가 망가진다.

| 해석 | 도달 가능성 | 이유 |
|---|---|---|
| **종합 1위 터미널** (설치 기반·레이턴시·범용) | ❌ 불가능 | OS 기본 Windows Terminal(103K★, 선탑재), 네이티브 Ghostty(55K★, 2ms), $73M Warp. Electron·Windows전용·미서명이 동시에 발목. |
| **1위 Windows 터미널** | ❌ 불가능 | Windows Terminal이 기본 탑재. 전환 비용 0을 이길 수 없다. |
| **1위 "Windows AI-에이전트 터미널/오케스트레이션 콕핏"** | ✅ **가능·방어 가능(2~3년)** | 경쟁자 전원이 이 교집합에 구멍이 있다. wmux만 (agent-aware + multiplexer + browser + session-daemon)을 Windows에서 전부 가진 유일점. |

**시장 규모(추정, ±후술 주의)**: 종합 터미널 시장 $5.6B~$16B(승자독식 아님) vs. 정직한 니치 **$500M~$2B**. Windows에서 2~5개 에이전트를 병렬 구동하는 개발자 **5만~20만 명**(추정). 작지만 무주공산이고 상향(에이전트 채택 곡선)이 가파르다.

> **이게 후퇴가 아니라 집중이다.** Vertical SaaS는 23.9% CAGR로 수평 도구를 능가한다. "깊은 니치를 소유"하는 것이 "넓은 점유율"을 이긴다. Ghostty(macOS 성능)·Kitty(Linux)·cmux(macOS AI)는 모두 플랫폼 전문가다. wmux의 플랫폼+용도 전문화는 같은 플레이북이다.

---

## 2. 경쟁 지형 — 진짜 전장은 "다른 터미널"이 아니다

리서치 5세그먼트가 드러낸 구조: wmux의 진짜 경쟁군은 **AI 에이전트 오케스트레이션 도구**이지, 다른 터미널 에뮬레이터가 아니다.

### 2-1. 위협 등급 정리 (리서치 종합)

| 경쟁자 | 분류 | wmux 위협 | 핵심 |
|---|---|---|---|
| **IDE 내장 멀티에이전트** (VSCode 1.109 / Cursor / Windsurf) | 에디터 | 🔴 **존재론적** | 2026 Q1 전부 출시. 개발자 75.9%가 VS Code에 거주. "별도 터미널을 아예 안 연다"가 카테고리 자체를 축소. |
| **Windows Terminal** (MS, 기본 탑재) | 인커번트 | 🔴 **존재론적** | 103K★, Win11 선탑재, 무료·서명. MS가 세션 영속성·에이전트 인지를 추가하면 즉시 위협. |
| **Warp** ($73M, 2026-04 오픈소스) | AI 터미널 | 🟠 high | 700K 유저(추정·출처 불일치), Windows 지원(출처 불일치), 엔터프라이즈 SSO/spend. 단 멀티플렉서·세션데몬·브라우저 자동화 없음. |
| **psmux** (Rust, Windows 네이티브, 2026-02) | 멀티플렉서 | 🟠 high | **wmux의 정확한 니치를 직격**. tmux 호환, 네이티브, SmartScreen 부담 0. 단 MCP·브라우저·관측성 없음. 6~12개월 내 MCP+세션영속 패리티 도달이 핵심 리스크. |
| **VS Code 통합 터미널** | 에디터 | 🟠 high | 75.9% 도달. 단 세션 영속·진짜 멀티플렉싱 없음. |
| **WezTerm** | 네이티브 멀티플렉서 | 🟠 high | 유일한 진짜 크로스플랫폼 멀티플렉서. AI 없음. OSC133+에이전트 사이드바를 붙이면 직접 대체재. |
| **LangGraph / Composio / Conductor / Emdash / Nimbalyst** | 에이전트 오케스트레이터 | 🟠 high~medium | $260M·$29M·MS백업·YC백업. 단 Windows 네이티브 터미널·브라우저 자동화 없음. git-worktree 오케스트레이션은 이미 표준화 중(wmux엔 코어에 없음 — 갭). |
| **Ghostty / Alacritty / Kitty** | 네이티브 고성능 | 🟢 low | 성능의 바(2~3ms/30~45MB)를 세움. 그러나 Windows 미지원 + 멀티플렉서/AI 아님. wmux를 직접 대체 못 함. |
| **Cursor / Claude Code / Copilot** | 에이전트 자체 | 🟢 none~tailwind | Claude Code 성공 = wmux 순풍(수요 창출). 단 Anthropic이 1st-party 오케스트레이션을 내면 wmux 상품화 위험. |

### 2-2. 시장이 가는 방향 (puck)

- **"터미널이 에이전트를 실행"에서 "터미널이 에이전트를 오케스트레이션"으로** 이동. 멀티플렉싱은 table-stakes로 상품화되고, 차별화는 *MCP로 무엇을 할 수 있는가*(브라우저 자동화·오케스트레이션·승인 게이트)로 이동.
- **MCP는 이미 table-stakes**(2026, 9,400+ 서버·+58% QoQ). 자동 등록은 더 이상 차별점이 아니라 입장료. **차별점은 그 위에서 무엇을 하느냐.**
- **git-worktree 격리**가 병렬 코딩 에이전트의 기대 표준이 됨(Composio·Bernstein·Emdash 전부 구현). **wmux 코어엔 없음 → 갭.**
- **A2A 1.0**(Linux Foundation, 150+ 조직)이 위에서 "에이전트/터미널 구동" 인터페이스를 표준화 중. → wmux의 **독자 와이어 프로토콜이 표준에 흡수당하면 "아무도 안 겨냥하는 사투리"가 될 위험.**
- 결론: 2027까지 **에이전트-중심 멀티플렉서는 2~3개로 통합**. 살아남는 조건 = (a) Windows 네이티브/우선, (b) 브라우저 인지, (c) 세션 영속, (d) MCP 통합, (e) 페이월/IDE 락인 없음. **wmux는 이 묘사에 들어맞고, psmux가 바짝 뒤따른다.**

---

## 3. wmux 자산·약점 — 냉정 진단 (내부감사 5축 종합)

### 3-1. 진짜 해자 (weekend-cloneable 아님, 소스 확인됨)

1. **CDP 브라우저 자동화** — `src/mcp/playwright/`. 47+ 툴, `browser_trace`/`network`/`response_body`/`extract_data`, 멀티세션. React 제어입력+CJK, `navigationPolicy.ts`의 **resolution-time DNS-rebinding 방어**(literal-IP 차단이 아니라 resolve 후 모든 A/AAAA 레코드 재검증). 에이전트가 사용자의 로그인된 브라우저를 모는 상황의 위협에 맞춘 `security.ts`(위험 JS·민감 도메인 게이팅). → **전환의 단일 최강 이유.**
2. **데몬 측 OSC 133 시맨틱 이벤트 로그** — `src/daemon/shell-integration.ts`(INTEGRATION_VERSION=3). PSReadLine/PROMPT_COMMAND 훅, `$?`/`$LASTEXITCODE`를 프롬프트 첫 구문으로 스냅샷(VS Code/Windows Terminal을 무는 exit-code-reset 함정 회피). byte-offset 인덱싱된 `PromptEventLog` → `terminal_read_events` + `agent.lifecycle`(exitCode 포함, 데몬 재기동 생존). → **"LSP-for-terminals"의 코드 실재.**
3. **데몬 기반 세션 영속성** — RingBuffer 원자적 덤프, `FLUSH_DONE_MARKER` 프로토콜, 앱 재시작+리부팅 생존. 복제 난이도 높음.
4. **자동 등록 MCP** — `McpRegistrar.ts`가 `~/.claude.json`에 원자적 기록, 업그레이드 시 stale 경로 덮어쓰기, 프로토타입 오염 가드. "Claude Code가 그냥 된다"는 활성화 순간. (단 개념 자체는 복제 가능.)
5. **동결된 semver 계층 와이어 계약** — `PROTOCOL.md` + `tsc`로 totality 강제되는 96-method capability map + 승인 큐. **솔로 프로젝트에서 극히 희귀한 규율** — 그 자체가 전환비용 해자의 씨앗.

### 3-2. 진짜 약점 (정직하게)

- **정체성 혼동**: 마케팅은 "tmux 대안/멀티플렉서", 시장은 "오케스트레이터". 헤드라인 자산(브라우저·MCP·A2A)이 정적 스크린샷 한 장에 **안 보인다.**
- **모트 오배치(mis-housed)**: 최강 자산(브라우저 브리지)은 터미널과 독립적으로 가치 있는데 무거운 Electron 앱 전체를 켜야만 닿는다. 경쟁자가 동일 브리지를 **standalone MCP 서버로 출시하면 번들 명분이 사라진다.**
- **Company mode/A2A는 해자가 아니다(데모웨어)**: `CompanyView.tsx` 라우팅 컴포넌트는 문자 그대로 `return null`(실제 321줄 UI는 별도로 존재하나 레거시 스텁이 남아 혼란). 오케스트레이션은 `waitForClaudeReady` 글자 감시 + `setTimeout(8000)` + `/plan` PTY 붙여넣기 + "[WMUX-MSG]를 직접 출력하지 마세요" 자연어 애원에 의존. **다중 시간 실행을 못 버틴다.** A2A 태스크 상태는 렌더러 Zustand에 있고 30분 후 GC·500개 cap → **재시작 시 진행 중 상태 소실**(오케스트레이션 플랫폼엔 치명적).
- **@wmux/orchestrator SDK가 리포에 없다** — 마케팅하는 개발자-대면 API가 소스 검증 불가능한 외부 npm 패키지. **플랫폼의 정문이 블랙박스.**
- **table-stakes 갭**: ligature 없음, sixel/이미지 프로토콜 없음, 셸 프로파일 런처 없음(Windows Terminal의 킬러 기능), SSH 없음, 버전관리 가능한 설정파일 없음(GUI 전용 — dotfiles 파워유저 배제), EditorPanel Save 하드 비활성(미완성 신호).
- **퍼널/유통이 윗단에서 새는 중**(아래 §6).
- **신뢰성 이야기가 어리다**(아래 §6, §10).
- **수익화·자금 0**: Sponsors도, pro/team 티어도, 라이선스 인프라도 없음. 솔로 메인테이너 주 8~12시간 무급. **버스 팩터 = 가장 깊은 모트 자산(데몬·권한게이트·신원해소)에 집중.**

### 3-3. 솔직한 모트 평가 (시간 한정)

> **2-layer, 비대칭, 2~3년 한정.** 내구층 = OSC-133 이벤트 로그 + CDP 브라우저(둘 다 복제 난이도 높음). 위치층 = AI-DNA 보유자(Warp·IDE)는 멀티플렉서/세션데몬이 아니고, 멀티플렉서 DNA 보유자(psmux·Zellij·WezTerm)는 브라우저·자동MCP·관측성이 없다. wmux만 교집합. **단 영원하지 않다** — psmux가 갭을 닫거나 IDE가 카테고리를 삼키기 전에 **커뮤니티 기본값 지위 + 전환비용(MCP·세션·worktree 관성)으로 현금화**해야 한다.

---

## 4. 전략 경로 — 4개 테제 채점과 권고

투자심사 채점(0~100, 솔로 메인테이너 적합도 가중):

| 테제 | 점수 | 평결 | 치명적 결함 |
|---|---|---|---|
| **A. 카테고리 킹** (Windows 에이전트 콕핏) | **71** | 전략 채택, 스코프 절반으로 | 솔로 8~12h/주에 13개 워크스트림을 3개 지평에 나열 — 벤처팀 로드맵. 락인을 만드는 12~24개월 수가 정작 안 나올 가능성이 가장 큼. |
| **D. 유통 우선** (펀널을 이겨라) | **68** | 가장 강한 실전 테제, 0~12개월 척추로 채택. 단 모트 전략은 아님 | 이미 인정한 "못 지킬 위치"를 이기려 최적화. 내구 자산 심화를 12~24개월로 *미룸* → 1년간 복제 가능한 200줄 `McpRegistrar`로 트래픽 유도. |
| **B. 서브스트레이트/프로토콜** (pane이 아니라 protocol을 이겨라) | **47** | 프레임은 채택, 1차 GTM은 기각, 12~24개월 병렬 보험 | 솔로·무자금이 소유한 양면 네트워크효과 콜드스타트 베팅. "2번째 구현체를 직접 짜라"는 곧 자기 적합성 데모일 뿐 외생 수요 0. |
| **C. 크로스플랫폼 + Electron세금 제거** | **33** | **기각** | 자기모순: "Electron세금 제거"와 "CDP 모트 유지"는 양립 불가(모트가 Electron 때문에 존재). 유일한 방어 카테고리를 버리고 $73M Warp와 3개 OS 정면전. macOS/Linux 코드는 CI에서 실행된 적 없음. |

### 권고 = **하이브리드** (적대적 CEO 검증자 + 판정관 합의)

```
NOW(0~6개월)      ── Thesis D를 글자 그대로 실행 (§5 non-negotiables)
서사              ── Thesis A의 "Windows 에이전트 콕핏" 포지셔닝 채택 (D의 wedge와 동일 정신)
6~24개월(병렬)    ── Thesis B의 값싼 보험 한 수: 데몬+OSC133 서브스트레이트를 렌더러에서 분리
                     (미래 셸 재작성에도 모트 생존) + "자기 서브스트레이트 먹기" + 지속가능성 바닥
기각             ── Thesis C (크로스플랫폼). 단 perf 청소 같은 OS-무관 전술만 graft.
```

**왜 이 조합인가**: 네 테제의 0~3개월 수는 거의 동일하다(install 수정·서명·신뢰성·데모·런치). 그러니 거기서 갈라질 게 아니라 **먼저 다 하고**, 그 다음 **브라우저 사용률 텔레메트리가 A(브라우저가 wedge) vs B(서브스트레이트가 wedge)를 결정하게 한다**(§9의 $0 실험). C만은 처음부터 기각 — 유일한 방어 카테고리를 버리는 유일한 옵션이기 때문.

---

## 5. 절대 타협 불가 — 성장 푸시 전에 반드시 (전부 소스 검증)

> 이 6개는 "어떤 테제가 이기든" 공통 전제다. 고치기 전에 트래픽을 끌면, wmux가 구애하는 바로 그 커뮤니티에서 단 한 번의 런치를 안티팬 물결로 바꾼다.

1. **install.ps1의 거짓말을 고쳐라.** `install.ps1`은 line 304에서 GitHub releases API를 호출하지만 *버전 태그만* 읽고, 그 태그를 git-clone 후 `npm install` + `electron-rebuild` + `npm run make`로 **소스 컴파일**한다(line 340-368, VS C++ Build Tools 자동설치). docstring은 "Downloads and installs"라고 적혀 있다. → **사전빌드 서명 Setup.exe를 다운로드**하도록 변경(릴리스 자산 조회 코드는 이미 있음). 소스 빌드는 `--from-source` 플래그 뒤로. **최저 노력·최고 ROI, 거의 순수 이득.**
2. **코드서명 + 자동업데이트 무결성.** `release.yml`에 Authenticode 0(winget/choco push + choco checksum만). README가 "More info → Run anyway"를 직접 안내. → SignPath(OSS 무료) 또는 Azure Trusted Signing(~$10/월)으로 설치본 + 자동업데이트 아티팩트 서명, `AutoUpdater.ts`에 SHA-256 핀(현재 미검증 URL로 `shell.openExternal`만 함). **서명된 .exe가 유기적 발견 트래픽을 받는 유일한 채널**(winget/choco는 pull-only). `~/.claude.json`을 자동 편집하고 로그인 브라우저를 모는 도구가 "Run anyway"를 가르치는 것은 즉각적 엔터프라이즈 실격.
3. **신뢰성 잔여 경로를 닫아라(소스로 검증한 정확한 상태).**
   - ✅ *이미 고쳐짐*: 재앙적 "빈 세션 자가생성" 버그 — reconcile는 이제 liveness check만(`AppLayout.tsx:429-444`, "Fix 0 round 3"), `pty.reconnect`는 listener 등록 후 `useTerminal` mount가 수행(replay-before-listener 데이터손실 해소). 빈-리스트 케이스도 가드(424-427).
   - ❌ *아직 열림*: **partial-list 파괴적 clear** — `AppLayout.tsx:466-467`이 *비어있지 않은* 데몬 리스트에서 누락된 live ptyId를 즉시 단발성으로 `updateSurfacePtyId(...,'')` 처리. 2-strike 재조회 가드 없음. 주석(459-465)조차 "a destructive decision"이라 명시. 데몬이 재수화 중 부분 스냅샷을 반환하면(RCA가 지목한 바로 그 레이스) 첫 사이클에 live 세션을 파괴적으로 비운다. → **백오프 재조회 2-strike 가드 추가.**
   - ❌ *아직 열림(A4)*: `DaemonRespawnController` 기본값 `hangFailureThreshold:3`/`healthTimeoutMs:3000` 유지. RCA 권고는 3→5/3s→5s + event-loop self-stall 감지. 바쁜 데몬을 hung으로 오판 → 강제 respawn → `daemon:connected` 재발 → reconcile 재트리거.
   - ❌ *아직 열림(A6)*: `DaemonClient.connect()`는 단발 `net.createConnection`(재시도·TCP fallback 없음). Windows에서 AV 스캔이 transient EPERM을 상시 유발 → 50ms 블립이 데몬 끊김 캐스케이드로. (`wmux-client.ts`엔 이미 fallback 존재 — 미러링.)
4. **README↔코드 보안 불일치 해소.** README는 "Electron Fuses — RunAsNode disabled"라 주장하나 `forge.config.ts:178`은 `RunAsNode:true`(데몬 detached 스폰 때문), `:184`는 asar 무결성 검증 off. `SECURITY.md`(§1.1)는 icacls 하드닝이 *철회*됐다는데 `src/shared/security.ts`는 매 로드마다 icacls를 *실행*한다. **보안에 회의적인 에이전트 유저(=핵심 청중)는 주장을 config와 diff하고 신뢰 서사 전체를 깎는다.** 둘 중 하나로 일치시켜라.
5. **모션 데모 한 개를 출시하라.** 20~30초: Claude Code+Codex+Gemini 3-pane, 하나가 실제 브라우저를 몰고, 완료가 OSC-133 이벤트로 표면화. **하드-to-clone 모트가 현재 정적 스크린샷 한 장에 전혀 안 보인다.** 멀티-pane 시각 제품의 최고 레버리지 전환 자산.
6. **퍼널을 계측하라.** 프라이버시 존중 텔레메트리. 현재 winget vs choco vs exe vs 소스빌드 분포·활성화율을 모른다 — **유통(승부를 가르는 단 하나)을 측정 못 하면 관리 못 한다.**

---

## 6. 유통·브랜드·발견 — 진짜 병목

- **단 하나의 가장 큰 병목 = 윗단 발견**(설치 메커니즘 아님). winget/choco는 pull-only 채널 — 유저가 이미 `openwong2kim.wmux`를 알아야 한다. 이름에 트래픽 소스가 없다. 코드서명은 가장 시끄러운 갭이지만 2차 문제(이미 릴리스를 찾은 소수만 도움 받음).
- **이름**: `wmux`는 니치엔 좋지만(짧고 "Windows tmux" 신호) 발견엔 최악(검색·발음 불가, 도메인·브랜드 표면 없음, winget id가 모호한 핸들 뒤에 묻힘).
- **랜딩 페이지 없음**(homepage가 GitHub README만 가리킴) → SEO/전환 표면·이메일 캡처 없음.
- **커뮤니티 온램프 0**: Discord·discussions·issue 템플릿·good-first-issue·CONTRIBUTORS 없음 → 스타 플라이휠 진입로 없음.
- **콘텐츠 0**: "best terminal 2026" 토론이 벌어지는 YouTube/Dev.to/HN에 부재.

**처방**: ① 서명+설치 수정 후 **Show HN + r/ClaudeAI + r/commandline 조율 런치**(데모 GIF 앵커). ② `awesome-claude-code` 리스트 / Claude Code 생태계 문서 / 이미 존재하나 미마케팅된 `.claude-plugin/marketplace.json`에 "Windows 멀티에이전트 추천 런타임"으로 등재. ③ 미니 랜딩 페이지 + 텔레메트리. ④ **"Claude에게 직접 물어봤을 때 추천되는" 발견**을 최적화(에이전트 시대의 새 유통 채널). ⑤ 메인테이너 스토리 공개(Ghostty/WezTerm가 증명한 창업자 서사 → 스타).

---

## 7. 실행 로드맵

### 90일 (0~3개월) — "퍼널을 막고, 신뢰를 세우고, 모트를 보이게"
- [ ] install.ps1 → 사전빌드 서명 exe 다운로드 (`--from-source` 분리)
- [ ] 코드서명(installer + 자동업데이트) + AutoUpdater SHA-256 핀
- [ ] `AppLayout.tsx:466` partial-list 2-strike 가드 + A4 health-probe(3→5/3s→5s+self-stall) + A6 connect 재시도/TCP fallback
- [ ] README↔forge.config 보안 불일치 해소 + 다른 보안 불릿 전수 대조
- [ ] 20~30초 모션 데모(README + 랜딩) · ligature 1-dep 추가 · EditorPanel Save 완성 or 숨김
- [ ] 프라이버시 존중 텔레메트리(활성화율·채널 분포)
- [ ] 포지셔닝 전면 교체 → "Windows 에이전트 콕핏" / "best terminal"·크로스플랫폼은 각주화
- [ ] 조율 런치(Show HN + r/ClaudeAI + r/commandline) + GitHub Sponsors/FUNDING.yml
- [ ] **$0 실험**: `browser_*` 세션당 호출률 계측 → 브라우저 수요 가설 검증/기각 → A vs B 결정 게이트

### 6~12개월 — "데모를 플랫폼으로 / 자기 서브스트레이트 먹기"
- [ ] **A2A 태스크 상태를 렌더러 Zustand → 데몬 원자적 스토어**로 이전(재시작 생존)
- [ ] Company mode를 OSC-133 `agent.lifecycle` 이벤트 기반으로 재작성(글자 감시·`setTimeout(8000)`·`/plan` 붙여넣기·NL 애원 제거)
- [ ] `@wmux/orchestrator`를 **리포 내 소스 가시·데몬 테스트 SDK**로 검증·이전
- [ ] 에이전트-운영 감사/관측 레이어: MCP 툴 호출 append-only 로그(pane/plugin 신원+결과) + 멀티에이전트 대시보드(라이프사이클 타임라인, live-session vs 1GB 예산)
- [ ] per-plugin `wmuxPermissions` 강제 착지 + dangerous-action을 **PTY write 전 입력측 승인 게이트**로(현재는 사후 토스트 — 차단 불가)
- [ ] git-worktree 오케스트레이션을 코어에 추가(상품화 중인 table-stakes 갭 메우기)
- [ ] 콘텐츠 5~8편(롱테일 쿼리 타겟) + 생태계 등재
- [ ] zsh/fish OSC-133 커버 + cmd.exe 미지원 명문화

### 12~24개월 — "카테고리 소유를 내구 해자로"
- [ ] 외부(non-wmux) 2번째 구현체 1개 이상이 `events.poll`+trust DB 소비(프로토콜 → 플랫폼 전환의 단일 결정 지표)
- [ ] 데몬+OSC133 서브스트레이트를 렌더러에서 분리(미래 셸 재작성 헤지 — Thesis B의 값싼 보험)
- [ ] 오픈코어 "wmux Teams": OSS 코어 MIT 유지 + 유료 티어가 Company/orchestrator/worktree/감사로그 수익화(엔터프라이즈향 hard-to-clone 표면)
- [ ] (조건부) 니치가 확실히 잠긴 *후에만* macOS — 척추가 아니라 Phase 2로

---

## 8. 수익화·지속가능성

- **현재 = 자금 0, 수익 코드 0, Sponsors 0.** 신뢰성 이야기가 성숙할 자원이 없다.
- **즉시**: GitHub Sponsors + FUNDING.yml + 투명 로드맵/신뢰성 페이지(최저 비용 지속가능성 신호).
- **중기(니치 잠근 후)**: **오픈코어** — 단일유저 OSS는 MIT 무료(스타 플라이휠 보존), 유료 **wmux Teams**가 Company-mode + orchestrator SDK + worktree 오케스트레이션 + 감사로그를 수익화. 이게 자연스러운 유료 wedge인 이유: 정확히 *기업이* 가치를 두는, 복제 어려운 엔터프라이즈향 표면이기 때문.
- **단 엔터프라이즈/감사 표면은 솔로 소유가 아니라 파트너·연기 후보로.** 서명·감사·RBAC/SSO·provenance가 다 없는 상태에서 유료 Teams를 니치 소유 전에 쫓으면 조기·희석.
- **자금만으론 버스 팩터를 못 고친다 — 코드를 쓰는 건 2번째 커미터다.** issue 템플릿·good-first-issue(ligature/프로파일/설정파일 같은 table-stakes 갭)·CONTRIBUTING(데몬/권한/신원 핫스팟 매핑)으로 다중 기여자 전환을 Sponsors와 **병행**.

---

## 9. 존재론적 위협 · Kill Criteria · 인커번트 대응

### Kill / Pivot 기준 (적대적 CEO 검증자)
- **18개월에** r/ClaudeAI·HN·Claude Code 문서에서 "Windows에서 Claude Code 여러 개 돌리기"의 *지명된 기본 답*이 아니면 → 순수 서브스트레이트/SDK로 피벗 or GUI 야망 정리.
- **텔레메트리 후** `browser_*` 호출률이 미미하면 → 브라우저-헤드라인 베팅 기각, 데모를 멀티에이전트 오케스트레이션+세션영속으로 재초점(= B로 기운다).
- **12개월 내** 외부 2번째 구현체가 없으면 → 플랫폼/SDK 테제 폐기(1-구현체 프로토콜은 네트워크효과 0).
- **EXISTENTIAL KILL**: Anthropic/Claude Code(또는 Cursor/Warp)가 Windows 1st-party 멀티에이전트 오케스트레이션을 내거나 축복하면 → 가장 깊은 방어 니치(세션-데몬 신뢰성+감사)로 즉시 후퇴 or 종료.
- **신뢰성 stop-loss**: 런치 푸시 후 2번째 공개 파괴적 세션손실 사고 = 구애하던 커뮤니티에서 신뢰 회복 불가 → 모든 GTM 동결, 한 릴리스 사이클 신뢰성에 올인.
- **C 시도 시 stop-loss**: 서명+노타라이즈 macOS GA 6개월 내 신규설치의 ~25% 미달이면 멀티-OS 즉시 중단.

### 인커번트 대응 (각본을 미리 써라)
가장 치명적 2수와 동일한 방어:
- (a) **MS가 Windows Terminal에 세션 영속+에이전트 인지 추가** / (b) **Anthropic이 Windows 1st-party 오케스트레이션 출시**
- 방어 = **감사로그 + worktree + MCP 워크플로우 관성으로 전환비용 심화 + 커뮤니티 기본값 지위를 빠르게 확보.** 트리거 조건과 대응을 보고서에 명시해 전략을 가정-의존이 아니라 강건하게.

---

## 10. 빠진 각도 / 추가 리스크 (완전성 비평이 잡아낸 것)

1. **법적/IP 노출**: 에이전트가 사용자 로그인 세션(Gmail·뱅킹·GitHub·Okta)을 클릭/입력하는 것 + `anti-detection.ts`의 `navigator.webdriver` 스푸핑은 문자 그대로 우회 코드 → ToS 위반·CAPTCHA 우회·CFAA 질문. 헤드라인 모트를 마케팅하기 *전에* 법무/ToS 리뷰. "에이전트가 *당신의* 앱을 자동화"(1st-party, 동의/allowlist)로 재포지셔닝하거나 책임을 문서화.
2. **데이터 거버넌스**: 999K 스크롤백 디스크 영속 + 계획된 감사로그 + 브라우저 세션 자료 = 민감정보(터미널 출력의 시크릿, 에이전트가 읽은 PII) 캡처. 권고한 감사로그가 오히려 **최대 신규 PII/시크릿 책임**이 될 수 있다 → at-rest 암호화·보존/리댁션 정책(envFilter가 아는 시크릿 자동 스트립)·데이터 흐름도와 함께 출시.
3. **에이전트 실행 비용 경제**: 3~5개 에이전트 병렬 = 토큰/API 비용 폭증. `CostEstimator/CostDashboard`가 부분 존재 → **"놀랄 청구서 없이 5개 에이전트"**를 1급 기능·wedge로(per-pane 토큰, 예산 상한 도달 시 일시정지). 1GB 데몬 천장보다 월 청구서가 먼저 충돌할 수 있다.
4. **접근성(a11y)**: 정부·대기업 조달의 하드 요건(스크린리더·키보드 전용·WCAG). 현재 전무 — Electron/React엔 리스크이자 잠재 차별점.
5. **버스 팩터의 진짜 해법 = 2번째 커미터**(§8). 돈이 아니라.
6. **"터미널이 옳은 폼팩터인가"라는 급진 옵션**: 75.9%가 VS Code에 살고 IDE 내장이 existential인데, **GUI를 버리고 헤드리스 서브스트레이트 + VS Code/JetBrains 확장만 출시**하는 옵션을 어떤 테제도 진지하게 스트레스 테스트하지 않았다. Thesis B가 손짓하지만 Electron GUI를 플래그십으로 유지. 텔레메트리가 GUI 이탈을 보이면 진지하게 검토할 카드.

---

## 11. 성공 지표 (KPI)

| 지표 | 목표 | 비고 |
|---|---|---|
| **TTHW** (one-liner→첫 에이전트 태스크 MCP 동작) | < 5분 | 현재: 자주 실패하는 다분 컴파일 |
| **활성화율** (설치→MCP 확인된 첫 에이전트 태스크) | > 40% (6개월) | 경쟁자 아무도 측정 안 함 — 핵심 KPI |
| **검색/추천 슬롯** | 롱테일 ≥3개 #1 + 커뮤니티 추천 리스트 ≥3 등재 (12개월) | "run multiple Claude Code Windows" 등 |
| **서명 .exe 설치 점유** | SmartScreen 벽 후 0 → 성장하는 다수 | 서명 효과 측정 |
| **신뢰성 SLO** | 90일 롤링 파괴적 세션손실 0 (라이프사이클 로그가 증거) | 공개 신뢰성 페이지 |
| **브라우저 wedge 검증** | 세션당 `browser_*` 호출률 | A vs B 결정 게이트($0 실험) |
| **플랫폼 증명** | 외부(non-wmux) 구현체 ≥1이 `events.poll`+trust DB 소비 | 프로토콜→플랫폼 전환의 단일 결정 지표 |
| **지속가능성** | Sponsors live + 첫 유료 Teams 시트 | 오픈코어 wedge 검증 |

---

## 12. 부록 — 사실 검증 노트 (보고서를 정직하게 쓰기 위한 주의)

리서치 단계에서 인용된 수치 중 **출처·일관성이 약한 것**을 명시한다. 의사결정에 쓰되 "추정/예시"로 취급할 것:

- **Warp 유저 수·Windows 상태가 출처 간 불일치**: 세그먼트마다 "500K" vs "700K+", "Windows 2024-2025 출시/2026초 GA" vs "2026-05 기준 미출시". → "Warp는 $73M 펀딩·2026-04 오픈소스, Windows 지원을 출시했거나 출시 중(출처 상이)"로만 단정.
- **메모리 수치(wmux ~180MB, Warp ~380MB, Ghostty 45MB)는 wmux에 대해 미벤치마크**. 업계 인용/추정이지 wmux 실측 아님. → §5에 "재현 가능 벤치 스위트 발행" 권고가 들어간 이유.
- **TAM($500M~$2B), Windows 개발자 5만~20만, $10M+ ARR floor, Claude Code 18%/CSAT 91%/NPS 54, MCP 9,400 서버 등은 출처 없는 bottoms-up 추정 또는 내부 불일치**(예: Windows 개발자 비중 "48%" vs "72%"가 같은 보고서에서 충돌). → **예시적 규모감**으로만 사용.
- **"winget/choco는 발견 트래픽 ~0"은 미입증 가설**(winget엔 의미 있는 검색·CLI 발견 존재). GTM 우선순위(서명-우선)를 형성하므로 단정 금지.
- **신뢰성 사실 분쟁 해소(소스 직접 확인, `AppLayout.tsx:408-492`)**: 재앙적 자가생성 벡터는 *제거됨*, 빈-리스트 케이스는 *가드됨*, **partial-list 파괴적 clear(466-467)는 여전히 열려 있음(2-strike 가드 없음)**. "버그 고쳐짐"도 "버그 그대로"도 아닌 — **재앙 경로는 닫혔고 좁은 잔여 경로가 남았다.**

---

### 한 문장으로
> wmux는 "1위 터미널"이 될 수 없지만, **"Windows에서 AI 에이전트를 여러 개 돌리는 1위 콕핏"**이 될 수 있다 — 단 (1) 펀널의 거짓말·미서명·partial-list 신뢰성 구멍을 *트래픽 전에* 막고, (2) 모트를 정적 스크린샷에서 모션 데모로 끌어내고, (3) 자기 OSC-133 서브스트레이트를 먹어 데모웨어 Company mode를 진짜 플랫폼으로 바꾸고, (4) IDE 내장 멀티에이전트가 카테고리를 삼키기 전에 커뮤니티 기본값 지위로 현금화할 때에만. 종합 1위를 쫓는 매 사이클은 유일하게 이길 수 있는 1위에서 빼앗긴 사이클이다.
