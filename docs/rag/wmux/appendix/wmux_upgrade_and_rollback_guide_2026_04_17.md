---
source_url: https://github.com/openwong2kim/wmux/blob/main/docs/upgrade-2026-04-17.md
original_title: upgrade-2026-04-17
fetched_at: 2026-05-30T16:00:11.148665+00:00
---

# Upgrade & Rollback Guide — 2026-04-17 (Stability & Persistence Hardening)

이번 릴리스에서 wmux daemon의 저장 경로와 IPC 에러 처리가 바뀐다. 이 문서는 기존
사용자가 업그레이드 시 알아야 할 디스크 변화와, 문제가 생겼을 때의 롤백 절차를
정리한다. renderer 플러그인 개발자를 위한 IPC 에러 포맷 변경 공지도 함께 다룬다.

대상 독자:

- wmux를 이미 사용 중이고 업그레이드를 고려하는 일반 사용자
- wmux renderer 측에서 `ipcRenderer.invoke`를 직접 호출하는 플러그인/확장 개발자

---

## 1. What changed

이번 릴리스의 핵심은 "데이터 보존 강화 + 업그레이드 안전"이다. 기존 wmux는 세션
파일이 한 번 손상되면 조용히 빈 세션으로 시작했고, concurrent save 경합으로 일부
저장이 유실될 가능성이 있었다. 또한 IPC 핸들러가 예외를 던지면 메인 프로세스
로그에 흔적이 남지 않아 디버깅이 어려웠다.

사용자 관점에서 직접 할 일은 없다. 파일 포맷의 semantic은 동일하고, 스키마 버전
업그레이드는 load 시점에 자동으로 수행된다. 변환은 메모리에서만 일어나고, 모든
step이 성공한 뒤 다음 save 시점에 새 포맷으로 기록된다. 변환 전에 원본 스냅샷이
별도 파일로 보존되므로 필요 시 구버전으로 돌아갈 수 있다.

---

## 2. New directories on disk

디스크에 새로 등장하는 경로가 두 종류 있다. 위치는 플랫폼별 `{userData}` 디렉토리
내부다.

플랫폼별 `{userData}` 경로:

