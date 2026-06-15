# Stream Capture / 방송 상태 모니터링

OBS와 YouTube Live 상태를 동시에 감시하고, 방송 사고 징후가 보이면 Telegram, Discord, 카카오톡 채널로 알림을 보내는 Electron 데스크탑 앱이다.

목표는 단순한 상태 표시가 아니라, 실제 송출 현장에서 놓치기 쉬운 문제를 빠르게 발견해서 담당자에게 바로 전달하는 것이다.

---

## 핵심 개념

OBS와 YouTube는 서로 다른 상태를 의미한다.

```text
OBS     = 송출 PC가 인코딩하고 보내고 있는 상태
YouTube = 플랫폼이 실제로 신호를 받고 라이브로 처리하는 상태
```

예를 들어 OBS에서는 송출 중이어도 YouTube에는 아직 라이브가 감지되지 않을 수 있다. 반대로 YouTube가 라이브를 유지하고 있어도 OBS 연결이나 품질 상태가 나쁠 수 있다. 그래서 이 앱은 OBS와 YouTube를 따로 수집한 뒤, 룰 엔진에서 두 상태를 합쳐 알림 여부를 판단한다.

---

## 현재 구현된 기능

### OBS 모니터링

- OBS WebSocket v5 연결
- 송출 시작 / 종료 감지
- 녹화 시작 / 종료 감지
- 현재 프로그램 Scene 표시
- OBS CPU 사용률
- OBS 메모리 사용량
- 송출 비트레이트 계산
- 출력 드롭 프레임
- 렌더 스킵 프레임
- 출력 총 프레임
- 오디오 입력 레벨 감지
- 오디오 무음 감지
- 오디오 피크 감지 옵션

비트레이트는 OBS WebSocket의 `GetStreamStatus.outputBytes` 누적값을 폴링 간격마다 비교해서 계산한다. OBS WebSocket v5의 `GetStats`에는 `outputBytesPerSecond`가 없기 때문에, 누적 전송 바이트 증가량을 기준으로 kbps를 산출한다.

### YouTube Live 모니터링

- 현재 라이브 방송 자동 탐색
- YouTube 라이브 시작 / 종료 감지
- 방송 URL 자동 갱신
- 방송 제목 표시
- 동시 시청자 수 표시
- 활성 채팅 ID 표시
- OAuth 모드에서 liveBroadcasts / liveStreams 조회
- OAuth 모드에서 streamStatus 조회
- OAuth 모드에서 healthStatus 조회
- OAuth 모드에서 configurationIssues 조회

YouTube 모드는 두 가지가 있다.

| 모드 | 용도 | 특징 |
| --- | --- | --- |
| OAuth 모드 | 권장 | 방송 채널 계정으로 로그인해서 healthStatus, configurationIssues, streamStatus까지 조회 |
| API 키 모드 | fallback | 채널 ID 기준으로 현재 라이브를 탐색하고 기본 영상 정보만 조회 |

### LUFS 모니터링

- UDP로 들어오는 외부 LUFS 값을 수신
- momentary LUFS 표시
- short-term LUFS 표시
- integrated LUFS 표시
- short-term LUFS 평균 기준으로 과대 / 과소 / 복구 알림

LUFS는 OBS 자체 값이 아니라 외부 플러그인이나 별도 도구가 UDP로 보내는 값을 받는다. 앱 기본 수신 포트는 `49152`이다.

### 알림 채널

| 채널 | 구현 상태 | 비고 |
| --- | --- | --- |
| Telegram Bot | 구현 / 권장 | 여러 수신자에게 보내기 좋음. Chat ID 자동 등록 지원 |
| Discord Webhook | 구현 | Webhook URL만 있으면 전송 가능 |
| 카카오톡 나에게 보내기 | 구현 | 본인 계정으로만 전송 가능 |
| 카카오 비즈 / SOLAPI | 설정 UI 및 채널 구현 | 알림톡 템플릿, 발신번호, 수신번호 필요 |

### 데스크탑 앱 기능

