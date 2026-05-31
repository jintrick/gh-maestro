---
source_url: https://github.com/openwong2kim/wmux/blob/main/docs/upgrade-v2.9.0.md
original_title: upgrade-v2.9.0
fetched_at: 2026-05-30T16:00:11.157640+00:00
---

# Upgrade Guide — v2.9.0 (Substrate 3.0 — Phase 0 + M0)

v2.9.0 ships the wmux Substrate 3.0 foundation along with a hardening
pass for scrollback persistence and pane input reliability. The
substrate work (MetadataStore, optimistic concurrency, mergeMode,
contract documentation) is wire-compatible with v2.8.x and requires no
user action. The reliability fixes change how scrollback files are
persisted on disk, and v2.8.x users will see a one-time migration of
any pre-existing corrupted dumps. This document explains what to
expect and how to recover content if needed.

대상 독자:

- v2.8.x를 사용 중이고 v2.9.0으로 업그레이드하는 일반 사용자
- v2.8.x에서 "재부팅 후 일부 패널 스크롤백이 비어 보이는" 증상을 겪은 사용자
- 디스크에 새로 생기는 `corrupted/` 폴더가 무엇인지 알고 싶은 사용자

---

## 1. What changed

v2.9.0의 사용자 영향 변화는 두 부류다.

**1) 스크롤백 손상 픽스 (P0 layered defense).**
v2.8.x의 xterm `FitAddon`은 컨테이너가 숨김/0폭 상태일 때 `cols`를 ~2로
collapse하는 케이스가 있었다. 그 순간 5초마다 일어나는 스크롤백 dump가
xterm 버퍼를 잡으면 각 행이 1~2글자만 들어간 채로 파일에 저장됐다.
다음 부팅 때 renderer는 그 chopped 콘텐츠를 새 xterm에 복원해버리고,
다음 5초 dump가 같은 chopped 상태를 다시 디스크에 적어 — 자기증식
손상 루프. 시각적으로는 "재부팅하면 스크롤백이 빈 상태로 보임".

v2.9.0은 네 층의 방어를 더해 이 루프를 끊는다.

- dump-time `cols`/`rows`/`offsetWidth` eligibility 가드 — dump 자체를
  거부하므로 디스크 오염이 시작되지 않는다.
- 모든 `fit()` 사이트가 컨테이너 가시성 가드를 통과하도록 정렬.
- IPC `SCROLLBACK_DUMP`에서 한 번 더 시그니처 검증.
- IPC `SCROLLBACK_LOAD`가 chopped 시그니처 검출 시 격리(`corrupted/`).

**2) 패널 입력 먹통 픽스 (M0 reconcile race).**
부팅 직후 daemon이 막 연결된 시점에 두 번의 PTY reconcile이 동시에
달려서 일부 surface가 input-mute로 빠지는 경합이 있었다. 워크스페이스를
한 번 토글하면 풀리던 증상. v2.9.0은 reconcile에 in-flight 가드를
넣고, 각 walk마다 workspace snapshot을 다시 읽어 동시 spawn이
가려지지 않게 했다.

세부는 PR #34 본문과 CHANGELOG를 참고.

---

## 2. New directories on disk

플랫폼별 `{userData}` 경로:

| 플랫폼  | 경로                                              |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\wmux\`                                 |
| macOS   | `~/Library/Application Support/wmux/`             |
| Linux   | `~/.config/wmux/`                                 |

v2.9.0에서 새로 등장하거나 거동이 바뀌는 항목:

- **`scrollback/{surface}.txt.bak[.{1,2,3}]`** — 5세대 회전 백업.
  매번 dump가 atomic write로 들어가면서 이전 primary를 `.bak`으로,
  `.bak`을 `.bak.1`로 미는 식으로 회전한다. 하나의 잘못된 dump가
  들어와도 최대 4세대 이전까지 살아남는다.
- **`scrollback/corrupted/{surface}.txt.{timestamp}.bak`** — 격리된
  손상 파일. v2.8.x에서 chopped 상태로 저장된 dump가 v2.9.0 첫 부팅
  때 감지되어 여기로 이동한다. 30일 / 폴더당 10파일까지 보관 후
  자동 정리.
- **세션 / metadata 파일들의 `.bak` 회전 체인** — 이미 v2.7.x부터
  존재하던 것으로, v2.9.0에서 scrollback도 같은 보호를 받게 됐다.

---

## 3. First launch after upgrade — what to expect

v2.8.x에서 chopped dump 파일이 디스크에 남아 있던 사용자는 v2.9.0 첫
부팅에서 다음 시퀀스를 보게 된다.

1. 세션 복원이 각 surface의 스크롤백 파일을 읽으려고 시도한다.
2. `corruption.ts`의 검출기가 chopped 시그니처 (median 비공백 행 길이
   ≤ 3자, CRLF 바이트 비율 ≥ 0.3)를 감지한다.
3. 검출된 파일은 `corrupted/{surface}.txt.{timestamp}.bak`으로
   이동하고, `.bak` 회전 체인을 한 단계씩 fallback으로 시도한다.
4. 회전 체인의 모든 슬롯이 chopped이면 `null`이 반환되어 renderer는
   비어 있는 새 xterm을 띄운다. 그 surface는 "스크롤백이 비어 있는
   상태"로 시작한다.
5. 깨끗한 슬롯이 회전 체인 어딘가에 살아 있으면 그게 복원된다.

**중요**: 격리는 데이터를 삭제하지 않는다. 원본 chopped 바이트는
`corrupted/`에 그대로 보존되어 있어, 필요하면 그 raw 데이터에서
사람이 읽을 수 있는 텍스트를 추출할 수 있다 (다음 절).

---

## 4. Recovering chopped scrollback from `corrupted/`

`corrupted/`에 들어간 파일들은 cols=2 reflow의 산물이라 사람이
읽기엔 깨져 보이지만, 단순한 역연산으로 텍스트 콘텐츠는 회수된다.
저장소에 포함된 마이그레이션 스크립트가 이 작업을 한다.

```sh
node scripts/recover-scrollback.mjs --verbose
```

기본 동작:

- 입력: `%APPDATA%\wmux\scrollback\corrupted\` (Windows). 다른
  플랫폼은 `~/.config/wmux/scrollback/corrupted/`.
- 출력: `~\wmux-recovered-YYYY-MM-DD\` (홈 디렉토리).
- 각 격리 파일에 대해:
  - chopped 시그니처가 맞으면 reverse-reflow로 텍스트 복원 후
    `.recovered.txt`로 출력 디렉토리에 저장.
  - 시그니처와 다른 (실제로는 손상되지 않은) 파일은 건너뜀.

옵션:

| 옵션                        | 동작                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `-i, --input <dir>`         | 소스 디렉토리 지정                                         |
| `-o, --output <dir>`        | 출력 디렉토리 지정                                         |
| `-n, --dry-run`             | 분석만, 파일은 쓰지 않음                                   |
| `-v, --verbose`             | 파일별 통계 + 첫 80자 미리보기 출력                        |
| `-h, --help`                | 사용법 표시                                                |

**복원 한계.** 사용자가 실제로 enter 친 줄 경계 중 빈 줄로 분리되지
않은 것은 다음 줄과 연결돼서 한 줄로 보인다. 텍스트 콘텐츠 자체는
손실되지 않지만, 원본의 정확한 줄 구조는 근사치다. AI 에이전트
대화나 명령 출력의 의미는 충분히 추출 가능하다.

**예시.** 원본 chopped 파일이 다음과 같다면:

```
PS\r\n C\r\n:\\\r\nUs\r\ner\r\ns\\\r\nri\r\nzz\r\n>
```

복원 결과:

```
PS C:\Users\rizz>
```

스크립트는 read-only로 동작한다. `corrupted/` 원본은 절대 수정하지
않으며, 결과는 별도 출력 디렉토리에 새 파일로만 쓴다.

---

## 5. Rollback

v2.9.0의 디스크 변경은 모두 additive하다 (`corrupted/` 서브디렉토리
생성 + `.bak.{1,2,3}` 회전 슬롯 추가). v2.8.x로 다운그레이드해도
기존 파일은 그대로 읽힌다 — v2.8.x는 추가 슬롯을 단순히 무시한다.

다만 `corrupted/` 디렉토리는 v2.8.x가 인식하지 못한다. 다운그레이드
후에도 디스크에는 남아있지만 wmux는 더 이상 읽거나 정리하지 않으며
직접 삭제해도 안전하다.

---

## 6. FAQ

**Q. 재부팅 후 일부 패널이 비어 보이는데 정상인가?**

v2.8.x에서 이미 디스크에 저장돼 있던 dump가 chopped 상태였다면,
v2.9.0 첫 부팅에서 그 파일들은 격리되고 해당 패널은 빈 새 xterm으로
시작된다. **데이터를 v2.9.0이 버린 게 아니라 v2.8.x 시점에 이미
chopped 형태로 저장되어 있던 것**을 v2.9.0이 검출만 한 것이다.
사람이 읽을 수 있는 텍스트로의 회수는 §4 스크립트로 가능.

**Q. `corrupted/` 폴더를 직접 지워도 되나?**

된다. 격리된 파일은 30일 / 폴더당 10파일까지 자동 정리되지만,
수동 삭제해도 wmux 동작에 영향이 없다. §4의 복원 스크립트를
돌릴 의향이 있다면 삭제 전에 먼저 실행해두는 편이 좋다.

**Q. v2.9.0 이후 새로 쌓이는 스크롤백도 chopped될 수 있나?**

dump-time eligibility 가드가 cols/rows/offsetWidth를 검사해 dump
자체가 거부되고, IPC handler가 한 번 더 시그니처 검증을 한다. 또한
모든 `fit()` 호출 사이트에 컨테이너 가시성 가드가 들어가 있어
collapse 자체가 잘 일어나지 않는다. 만약 어떤 새로운 경로로 chopped
파일이 생기더라도 회전 체인 4세대가 살아 있으므로 즉시 fallback
복구된다.

**Q. 스크롤백 복원이 항상 정확한 줄 구조를 재현하지 않는다는 게
무슨 의미인가?**

cols=2 reflow는 "줄 바꿈"과 "wrap"을 같은 CRLF로 만든다. 두 빈 줄
사이에 끼어 있던 명령 출력은 paragraph boundary로 살아남지만, 빈
줄 없이 연속된 두 명령은 합쳐져 한 줄로 보인다. 텍스트 의미는
온전하다.
