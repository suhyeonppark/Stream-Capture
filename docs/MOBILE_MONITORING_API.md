# 모바일 모니터링 API 초안

Stream Watcher 데스크탑 앱이 내부망에서 모바일 앱에 상태를 제공하기 위한 API 계약이다.

목표는 스마트폰이 OBS, YouTube, LUFS를 직접 감시하지 않고, 송출 PC의 Stream Watcher가 판단한 상태를 읽기 전용으로 표시하는 것이다.

```text
송출 PC Stream Watcher
  ├─ OBS / YouTube / LUFS 수집
  ├─ 룰 엔진으로 이상 상태 판단
  └─ 내부망 모바일 API 제공

Flutter 앱
  ├─ 내부망에서 Stream Watcher에 연결
  ├─ 실시간 상태 표시
  ├─ 이상 상태 시 화면 점멸 / 진동 / 경고음
  └─ 알림 확인 처리
```

---

## 범위

### 포함

- 내부망 전용 모바일 대시보드
- Android / iOS Flutter 앱 연동
- 라이트 / 다크 모드 UI를 위한 상태값 제공
- 실시간 상태 갱신
- 경고 확인 처리
- 민감 정보가 빠진 읽기 전용 상태 제공

### 제외

- 외부 터널
- 클라우드 중계 서버
- 모바일 앱에서 OBS WebSocket 직접 연결
- 모바일 앱에서 YouTube OAuth 직접 처리
- Telegram / Discord / Kakao 같은 메신저 기능

---

## 엔드포인트

초기 MVP는 HTTP polling으로 시작하고, 이후 WebSocket 또는 SSE를 추가한다.

| Method | Path | 용도 |
| --- | --- | --- |
| `GET` | `/api/mobile/health` | 모바일 서버 생존 확인 |
| `POST` | `/api/mobile/pair` | PIN으로 모바일 기기 등록 및 token 발급 |
| `GET` | `/api/mobile/status` | 현재 모바일 표시용 전체 상태 조회 |
| `GET` | `/api/mobile/events` | SSE 실시간 상태 / 알림 스트림 |
| `GET` | `/api/mobile/scenario` | 현재 시나리오 단계와 단계 목록 조회 |
| `POST` | `/api/mobile/scenario/stage` | 모바일에서 현재 시나리오 단계 선택 |
| `POST` | `/api/mobile/ack` | 현재 활성 경고 확인 처리 |
| `WS` | `/mobile/ws` | 실시간 상태 push |

MVP 구현 우선순위:

1. `GET /api/mobile/health`
2. mDNS/Bonjour 광고
3. `POST /api/mobile/pair`
4. `GET /api/mobile/status`
5. `GET /api/mobile/events`
6. `GET /api/mobile/scenario`
7. `POST /api/mobile/scenario/stage`
8. `POST /api/mobile/ack`
9. `WS /mobile/ws`

---

## 자동탐색 / 보안 모델

Flutter 앱은 QR 없이 내부망에서 Stream Watcher를 자동탐색한다.

```text
PC 앱에서 모바일 모니터링 활성화
↓
PC 앱이 _streamwatcher._tcp.local 서비스를 mDNS/Bonjour로 광고
↓
Flutter 앱이 같은 Wi-Fi에서 Stream Watcher를 발견
↓
PC 앱 화면의 PIN을 Flutter 앱에 입력
↓
모바일 token 발급
↓
이후 요청마다 token 전달
```

서비스 광고:

| 항목 | 값 |
| --- | --- |
| Service type | `_streamwatcher._tcp.local` |
| Service name | `Stream Watcher - <PC 이름>` |
| TXT | `version`, `schemaVersion`, `serverId`, `requiresPin=true` |

권장 전달 방식:

```http
Authorization: Bearer <mobileToken>
```

초기 개발 중에는 토큰 검증을 옵션으로 둘 수 있지만, 배포 기본값은 켜는 것을 권장한다.

모바일 API 응답에는 아래 값을 절대 포함하지 않는다.

- OBS WebSocket 비밀번호
- YouTube OAuth client secret
- YouTube access token / refresh token
- Telegram Bot Token
- Discord Webhook URL
- Kakao / SOLAPI 인증 정보