- Electron 기반 Windows 데스크탑 앱
- 실시간 대시보드
- OBS / YouTube / LUFS 상태 표시
- 알림 로그 표시
- 비트레이트 / 드롭 프레임 시계열 차트
- 설정 UI
- 설정 저장 시 모니터 hot-reload
- 트레이 상주
- 창 닫기 시 트레이로 숨김
- Windows 로그인 시 자동 실행 옵션

---

## 알림 발송 조건

알림은 `src/core/rules/engine.js`에서 생성되고, `src/core/notify/notifier.js`에서 채널별 메시지로 전송된다.

### 공통 전제

- 알림 채널이 설정에서 켜져 있어야 한다.
- 채널별 필수 값이 있어야 한다.
- Telegram은 Bot Token과 Chat IDs가 필요하다.
- Discord는 Webhook URL이 필요하다.
- 카카오 나에게 보내기는 REST API 키와 OAuth 토큰이 필요하다.
- 카카오 비즈는 API Key, API Secret, 채널 연동 ID, 템플릿 ID, 발신번호, 수신번호가 필요하다.

### OBS 상태 알림

| 상황 | 조건 | 메시지 |
| --- | --- | --- |
| OBS 송출 시작 | `streaming: false -> true` | `OBS 송출이 시작되었습니다.` |
| OBS 송출 종료 | `streaming: true -> false` | `OBS 송출이 종료되었습니다.` |
| 녹화 시작 | `recording: false -> true` | `녹화가 시작되었습니다.` |
| 녹화 종료 | `recording: true -> false` | `녹화가 종료되었습니다.` |

앱 시작 직후에는 OBS의 오디오 미터 이벤트가 먼저 들어올 수 있다. 이 경우 `streaming` / `recording` 값이 없는 반쪽 상태는 룰 엔진으로 넘기지 않도록 처리되어 있다. 그래서 앱 시작 시 가짜 종료 알림이 나가지 않아야 한다.

### 오디오 무음 / 피크

| 상황 | 조건 | 메시지 |
| --- | --- | --- |
| 오디오 무음 | OBS가 송출 중이거나 녹화 중이고, YouTube 라이브 감지 후 지연 시간이 지난 뒤, 입력 peak가 기준 dBFS 미만으로 설정 시간 이상 지속 | `오디오가 감지되지 않습니다. 오디오 상태를 확인하세요.` |
| 오디오 피크 | `audioPeakEnabled`가 켜져 있고, 입력 peak가 기준 dBFS 이상 | `오디오 피크가 감지되었습니다. 오디오 상태를 확인하세요.` |

기본값:

| 설정 | 기본값 |
| --- | --- |
| 무음 기준 | `-65 dBFS` |
| 무음 지속 시간 | `5초` |
| 무음 감지 지연 | `60초` |
| 무음 쿨다운 | `60초` |
| 피크 감지 | 꺼짐 |
| 피크 기준 | `-1 dBFS` |
| 피크 쿨다운 | `5초` |

무음 알림은 대기 상태에서는 발생하지 않는다. OBS가 송출 중이거나 녹화 중일 때만 의미 있는 무음으로 판단한다.

### LUFS 알림

| 상황 | 조건 | 메시지 |
| --- | --- | --- |
| LUFS 너무 큼 | OBS가 송출 중이거나 녹화 중이고, YouTube 라이브 감지 후 지연 시간이 지난 뒤, 최근 short-term LUFS 평균이 상한 이상 | `적정 LUFS를 초과했습니다. 스트리밍 레벨을 조절해주세요.` |
| LUFS 너무 작음 | OBS가 송출 중이거나 녹화 중이고, YouTube 라이브 감지 후 지연 시간이 지난 뒤, 최근 short-term LUFS 평균이 하한 이하 | `적정 LUFS에 도달하지 못했습니다. 스트리밍 레벨을 조절해주세요.` |
| LUFS 복구 | LUFS 이상 상태였다가 복구 범위로 들어옴 | `적정 LUFS로 복구되었습니다.` |

기본값:

| 설정 | 기본값 |
| --- | --- |
| LUFS 알림 룰 | 켜짐 |
| 너무 큼 기준 | `-14 LUFS` 이상 |
| 너무 작음 기준 | `-25 LUFS` 이하 |
| 평균 계산 시간 | `15초` |
| 감지 지연 | `60초` |
| 복구 여유 | `1 LU` |
| 쿨다운 | `60초` |