| 플랫폼  | 경로                                              |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\wmux\`                                 |
| macOS   | `~/Library/Application Support/wmux/`             |
| Linux   | `~/.config/wmux/`                                 |

### 2.1 `{userData}/corrupted/`

validate 실패로 격리된 세션/상태 파일이 모이는 곳이다. 파일명은
`{basename}.{timestamp}.bak` 형태다.

- 격리가 일어날 때 daemon 로그에 `CORRUPT_FILE` JSON 이벤트가 한 줄 남는다.
- 자동 정리 정책: 파일 생성 시각 기준 30일 경과, 또는 디렉토리 내 파일 개수 10개
  초과. 둘 중 하나의 조건을 만족하면 오래된 파일부터 삭제된다.
- 이 디렉토리는 `.bak` rotation 대상이 아니다. rotation allowlist regex가
  corrupted 경로를 제외한다.

예시 (Windows):

```
%APPDATA%\wmux\corrupted\sessions.json.1760678400000.bak
```

### 2.2 `{basename}.premigrate.bak`

스키마 업그레이드 load 시점에 원본을 보존하는 스냅샷이다. 파일명은
`{basename}.v{N}.premigrate.bak` 형태로, `{N}`은 업그레이드 직전 버전이다.

- load 직후 **단 한 번만** 생성된다. 이미 존재하면 skip.
- rotation 대상에서 제외된다(`.bak.1/2/3` 체인에 관여하지 않음).
- 자동 정리 대상도 아니다. 확신이 서면 수동 삭제해도 무방하다. 향후 릴리스에서
  자동 정리가 검토되지만 이번 스코프에는 포함되지 않는다.

예시 (Linux):

```
~/.config/wmux/sessions.v1.premigrate.bak
```

---

## 3. IPC error format change (plugin developers)

renderer에서 `ipcRenderer.invoke`로 메인 프로세스 핸들러를 호출하는 플러그인
개발자에게 영향이 있다. 코드 변경이 강제되지는 않지만, 에러 처리 경로를 조정할
여지가 있다.

### 3.1 이전 동작

핸들러에서 던진 예외는 renderer의 promise rejection으로 그대로 전달되었다. stack이
남는 경우도 있었지만, 메인 프로세스 stderr에 구조화된 로그는 남지 않았다. daemon이
끊긴 경우와 validation 실패를 구분할 수 있는 공통 코드도 없었다.

### 3.2 변경된 동작

모든 `ipcMain.handle` 호출은 이번 릴리스에서 도입된 `wrapHandler`를 경유한다.
핸들러 내부에서 throw가 발생하면 wrapper가 다음 작업을 수행한다.

1. 메인 프로세스 stderr에 JSON line 로그를 기록한다.

   ```json
   {"ts":"2026-04-17T10:23:14.221Z","level":"error","event":"ipc.handler.failed","channel":"session.list","error_code":"DAEMON_DISCONNECTED","stack":"..."}
   ```

2. 에러 객체의 `code` 속성을 다음 중 하나로 분류한다.

   | code                   | 의미                                                       |
   | ---------------------- | ---------------------------------------------------------- |
   | `DAEMON_DISCONNECTED`  | daemon 프로세스와의 IPC 소켓이 끊긴 상태                   |
   | `VALIDATION_ERROR`     | 요청 payload의 타입/스키마 검증 실패                       |
   | `NOT_FOUND`            | 참조한 세션/워크스페이스/리소스가 존재하지 않음            |
   | `PERMISSION_DENIED`    | 파일시스템 권한 또는 내부 capability 거부                  |
   | `UNKNOWN`              | 위 네 범주에 해당하지 않는 예상치 못한 에러                |

3. 성공 응답은 기존과 동일하게 raw value를 반환한다. 이번 릴리스에서는 응답 shape를
   `{ok, data, error}`로 정규화하지 않는다. 정규화 wrapper는 renderer 측 `useIpc`
   훅에서 흡수할 예정이다(T4에서 도입 예정).

### 3.3 `useIpc` 훅 사용 예시 (T4에서 구현 예정, 의사코드)

아래는 T4에서 제공될 renderer 훅의 사용 형태 예시다. 현 릴리스에서는 아직 훅이
없으므로 플러그인 개발자는 당분간 `ipcRenderer.invoke`를 try/catch로 감싼 뒤
`error.code`를 분기하는 방식으로 대응하면 된다.

```ts
// 예시 — T4에서 도입 예정
import { useIpc } from 'wmux/hooks/useIpc';