---

## 상태 레벨

모바일 UI는 `summary.level`과 `activeAlert.level`을 기준으로 화면 강도를 결정한다.

| Level | 의미 | UI |
| --- | --- | --- |
| `ok` | 정상 | 기본 대시보드 |
| `info` | 상태 변화 알림 | 기본 대시보드 + 로그 |
| `warn` | 확인이 필요한 이상 | 상단 경고 배너, 약한 진동 |
| `critical` | 즉시 확인 필요 | 전체 경고 패널, 화면 점멸, 강한 진동 |
| `offline` | PC 앱 또는 수집 대상 연결 끊김 | 연결 끊김 화면 |

---

## `GET /api/mobile/health`

모바일 앱의 연결 테스트와 페어링 확인에 사용한다.

### Response

```json
{
  "ok": true,
  "name": "Stream Watcher",
  "version": "0.1.0",
  "schemaVersion": 1,
  "serviceType": "_streamwatcher._tcp.local",
  "discoveryEnabled": true,
  "serverId": "server_...",
  "requiresPin": true,
  "serverTime": 1710000000000
}
```

---

## `POST /api/mobile/pair`

PC 앱 설정 화면에 표시된 PIN으로 모바일 기기를 등록한다.

### Request

```json
{
  "pin": "123456",
  "deviceName": "Parks iPhone",
  "clientId": "phone-parks-iphone"
}
```

### Response

```json
{
  "ok": true,
  "token": "mobile-token",
  "serverId": "server_...",
  "device": {
    "id": "device_...",
    "name": "Parks iPhone",
    "clientId": "phone-parks-iphone",
    "pairedAt": 1710000000000,
    "lastSeenAt": 1710000000000
  }
}
```

정책:

- PIN은 PC 앱에서 생성하며 10분 동안 유효하다.
- 올바른 PIN으로 등록되면 PIN은 즉시 비워진다.
- `/api/mobile/status`와 `/api/mobile/ack`는 등록된 기기의 token을 요구한다.
- 등록된 기기가 없을 때는 개발 편의를 위해 token 없이 status를 볼 수 있다.

---

## `GET /api/mobile/status`

모바일 앱이 표시할 전체 상태를 반환한다.

### Response

```json
{
  "schemaVersion": 1,
  "app": {
    "name": "Stream Watcher",
    "siteName": "나눔교회 송출 모니터링",
    "version": "0.1.0"
  },
  "connection": {
    "serverIp": "192.168.0.23",
    "connected": true,
    "lastUpdatedAt": 1710000000000
  },
  "summary": {
    "level": "ok",
    "title": "정상 모니터링",
    "message": "OBS와 YouTube 상태가 정상입니다."
  },
  "obs": {
    "connected": true,
    "streaming": true,
    "recording": true,
    "scene": "Main",
    "bitrateKbps": 5820,
    "droppedFrames": 12,
    "droppedFramePct": 0.2,
    "renderSkippedFrames": 3,
    "cpuUsage": 8.4,
    "memoryUsageMb": 512,
    "updatedAt": 1710000000000
  },
  "youtube": {
    "connected": true,
    "live": true,
    "title": "주일예배 실황",
    "url": "https://youtube.com/watch?v=...",
    "broadcastStatus": "active",
    "streamStatus": "active",
    "healthStatus": "good",
    "configurationIssueCount": 0,
    "concurrentViewers": 42,
    "updatedAt": 1710000000000
  },
  "audio": {
    "status": "ok",
    "peakDb": -12.4,
    "silent": false,
    "updatedAt": 1710000000000
  },
  "lufs": {
    "connected": true,
    "status": "ok",
    "momentary": -15.8,
    "shortTerm": -16.1,
    "integrated": -17.0,
    "updatedAt": 1710000000000
  },
  "scenario": {
    "currentStageIndex": 1,
    "currentStageChangedAt": 1710000000000,
    "currentStage": {
      "index": 1,
      "id": "start",
      "title": "예배 시작",
      "note": "",
      "notify": true
    },
    "stages": [
      {
        "index": 0,
        "id": "standby",
        "title": "예배 준비",
        "note": "방송 시작 전 준비 상태를 확인합니다.",
        "notify": false
      },
      {
        "index": 1,
        "id": "start",
        "title": "예배 시작",
        "note": "",
        "notify": true
      }
    ]
  },
  "activeAlert": null,
  "recentAlerts": [
    {
      "id": "alert_1710000000000_audio",
      "level": "info",
      "title": "OBS 송출이 시작되었습니다.",
      "message": "OBS 송출이 시작되었습니다.",
      "source": "obs",
      "acknowledged": true,
      "createdAt": 1710000000000,
      "acknowledgedAt": 1710000005000
    }
  ]
}
```