LUFS 알림은 즉시 오지 않는다. 기본 설정에서는 YouTube 라이브 감지 후 60초가 지나야 하고, 그 뒤 최소 15초 치 short-term LUFS 샘플이 쌓여야 한다. 따라서 문제가 계속되고 있다면 첫 LUFS 알림은 대략 방송 시작 후 75초 이후부터 가능하다.

### 비트레이트 알림

| 상황 | 조건 | 메시지 |
| --- | --- | --- |
| 비트레이트 낮음 | OBS 송출 중, YouTube 라이브 감지 후 지연 시간이 지난 뒤, 계산된 비트레이트가 기준 미만 | `OBS 비트레이트가 기준보다 낮습니다.` |
| 비트레이트 복구 | 낮음 상태였다가 기준 이상으로 회복 | `OBS 비트레이트가 정상 범위로 복구되었습니다.` |

기본값:

| 설정 | 기본값 |
| --- | --- |
| 최소 비트레이트 | `1500 kbps` |
| 감지 지연 | `60초` |
| 쿨다운 | `60초` |

비트레이트는 OBS의 현재 UI 표시값과 100% 같지 않을 수 있다. 앱은 `outputBytes` 증가량으로 계산하고, OBS UI는 자체 샘플링 윈도우로 표시하기 때문이다. 그래도 정상 송출 중이면 대략 비슷한 범위로 표시되어야 한다.

### 드롭 프레임 알림

| 상황 | 조건 | 메시지 |
| --- | --- | --- |
| 드롭 프레임 높음 | OBS 송출 중, YouTube 라이브 감지 후 지연 시간이 지난 뒤, 최근 구간 드롭률이 기준 초과이고 최소 드롭 프레임 수 이상 | `OBS 드롭 프레임 비율이 높습니다.` |
| 드롭 프레임 복구 | 드롭 프레임 높음 상태였다가 드롭률이 기준의 절반 이하로 회복 | `OBS 드롭 프레임 비율이 정상으로 복구되었습니다.` |

기본값:

| 설정 | 기본값 |
| --- | --- |
| 최대 드롭률 | `5%` |
| 감지 구간 | `30초` |
| 최소 드롭 프레임 | `30프레임` |
| 감지 지연 | `60초` |
| 쿨다운 | `300초` |

### YouTube 알림

| 상황 | 조건 | 메시지 |
| --- | --- | --- |
| YouTube 라이브 시작 | YouTube 상태가 `live: false -> true` | `YouTube 라이브 방송이 시작되었습니다.` + URL |
| YouTube 라이브 종료 | YouTube 상태가 `live: true -> false` | `YouTube 라이브 방송이 종료되었습니다.` |
| YouTube 헬스 이상 | 라이브 중, 감지 후 60초 경과, healthStatus가 정상에서 `bad` 또는 `noData`로 변경 | `YouTube 스트림 헬스 이상이 감지되었습니다.` |
| YouTube 헬스 복구 | healthStatus가 `bad` / `noData`에서 정상으로 변경 | `YouTube 스트림 헬스가 정상으로 복구되었습니다.` |
| YouTube 설정 이슈 | 라이브 중, `severity: error`인 configuration issue가 새로 등장 | `YouTube 스트림 설정 이슈가 발생했습니다.` |

YouTube 시작 / 종료 알림은 기본 2분 중복 방지 쿨다운이 있다.

### 방송 리포트

룰 엔진은 OBS 송출 종료 시 방송 세션 리포트를 만든다.

리포트에 포함되는 값:

- 방송 시간
- 평균 LUFS
- 누적 시청자 샘플 합계
- 평균 시청자
- 최다 시청자
- 드롭 프레임
- 드롭률
- 스킵 프레임
- 평균 CPU
- 최대 CPU
- 방송 URL

현재 `OBS_STREAM_REPORT` 단독 이벤트는 실제 발송하지 않도록 막혀 있다. 대신 YouTube 라이브 종료 알림에 리포트가 있으면 리포트 형식으로 전송될 수 있다.