function SessionList() {
  const { data, error, loading } = useIpc('session.list', undefined);

  if (error?.code === 'DAEMON_DISCONNECTED') {
    return <Reconnecting />;
  }
  if (error) {
    return <ErrorToast message={error.message} />;
  }
  if (loading) return <Spinner />;
  return <List items={data} />;
}
```

현 릴리스에서 직접 쓸 수 있는 방식:

```ts
try {
  const sessions = await window.electron.ipcRenderer.invoke('session.list');
  render(sessions);
} catch (err) {
  if (err && err.code === 'DAEMON_DISCONNECTED') {
    showReconnectBanner();
  } else {
    showError(err?.message ?? 'Unknown error');
  }
}
```

### 3.4 `[CODE]` message prefix 공지

wmux v2.6부터 `wrapHandler`가 스로우된 Error의 message 앞에 `[DAEMON_DISCONNECTED]`
같은 **대괄호 코드 접두어**를 덧붙인다. 이는 Electron의 IPC 구조화 복제가 Error의
own property `code`를 간헐적으로 누락시키는 케이스에 대한 이중 안전장치다.
렌더러의 `useIpc` 훅은 `err.code`가 없을 때 이 접두어를 regex로 파싱해 분류한다.

플러그인이나 외부 로거가 `err.message`를 그대로 로깅하거나 사용자에게 노출한다면,
출력에 `[CODE]` 접두어가 포함될 수 있다. 필요 시 다음 패턴으로 제거 가능:

```ts
const cleanMessage = err.message.replace(/^\[[A-Z_]+\]\s*/, '');
```

`err.code`가 정상적으로 전달된 경우에도 message는 이미 접두어가 붙은 상태이므로,
표시용 메시지를 원한다면 위 정규식을 항상 적용해도 무방하다.

---

## 4. Rollback playbook

업그레이드 후 문제가 발생하면 아래 절차로 구버전 상태를 복원한다. 대부분의 경우
premigrate 스냅샷 한 단계로 해결되지만, 없을 경우의 대안도 함께 적어둔다.

### 4.1 일반 롤백 (premigrate.bak 사용)

준비물: 업그레이드 이전 버전의 wmux 설치 파일.

1. **wmux를 완전히 종료한다.**
   - 트레이 아이콘 → Quit. 창 닫기만으로는 daemon이 남아 있을 수 있다.
   - 작업 관리자/Activity Monitor/`ps`로 `wmux` 관련 프로세스가 없는지 확인한다.

2. **`{userData}` 디렉토리로 이동한다.**

   ```bash
   # Windows (PowerShell)
   cd $env:APPDATA\wmux

   # macOS
   cd ~/Library/Application\ Support/wmux/

   # Linux
   cd ~/.config/wmux/
   ```

3. **현재 원본 파일을 실패 스냅샷으로 이름 변경한다.** `{basename}`은 실제 파일명
   (예: `sessions.json`)으로 대체한다.

   ```bash
   mv sessions.json sessions.json.upgrade-failed.bak
   ```

4. **premigrate 스냅샷을 원본 자리로 복사한다.**

   ```bash
   # N은 실제 존재하는 버전 번호로 대체 (예: sessions.v1.premigrate.bak)
   cp sessions.v1.premigrate.bak sessions.json
   ```

   복사(cp)를 사용하는 이유는 premigrate 파일 자체를 보존하기 위함이다. mv/rename을
   쓰면 다음 시도에서 롤백 자료가 사라진다.

5. **구버전 wmux를 재설치하고 실행한다.** 설치 경로는 기존 위치를 덮어쓴다.
   실행 후 세션 목록이 업그레이드 이전 상태로 돌아왔는지 확인한다.

### 4.2 premigrate.bak이 없는 경우 — `.bak` rotation 체인

스키마 업그레이드가 없던 release 간에는 premigrate 파일이 생성되지 않는다. 이
경우 rotation chain을 사용한다.

순서대로 존재 여부를 확인한다. 하나라도 valid JSON이면 그것을 원본으로 복사한다.

1. `{basename}.bak` — 가장 최근 save 직전 스냅샷
2. `{basename}.bak.1`
3. `{basename}.bak.2`
4. `{basename}.bak.3`

절차는 일반 롤백 2~4단계와 동일하다. 선택한 `.bak` 파일을 `{basename}`으로 복사한
뒤 재실행한다.

```bash
# 예: .bak.1을 복원 소스로 사용
mv sessions.json sessions.json.upgrade-failed.bak
cp sessions.json.bak.1 sessions.json
```

### 4.3 최후 수단 — `corrupted/` 디렉토리

rotation chain도 모두 손상됐다면 `corrupted/` 디렉토리의 최근 격리 파일을 본다.
파일명 마지막 숫자가 timestamp(milliseconds)이므로 큰 값이 가장 최근 격리다.

```bash
# Linux/macOS 예시
ls -1t ~/.config/wmux/corrupted/ | head -5
```

해당 파일을 열어 텍스트로 valid JSON 구조가 남아 있는지 육안 확인한 뒤, 일반
롤백 3~4단계 방식으로 원본 자리에 복사한다. 이 단계에 도달한 경우 데이터 일부
유실이 있을 수 있으므로, 복원 후 세션 내용을 반드시 검토한다.

### 4.4 재업그레이드 시 참고

롤백 후 문제 원인이 해결됐다면 다시 최신 버전으로 업그레이드할 수 있다. 이때
`{basename}.upgrade-failed.bak` 파일은 수동으로 삭제해도 된다. 보존해두면 향후
동일 증상 재현 시 진단 자료가 된다.

---

## 5. FAQ

### Q1. `corrupted/`에 파일이 생겼어요. 데이터 손실인가요?

완전한 손실은 아닐 가능성이 높다. 격리는 primary 파일이 validate에 실패했을 때
일어나는데, 이때 daemon은 `.bak` 체인에서 fallback을 시도한다. 하나라도 valid한
스냅샷이 있으면 그것으로 복구하고 즉시 승격 save로 primary를 복원한다. 격리 파일
자체는 디버깅 자료로 corrupted/에 남는다. 세션 목록이 비어 보이거나 이상하다면
섹션 4.3 절차로 격리 파일 내용을 직접 확인할 수 있다.

### Q2. `.bak.3`까지 있는데 더 많이 유지할 수 있나요?

이번 릴리스에서는 설정 노출 없이 3개로 고정한다. 1개는 연속 손상 시 복구 여력이
부족하고, 5개 이상은 디스크 낭비와 디렉토리 성능 저하 우려가 크다. 3개는 "직전
save 2회 + 격리 전 1회"를 커버하는 최소 안전 수치로 결정됐다(D5 참고). 설정화는
후속 이터레이션(Phase C)의 스코프다.

### Q3. 자동 정리는 언제 실행되나요?

corrupted/ 디렉토리는 daemon이 새로 격리를 수행할 때마다 정리 루틴이 같이 돈다.
정책은 "생성 30일 경과" OR "파일 10개 초과" 이중 조건이다. premigrate.bak과
rotation chain(`.bak.1/2/3`)은 이번 릴리스에서 자동 정리 대상이 아니다.
premigrate는 수동 삭제, rotation은 rename 체인 교체로 간접 정리된다.

### Q4. IPC 에러가 이전보다 자주 보여요.

실제 에러 빈도가 늘어난 것이 아니라, 이전에 조용히 무시되던 에러가 이제 사용자
UI에 표시되는 경우일 가능성이 높다. `wrapHandler`가 전 핸들러 공통 try/catch를
적용하면서 메인 프로세스 로그에 흔적이 남고, renderer 측에서도 `error.code`로
분류된 에러를 받게 된다. `DAEMON_DISCONNECTED`가 반복된다면 daemon 재기동 문제를
의심하고, `VALIDATION_ERROR`가 지속된다면 해당 payload를 만든 플러그인/호출부의
데이터 shape를 점검한다.

### Q5. 업그레이드 직후 첫 save 전에 앱이 죽으면 어떻게 되나요?

Lazy 마이그레이션이 메모리에서만 수행되므로, 새 포맷은 아직 디스크에 기록되지
않은 상태다. 다음 실행 시 동일한 primary 파일을 다시 load하고 다시 마이그레이션을
시도한다. `premigrate.bak`은 이미 한 번 존재하므로 재생성 skip된다. 결과적으로
데이터 상태는 업그레이드 직전과 동일하다.

---

## 6. References

- [`CHANGELOG.md`](../CHANGELOG.md) — 이번 릴리스 변경 사항 요약
- `decisions.md` D2, D3, D4, D5, D6, D7 — 이번 구현의 설계 근거
- `progress.md` T1a~T15 — 구현 태스크 목록과 파일 범위

문의는 프로젝트 이슈 트래커에 `stability-persistence` 라벨로 기재한다.