---

## 활성 경고 예시

문제가 발생하면 `summary.level`과 `activeAlert`가 함께 바뀐다.

```json
{
  "summary": {
    "level": "critical",
    "title": "오디오가 감지되지 않습니다",
    "message": "오디오 상태를 확인하세요."
  },
  "audio": {
    "status": "critical",
    "peakDb": -78.0,
    "silent": true,
    "updatedAt": 1710000000000
  },
  "activeAlert": {
    "id": "alert_1710000000000_audio_silence",
    "level": "critical",
    "title": "오디오가 감지되지 않습니다",
    "message": "오디오 상태를 확인하세요.",
    "source": "audio",
    "acknowledged": false,
    "createdAt": 1710000000000,
    "acknowledgedAt": null
  }
}
```

모바일 앱 동작:

- `activeAlert.level === "critical"`이면 큰 경고 화면 표시
- `acknowledged === false`이면 점멸 / 진동 활성화
- 사용자가 탭하면 `/api/mobile/ack` 호출
- 확인 후에도 문제가 계속되면 경고 배너와 로그는 유지

---

## `POST /api/mobile/ack`

현재 활성 경고를 확인 처리한다.

### Request

```json
{
  "alertId": "alert_1710000000000_audio_silence",
  "clientId": "phone-parks-iphone",
  "acknowledgedAt": 1710000005000
}
```

### Response

```json
{
  "ok": true,
  "alertId": "alert_1710000000000_audio_silence",
  "acknowledged": true,
  "acknowledgedAt": 1710000005000
}
```

정책:

- `alertId`가 현재 활성 경고와 다르면 `409 Conflict`를 반환한다.
- 이미 확인된 경고면 `ok: true`를 반환한다.
- 확인은 모바일 경고 점멸을 멈추는 용도이며, 원본 알림 이력은 삭제하지 않는다.

---

## `GET /api/mobile/scenario`

현재 시나리오 단계와 모바일 단계 버튼 목록을 반환한다.

### Response

```json
{
  "currentStageIndex": 1,
  "currentStageChangedAt": 1710000000000,
  "currentStage": {
    "index": 1,
    "id": "start",
    "title": "예배 시작",
    "note": "",
    "notify": true
  },
  "stages": [
    { "index": 0, "id": "standby", "title": "예배 준비", "note": "방송 시작 전 준비 상태를 확인합니다.", "notify": false },
    { "index": 1, "id": "start", "title": "예배 시작", "note": "", "notify": true }
  ]
}
```

---

## `POST /api/mobile/scenario/stage`

스마트폰에서 현재 시나리오 단계를 선택한다.

### Request

```json
{
  "stageIndex": 2
}
```

### Response

```json
{
  "ok": true,
  "source": "mobile",
  "scenario": {
    "currentStageIndex": 2,
    "currentStageChangedAt": 1710000000000,
    "currentStage": {
      "index": 2,
      "id": "sermon",
      "title": "설교",
      "note": "설교 녹화가 켜져 있고 오디오 소스가 올바른지 확인합니다.",
      "notify": true
    },
    "stages": []
  }
}
```

정책:

- `stageIndex`는 서버에서 유효 범위로 clamp한다.
- 단계 변경은 데스크탑 화면과 모바일 SSE에 즉시 broadcast된다.
- 데스크탑에서 단계를 바꿔도 같은 API 상태가 갱신된다.

---

## `GET /api/mobile/events`

SSE(Server-Sent Events)로 모바일 상태를 실시간 push한다.

요청에는 페어링으로 받은 token을 전달한다.