---

## 대시보드 화면

대시보드는 크게 다음 영역으로 구성된다.

- OBS 연결 상태
- YouTube 연결 상태
- Telegram 연결 상태
- OBS 송출 상태
- OBS 녹화 상태
- OBS 비트레이트
- OBS 드롭 프레임
- 현재 Scene
- YouTube 라이브 상태
- YouTube 제목
- YouTube URL
- YouTube Status / streamStatus
- configurationIssues
- 동시 시청자 수
- LUFS 수신 상태
- 비트레이트 / 드롭 프레임 차트
- 알림 로그

차트는 최근 약 5분 윈도우를 보여준다.

---

## 설정 저장 위치

설정은 `electron-store`로 로컬 PC에 저장된다.

Windows 개발 실행 기준 저장 파일:

```text
%APPDATA%\broadcast-health-checker\broadcast-health-checker.json
```

이 파일에는 OBS 비밀번호, YouTube OAuth 토큰, Telegram Bot Token, 카카오 토큰 같은 민감 정보가 저장된다. 공유하거나 Git에 커밋하면 안 된다.

---

## 설치 및 실행

### 요구 사항

- Node.js
- npm
- OBS Studio 28 이상
- OBS WebSocket 활성화
- YouTube Data API v3 설정

### 개발 실행

```powershell
npm install
npm start
```

디버그 실행:

```powershell
npm run dev
```

Windows 인스톨러 빌드:

```powershell
npm run build:win
```

---

## OBS 설정

1. OBS 실행
2. `도구` -> `WebSocket 서버 설정`
3. `WebSocket 서버 활성화` 체크
4. 포트 확인. 기본값은 `4455`
5. 비밀번호 설정 또는 확인
6. 앱 설정에서 OBS Host, Port, Password 입력

기본 설정:

| 항목 | 기본값 |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `4455` |
| Poll interval | `1000ms` |

OBS가 다른 PC에 있으면 Host에 해당 PC의 IP를 입력한다. 이 경우 방화벽에서 OBS WebSocket 포트를 허용해야 한다.

---

## YouTube OAuth 설정

OAuth 모드를 권장한다. OAuth 모드에서는 YouTube Live의 healthStatus와 configurationIssues까지 확인할 수 있다.

### 1. Google Cloud 프로젝트 생성

1. https://console.cloud.google.com 접속
2. 상단 프로젝트 선택
3. `새 프로젝트` 생성

### 2. YouTube Data API v3 활성화

1. `API 및 서비스` -> `라이브러리`
2. `YouTube Data API v3` 검색
3. `사용 설정`

### 3. OAuth 동의 화면 설정

1. `API 및 서비스` -> `OAuth 동의 화면`
2. User Type은 일반적으로 `외부`
3. 앱 이름, 사용자 지원 이메일, 개발자 연락처 입력
4. Scope에 아래 권한 추가

```text
https://www.googleapis.com/auth/youtube.readonly
```

앱이 검증 전이면 테스트 사용자에 실제 로그인할 Google 계정을 추가해야 한다.

### 4. OAuth Client ID 생성

1. `API 및 서비스` -> `사용자 인증 정보`
2. `사용자 인증 정보 만들기` -> `OAuth 클라이언트 ID`
3. 애플리케이션 유형: `데스크톱 앱`
4. 생성된 Client ID / Client Secret 복사

앱 기본 Redirect URI:

```text
http://127.0.0.1:53682/oauth/google
```

앱은 Google 로그인을 시스템 기본 브라우저에서 열고, 로컬 콜백 서버로 인증 코드를 받는다.

### 5. 앱에서 연결

1. 설정 화면으로 이동
2. YouTube OAuth 섹션에 Client ID / Client Secret 입력
3. `Google 연결` 클릭
4. 방송 채널을 가진 Google 계정으로 로그인
5. 연결 후 YouTube OAuth 상태가 연결됨으로 바뀌는지 확인

`client_secret_*.json` 파일이 있으면 `JSON 가져오기`로 불러올 수 있다.

---

## YouTube API 키 모드

OAuth가 어렵거나 임시로만 확인할 때 API 키 모드를 사용할 수 있다.

필요한 값:

- YouTube Data API v3 API Key
- Channel ID

API 키 모드는 현재 라이브 탐색과 기본 영상 정보 조회용이다. healthStatus와 configurationIssues는 OAuth 모드에서만 안정적으로 조회한다.

폴링 제한:

| 상태 | OAuth 모드 | API 키 모드 |
| --- | --- | --- |
| 라이브 중 | 최소 15초 이상 | 최소 60초 이상 |
| 라이브 없음 | 최소 30초 이상 | 최소 300초 이상 |

API 키 모드는 `search.list` quota 비용이 크기 때문에 라이브 없음 상태에서 폴링 간격이 길다.

---

## Telegram 설정

Telegram은 현재 가장 권장하는 알림 채널이다.

1. Telegram에서 `@BotFather` 대화 시작
2. `/newbot` 입력
3. 봇 이름과 username 지정
4. Bot Token 복사
5. 앱 설정 -> Telegram Bot Token 입력
6. 알림 받을 사람이 각자 봇과 1:1 대화 시작
7. 아무 메시지나 하나 전송
8. 앱에서 `Chat ID 모두 찾기` 클릭
9. Chat IDs가 채워지면 저장
10. 테스트 전송

Chat IDs는 줄바꿈, 쉼표, 공백으로 여러 개 입력할 수 있다.

`신규 Chat ID 자동 등록`이 켜져 있으면 앱이 30초마다 Telegram 업데이트를 확인해서 새 1:1 수신자를 자동으로 추가한다.

Telegram Bot API 특성상 봇이 일반 사용자의 개인 메시지로 보내려면 사용자가 먼저 봇과 대화를 시작해야 한다.

---

## Discord 설정

1. Discord 서버 설정
2. 연동 / Integrations
3. Webhooks
4. 새 Webhook 생성
5. Webhook URL 복사
6. 앱 설정 -> Discord Webhook URL 입력
7. Discord 알림 사용 체크
8. 테스트 전송

---

## 카카오톡 나에게 보내기 설정

카카오톡 나에게 보내기는 본인에게만 보낼 수 있다.

1. https://developers.kakao.com 접속
2. 내 애플리케이션 생성
3. 카카오 로그인 활성화
4. Redirect URI 등록
5. 동의항목에서 `카카오톡 메시지 전송(talk_message)` 활성화
6. 앱 설정에서 REST API 키 입력
7. 카카오 연결 실행
8. OAuth 완료 후 테스트 전송

다른 사람이나 단체방으로 직접 보내는 용도라면 Telegram 또는 Discord를 사용하는 편이 낫다.

---

## 카카오 비즈 / SOLAPI 설정

카카오 비즈 알림톡을 쓰려면 SOLAPI 쪽 설정이 필요하다.

필요한 값:

- API Key
- API Secret
- 채널 연동 ID
- 템플릿 ID
- 발신번호
- 수신번호 목록
- 템플릿 변수명
- SMS 대체 발송 여부

앱은 알림 메시지를 템플릿 변수에 넣어 전송한다. 템플릿 변수 기본값은 `#{message}`이다.

---

## LUFS UDP 연동

외부 OBS LUFS 플러그인 또는 별도 측정 도구가 UDP로 값을 보내면 앱이 수신한다.

기본 수신 설정:

| 항목 | 기본값 |
| --- | --- |
| Host | `0.0.0.0` |
| Port | `49152` |

같은 PC에서만 받을 경우 Host를 `127.0.0.1`로 설정해도 된다. 다른 PC나 장비에서 브로드캐스트로 보낼 경우 `0.0.0.0`을 사용한다.

권장 JSON payload:

```json
{
  "type": "lufs",
  "momentary": -13.6,
  "shortTerm": -14.2,
  "integrated": -15.1,
  "ts": 1710000000000
}
```

지원하는 주요 필드 이름:

- `momentary`
- `momentaryLufs`
- `momentary_lufs`
- `shortTerm`
- `shortTermLufs`
- `short_term`
- `short_term_lufs`
- `shortterm`
- `shortterm_lufs`
- `integrated`
- `integratedLufs`
- `integrated_lufs`