```http
Authorization: Bearer <mobileToken>
```

주요 이벤트:

| Event | Payload |
| --- | --- |
| `status` | `/api/mobile/status`와 같은 전체 상태 |
| `alert` | 새 모바일 경고 |
| `ack` | 경고 확인 결과 |
| `scenario` | 현재 시나리오 단계 변경 |
| `paired` | 새 기기 페어링 결과 |
| `devicesCleared` | 등록 기기 초기화 |
| `ping` | 연결 유지용 서버 시간 |

Flutter 앱은 SSE를 기본 실시간 채널로 사용하고, 연결이 끊기면 `/api/mobile/status` polling으로 fallback한다.

---

## WebSocket 메시지

`/mobile/ws`는 상태 변경 시 현재 상태 전체를 push한다.

### Server -> Client

```json
{
  "type": "status",
  "payload": {
    "schemaVersion": 1
  }
}
```

경고가 새로 발생한 경우:

```json
{
  "type": "alert",
  "payload": {
    "id": "alert_1710000000000_audio_silence",
    "level": "critical",
    "title": "오디오가 감지되지 않습니다",
    "message": "오디오 상태를 확인하세요.",
    "source": "audio",
    "acknowledged": false,
    "createdAt": 1710000000000
  }
}
```

연결 유지:

```json
{
  "type": "ping",
  "serverTime": 1710000000000
}
```

---

## Flutter UI 테마 토큰

데스크탑 앱의 색상 결을 모바일에서도 유지한다.

### Light

| Token | Value |
| --- | --- |
| `bg` | `#f5f7fb` |
| `panel` | `#ffffff` |
| `panelSoft` | `#fbfcfe` |
| `border` | `#e1e7f0` |
| `text` | `#182235` |
| `muted` | `#647184` |
| `dim` | `#9ba8ba` |
| `accent` | `#2563eb` |
| `accentSoft` | `#edf4ff` |

### Dark

| Token | Value |
| --- | --- |
| `bg` | `#0f172a` |
| `panel` | `#111827` |
| `panelSoft` | `#172033` |
| `border` | `#263449` |
| `text` | `#e5edf8` |
| `muted` | `#9aa8bc` |
| `dim` | `#69768a` |
| `accent` | `#60a5fa` |
| `accentSoft` | `#102544` |

### Status

상태색은 라이트 / 다크 공통으로 시작한다.

| Token | Value |
| --- | --- |
| `ok` | `#16a34a` |
| `warn` | `#d97706` |
| `err` | `#dc2626` |

---

## 모바일 화면 구성

### 정상 모니터링

- 상단: 앱 이름, 연결 상태, 설정 버튼
- 연결 칩: OBS, YouTube, LUFS
- 상태 타일: OBS LIVE, YouTube LIVE, 비트레이트, 드롭률, LUFS, 오디오
- 오디오 미터 또는 LUFS 요약
- 최근 알림 3건
- 하단: 서버 IP, 마지막 갱신 시각

### 긴급 경고

- 기존 앱 헤더는 유지
- 큰 빨간 경고 패널 표시
- 메시지: `activeAlert.title`
- 보조 설명: `activeAlert.message`
- 화면 점멸 / 진동 / 선택적 경고음
- 화면 탭 또는 버튼으로 확인

### 확인됨

- 점멸과 진동 정지
- 상단 경고 배너 유지
- 해당 로그는 `확인됨`으로 표시
- 문제가 복구되면 정상 모니터링으로 자동 복귀

---

## 구현 메모

- 모바일 API 서버는 Electron main process에서 실행한다.
- 포트 기본값은 `53683`을 후보로 둔다.
- 서버 bind host는 내부망 접근을 위해 `0.0.0.0`이 필요하다.
- 설정 UI에는 모바일 모니터링 사용 여부, 자동탐색 사용 여부, 포트, 접속 URL, PIN 생성 버튼, 등록 기기 목록을 둔다.
- QR은 v1 필수 연결 방식에서 제외한다.
- Flutter 앱은 자동탐색 실패 시 수동 IP 입력으로 fallback한다.
- Flutter 앱은 WebSocket이 끊기면 polling으로 fallback한다.