JSON이 아닌 텍스트도 일부 파싱한다. 예를 들어 `shortTerm: -14.2` 같은 문자열은 short-term 값으로 처리할 수 있다.

상세 설정은 [docs/LUFS_UDP_MANUAL.md](docs/LUFS_UDP_MANUAL.md)를 참고한다.

---

## 모바일 모니터링 구상

Android / iOS를 함께 지원하기 위해 Flutter 앱을 별도 companion 앱으로 두는 방향을 검토한다.

모바일 앱은 OBS, YouTube, LUFS를 직접 감시하지 않는다. 송출 PC에서 실행 중인 Stream Capture가 내부망 모바일 API를 열고, Flutter 앱은 그 상태를 읽어서 현장용 경보 화면으로 표시한다.

```text
Stream Capture 데스크탑 앱
  ├─ OBS / YouTube / LUFS 수집
  ├─ 룰 엔진으로 이상 상태 판단
  └─ 내부망 모바일 API 제공

Flutter 모바일 앱
  ├─ Android / iOS 지원
  ├─ 라이트 / 다크 모드
  ├─ 상태 대시보드
  ├─ 긴급 경고 시 화면 점멸
  ├─ 진동 / 선택적 경고음
  └─ 경고 확인 처리
```

외부 터널이나 클라우드 중계 서버는 우선 범위에서 제외하고, 내부망 전용으로 시작한다.

PC 앱은 `_streamwatcher._tcp.local` mDNS/Bonjour 서비스로 내부망에 자신을 광고한다. Flutter 앱은 같은 Wi-Fi에서 자동으로 PC를 찾고, 처음 연결할 때 PC 설정 화면의 PIN을 입력해 모바일 기기 token을 발급받는다. 자동탐색이 막힌 네트워크에서는 수동 IP 입력으로 연결한다.

실시간 상태는 우선 SSE(`/api/mobile/events`)로 제공하고, Flutter 앱은 연결이 끊기면 `/api/mobile/status` polling으로 fallback한다.

시나리오 진행 단계도 모바일 API에 포함된다. 스마트폰에서 단계 버튼을 누르면 현재 단계가 PC 앱과 모바일 앱에 동시에 반영된다.

모바일 API 계약 초안은 [docs/MOBILE_MONITORING_API.md](docs/MOBILE_MONITORING_API.md)를 참고한다.

---

## 설정 기본값

주요 기본값은 `src/config/store.js`에 있다.

### OBS

| 항목 | 기본값 |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `4455` |
| Poll interval | `1000ms` |

### YouTube

| 항목 | 기본값 |
| --- | --- |
| Poll interval | `15000ms` |
| OAuth Redirect URI | `http://127.0.0.1:53682/oauth/google` |

### LUFS

| 항목 | 기본값 |
| --- | --- |
| Enabled | `true` |
| Host | `0.0.0.0` |
| Port | `49152` |

### Mobile

| 항목 | 기본값 |
| --- | --- |
| Enabled | `true` |
| Host | `0.0.0.0` |
| Port | `53683` |
| Discovery | `true` |
| Service type | `_streamwatcher._tcp.local` |

### Rules

| 항목 | 기본값 |
| --- | --- |
| audioSilenceSeconds | `5` |
| audioSilenceDb | `-65` |
| audioSilenceStartupDelayMs | `60000` |
| audioSilenceCooldownMs | `60000` |
| audioPeakEnabled | `false` |
| audioPeakDb | `-1` |
| audioPeakCooldownMs | `5000` |
| lufsEnabled | `true` |
| lufsHighThreshold | `-14` |
| lufsLowThreshold | `-25` |
| lufsDurationSeconds | `15` |
| lufsStartupDelayMs | `60000` |
| lufsRecoveryMargin | `1` |
| lufsCooldownMs | `60000` |
| bitrateMinKbps | `1500` |
| bitrateStartupDelayMs | `60000` |
| bitrateCooldownMs | `60000` |
| droppedFramePctMax | `5.0` |
| droppedFrameWindowSeconds | `30` |
| droppedFrameMinFrames | `30` |
| droppedFrameStartupDelayMs | `60000` |
| droppedFrameCooldownMs | `300000` |
| youtubeEventCooldownMs | `120000` |

저장된 설정에 숫자 값이 비어 있거나 `null`이면 앱 시작 또는 설정 로드 시 기본값으로 정규화한다.

---

## 아키텍처

```text
electron/main.js
  ├─ 앱 시작 / 종료
  ├─ BrowserWindow 생성
  ├─ Tray 생성
  ├─ IPC 핸들러
  ├─ 설정 정규화
  ├─ OBS / YouTube / LUFS 모니터 시작
  └─ 룰 엔진과 알림 채널 연결

electron/preload.js
  └─ renderer에서 사용할 안전한 window.api 노출

src/core/
  ├─ obs/
  │   ├─ client.js      OBS WebSocket v5 래퍼
  │   └─ monitor.js     OBS 상태 폴링 + 오디오 미터 이벤트 수집
  ├─ youtube/
  │   ├─ client.js      YouTube Data API v3 클라이언트
  │   ├─ monitor.js     라이브 탐색 및 상태 폴링
  │   └─ oauth.js       Google OAuth 로컬 콜백 플로우
  ├─ lufs/
  │   └─ receiver.js    UDP LUFS 수신기
  ├─ rules/
  │   └─ engine.js      상태 변화 감지 및 알림 이벤트 생성
  └─ notify/
      ├─ notifier.js    메시지 포맷 및 채널 디스패치
      ├─ telegram.js
      ├─ discord.js
      ├─ kakao.js
      ├─ kakao-oauth.js
      └─ kakao-biz.js

docs/
  ├─ LUFS_UDP_MANUAL.md
  └─ MOBILE_MONITORING_API.md

src/renderer/
  ├─ index.html         대시보드 / 설정 UI
  ├─ index.css          스타일
  └─ app.js             IPC 수신, 화면 업데이트, 설정 저장
```

---

## 디렉토리 구조

```text
.
├── assets/
│   ├── app-icon.ico
│   ├── app-icon.png
│   └── tray-icon.png
├── config/
│   └── settings.example.json
├── docs/
│   └── LUFS_UDP_MANUAL.md
├── electron/
│   ├── main.js
│   └── preload.js
├── scripts/
│   ├── generate-icon.js
│   └── start.js
├── src/
│   ├── config/
│   ├── core/
│   └── renderer/
├── package.json
├── package-lock.json
└── README.md
```

---

## 운영 시나리오

### 방송 시작 전

1. OBS 실행
2. OBS WebSocket 연결 확인
3. 앱 실행
4. YouTube OAuth 연결 확인
5. Telegram 또는 다른 알림 채널 테스트 전송
6. LUFS 수신 상태 확인
7. OBS에서 송출 시작

### 방송 시작 직후

예상 알림 흐름:

```text
OBS 송출이 시작되었습니다.
YouTube 라이브 방송이 시작되었습니다.
```

품질 알림은 기본적으로 바로 오지 않는다. 무음, LUFS, 비트레이트, 드롭 프레임은 YouTube 라이브 감지와 OBS 송출 시작 후 지정된 지연 시간이 지나야 판단한다.

### 방송 중

앱에서 확인할 항목:

- OBS 비트레이트가 예상 범위인지
- 드롭 프레임이 증가하는지
- YouTube healthStatus가 나빠지는지
- configurationIssues가 생기는지
- LUFS가 정상 범위인지
- 동시 시청자 수가 갱신되는지

### 방송 종료

예상 알림 흐름:

```text
OBS 송출이 종료되었습니다.
YouTube 라이브 방송이 종료되었습니다.
```

녹화도 같이 종료되면 녹화 종료 알림도 별도로 전송된다.

---

## 트러블슈팅

### OBS 비트레이트가 0으로 보일 때

확인할 것:

- OBS가 실제로 송출 중인지
- OBS WebSocket이 연결되어 있는지
- 앱이 최신 코드로 재시작되었는지
- `GetStreamStatus.outputBytes`가 증가하는지

앱은 `outputBytes` 누적 증가량으로 비트레이트를 계산한다. 송출 시작 직후 첫 샘플에서는 기준값만 잡기 때문에 1초 정도 값이 비어 보일 수 있다.

### 방송 시작 직후 품질 알림이 너무 빨리 올 때

설정에서 아래 값이 `0` 또는 비어 있지 않은지 확인한다.

- 무음 감지 지연
- LUFS 감지 지연
- 비트 감지 지연
- 드롭 감지 지연

기본값은 모두 `60초`이다.

### LUFS 알림이 안 올 때

확인할 것:

- 설정에서 LUFS 수신이 켜져 있는지
- 설정에서 LUFS 알림 룰이 켜져 있는지
- UDP 포트가 맞는지
- 방화벽에서 UDP 수신이 막히지 않았는지
- payload에 `shortTerm` 또는 이에 준하는 값이 있는지
- OBS가 송출 중이거나 녹화 중인지
- YouTube 라이브 감지 후 지연 시간이 지났는지
- 최근 15초 평균이 기준 밖인지

LUFS 값이 정상 범위이면 알림은 오지 않는다.

### 앱 시작 시 송출 종료 / 녹화 종료가 먼저 올 때

OBS 초기 상태가 잡히기 전에 오디오 미터 이벤트가 먼저 들어오면 가짜 종료 알림이 발생할 수 있었다. 현재는 `streaming` / `recording` 값이 없는 초기 오디오 이벤트를 무시하도록 처리되어 있다.

### YouTube 라이브가 늦게 감지될 때

YouTube API 폴링 주기와 YouTube 자체 상태 반영 지연 때문에 약간 늦을 수 있다.

API 키 모드는 quota 절약 때문에 라이브 없음 상태에서 최대 5분 간격으로 폴링한다. 빠른 감지를 원하면 OAuth 모드를 사용한다.

### Telegram 메시지가 안 올 때

확인할 것:

- Telegram 알림 사용 체크
- Bot Token 입력
- Chat IDs 입력
- 수신자가 봇과 1:1 대화를 먼저 시작했는지
- 테스트 전송이 성공하는지

---

## 보안 주의

다음 값은 외부에 공개하면 안 된다.

- OBS WebSocket 비밀번호
- YouTube OAuth Client Secret
- YouTube access token
- YouTube refresh token
- Telegram Bot Token
- Discord Webhook URL
- Kakao REST API Key
- Kakao access token
- Kakao refresh token
- SOLAPI API Key / Secret

특히 `%APPDATA%\broadcast-health-checker\broadcast-health-checker.json` 파일은 민감 정보가 들어 있으므로 공유하지 않는다.

---

## 로드맵

- [x] Electron 앱 부트스트랩
- [x] OBS WebSocket v5 연결
- [x] OBS 송출 / 녹화 상태 감지
- [x] OBS 오디오 미터 수신
- [x] 오디오 무음 감지
- [x] 오디오 피크 감지 옵션
- [x] OBS 비트레이트 계산
- [x] 드롭 프레임 감지
- [x] YouTube API 키 기반 라이브 탐색
- [x] YouTube OAuth 연결
- [x] YouTube healthStatus / configurationIssues 조회
- [x] LUFS UDP 수신
- [x] LUFS 과대 / 과소 / 복구 알림
- [x] Telegram 알림
- [x] Discord 알림
- [x] 카카오 나에게 보내기
- [x] 카카오 비즈 / SOLAPI 채널
- [x] 설정 UI
- [x] 설정 저장 시 모니터 재시작
- [x] 비트레이트 / 드롭 프레임 차트
- [x] 트레이 상주
- [x] Windows 로그인 시 자동 실행 옵션
- [ ] Windows 인스톨러 빌드 검증
- [ ] 알림 이력 파일 저장
- [ ] 방송 리포트 별도 저장 / 내보내기
- [ ] 룰 프리셋 기능
- [ ] 모바일 모니터링 API
- [ ] Flutter companion 앱
- [ ] 모바일 라이트 / 다크 모드
- [ ] 모바일 화면 점멸 / 진동 경고

---

## 라이선스

MIT
