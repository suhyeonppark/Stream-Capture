# LUFS UDP 연동 매뉴얼

Stream Watcher는 외부에서 보내주는 LUFS 측정값을 UDP로 받아 Short-term LUFS 과대/과소를 감지한다. 이 문서는 송신측(OBS LUFS 플러그인 또는 별도 측정기)을 어떻게 묶을지, 같은 PC가 아닌 별도 송출 PC에서 어떻게 브로드캐스트로 흘릴지, 페이로드는 어떤 형식까지 허용되는지를 정리한다.

코드 진입점은 [src/core/lufs/receiver.js](../src/core/lufs/receiver.js)이다. 룰 판정은 [src/core/rules/engine.js](../src/core/rules/engine.js)의 `checkLufs`가 담당하며, 송출/녹화 중이고 YouTube 라이브가 감지된 뒤 `lufsStartupDelayMs`가 지난 시점부터만 알림을 발사한다.

---

## 1. 네트워크 기본 정보

| 항목 | 기본값 | 위치 |
| --- | --- | --- |
| 프로토콜 | UDP (IPv4) | [receiver.js:16](../src/core/lufs/receiver.js#L16) |
| 바인딩 주소 | `0.0.0.0` (모든 인터페이스) | 설정 `lufs.host` |
| 포트 | `49152` | 설정 `lufs.port` |
| 페이로드 인코딩 | UTF-8 텍스트 (JSON 권장) | [receiver.js:39](../src/core/lufs/receiver.js#L39) |

기본 바인딩이 `0.0.0.0`이므로 다음 세 가지 송신 방식이 모두 수신된다.

1. **같은 PC 루프백**: 송신측이 `127.0.0.1:49152`로 쏨
2. **같은 PC LAN 인터페이스**: 다른 PC가 모니터링 PC의 LAN IP(`192.168.x.x:49152`)로 직접 유니캐스트
3. **LAN 브로드캐스트**: 송신측이 `255.255.255.255:49152` 또는 서브넷 브로드캐스트(`192.168.0.255:49152` 등)로 쏨 — 같은 LAN의 모든 PC가 받음

외부 노출이 부담스러우면 앱 설정 → "LUFS 수신 주소"를 `127.0.0.1`로 되돌린다. 이 경우 같은 PC의 루프백 송신만 수신한다.

---

## 2. 페이로드 포맷

### 2.1 권장: JSON 한 줄

```json
{
  "type": "lufs",
  "momentary": -13.6,
  "shortTerm": -14.2,
  "integrated": -15.1,
  "ts": 1710000000000
}
```

- 모든 필드 옵셔널. `momentary` / `shortTerm` / `integrated` 중 **최소 하나**가 유효해야 데이터로 인정된다.
- `shortTerm`이 없으면 룰 엔진의 LUFS 알림은 동작하지 않는다 ([engine.js:96](../src/core/rules/engine.js#L96)). Momentary/Integrated만 보내면 대시보드에는 표시되지만 알림은 발사되지 않는다.
- `ts`는 epoch milliseconds. 없으면 수신 시각으로 채워진다.

### 2.2 키 이름 변형 허용

다음 변형은 모두 같은 메트릭으로 인식된다 ([receiver.js:48-71](../src/core/lufs/receiver.js#L48-L71)). 플러그인이 어떤 케이스를 쓰든 그대로 보내면 된다.

| 메트릭 | 허용되는 키 |
| --- | --- |
| Momentary | `momentary`, `momentaryLufs`, `momentary_lufs`, `momentaryLUFS` |
| Short-term | `shortTerm`, `shortTermLufs`, `short_term`, `short_term_lufs`, `shortterm`, `shortterm_lufs`, `shortTermLUFS` |
| Integrated | `integrated`, `integratedLufs`, `integrated_lufs`, `integratedLUFS` |

중첩된 객체 안에 있어도 키 이름이 위 단어들을 포함하면 재귀적으로 찾아낸다. 예시:

```json
{ "loudness": { "short_term_lufs": -14.2 } }
```

### 2.3 텍스트 폴백

JSON 파싱이 실패하면 정규식으로 숫자 추출을 시도한다 ([receiver.js:113-130](../src/core/lufs/receiver.js#L113-L130)). 다음 모두 인식된다:

```
short_term: -14.2
ST -14.2
M -13.6 I -15.1
-14.2
```

마지막 케이스(숫자 한 개)는 Short-term으로 해석된다. 디버깅용으로만 쓰고 프로덕션은 JSON으로 보내라.

---

## 3. 시나리오별 송신측 설정

### 3.1 같은 PC: 루프백

기본값이다. 송신측에서 `127.0.0.1:49152`로 UDP 패킷을 쏘면 끝이다. 수신측 host는 `127.0.0.1`/`0.0.0.0` 둘 다 동작한다.

### 3.2 다른 PC: 직접 유니캐스트

송출 PC가 모니터링 PC로 직접 쏘는 방식. 가장 권장된다.

- 모니터링 PC의 LAN IP 확인: PowerShell에서 `ipconfig` → "이더넷" 또는 "Wi-Fi"의 IPv4 주소 (예: `192.168.0.42`)
- 송신측 플러그인 destination: `192.168.0.42:49152`
- 모니터링 PC의 Windows Defender 방화벽에서 인바운드 UDP 49152 허용 (4번 항목 참고)

### 3.3 다른 PC: 브로드캐스트

송신측이 모니터링 PC의 IP를 모르거나, 여러 모니터링 PC에 동시에 뿌리고 싶을 때.

- 송신측이 `255.255.255.255:49152` (전체 브로드캐스트) 또는 서브넷 브로드캐스트(`192.168.0.255:49152`)로 쏨
- 송신측 코드/플러그인에서 broadcast 옵션 활성화 필요 (Node.js `dgram` 기준 `socket.setBroadcast(true)`)
- 라우터/스위치가 브로드캐스트를 차단하지 않아야 함 (대부분 기본 통과)
- 수신측 `lufs.host`는 반드시 `0.0.0.0`이어야 함 (`127.0.0.1`로 묶으면 브로드캐스트는 안 들어옴)

> 보안 주의: 브로드캐스트 모드에서는 같은 LAN의 누구나 49152로 임의 페이로드를 쏠 수 있어 LUFS 값을 조작해 거짓 알림을 유발할 수 있다. 신뢰된 LAN(스튜디오 내부망)에서만 쓴다.

---

## 4. 방화벽 설정 (Windows)

원격 PC에서 보내는 경우 모니터링 PC의 인바운드 방화벽에 49152/UDP를 열어야 한다. PowerShell을 **관리자 권한**으로 실행:

```powershell
New-NetFirewallRule `
  -DisplayName "Stream Watcher LUFS UDP" `
  -Direction Inbound `
  -Protocol UDP `
  -LocalPort 49152 `
  -Action Allow `
  -Profile Private,Domain
```

`Profile Public`은 피한다 — 외부망에 노출시키지 않기 위함. 카페/공항 등에서 실수로 풀리는 걸 막는다.

규칙 제거:

```powershell
Remove-NetFirewallRule -DisplayName "Stream Watcher LUFS UDP"
```

---

## 5. 송신측 자가 점검

### 5.1 PowerShell로 직접 송신 테스트

송신측에서 다음을 실행하면 모니터링 PC에 단발 패킷을 보낼 수 있다 (PowerShell):

```powershell
$payload = '{"type":"lufs","shortTerm":-14.2,"ts":' + [int64](Get-Date -UFormat %s) * 1000 + '}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$udp = New-Object System.Net.Sockets.UdpClient
$udp.Send($bytes, $bytes.Length, "192.168.0.42", 49152) | Out-Null
$udp.Close()
```

브로드캐스트로 보내려면 `EnableBroadcast` 활성화:

```powershell
$payload = '{"type":"lufs","shortTerm":-14.2}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$udp = New-Object System.Net.Sockets.UdpClient
$udp.EnableBroadcast = $true
$udp.Send($bytes, $bytes.Length, "255.255.255.255", 49152) | Out-Null
$udp.Close()
```

### 5.2 수신측 수신 확인

대시보드의 LUFS 카드에 Short-term 값이 즉시 들어오는지, 또는 앱 로그에 `LufsReceiver` ready 이벤트가 떴는지 확인한다.

---

## 6. 룰 엔진 동작 요약

LUFS 알림이 발사되려면 모든 조건이 충족돼야 한다:

1. 설정 → "Short-term LUFS 알림" 켜져 있음 (`rules.lufsEnabled`)
2. OBS가 송출 중 또는 녹화 중 ([engine.js:98](../src/core/rules/engine.js#L98))
3. YouTube 라이브가 감지된 상태이고 감지 시점에서 `lufsStartupDelayMs`(기본 60초)가 지남
4. 최근 `lufsDurationSeconds`(기본 15초) 동안의 Short-term 평균이 임계치를 벗어남
5. 같은 방향의 직전 알림에서 `lufsCooldownMs`(기본 60초) 경과

복구 알림(`LUFS_RECOVERED`)은 평균이 `[low + margin, high - margin]` 안으로 돌아오면 발사된다.

따라서 LUFS 값을 보내는 것 자체와 알림이 울리는 것은 별개다. 대기 상태/녹화 안 함/YouTube 라이브 미감지 등에서는 데이터만 수집되고 알림은 침묵한다.

---

## 7. 트러블슈팅

| 증상 | 점검 |
| --- | --- |
| 대시보드에 LUFS 값이 안 뜸 | 송신측 IP/포트, 방화벽 인바운드 UDP 49152, `lufs.host` 설정 확인 |
| 값은 뜨는데 알림이 안 옴 | 송출 중/녹화 중 여부, YouTube 라이브 감지 여부, 60초 startup delay 경과, 임계치 범위 |
| 브로드캐스트가 안 들어옴 | `lufs.host`가 `0.0.0.0`인지 확인. `127.0.0.1`은 루프백만 수신함 |
| 값이 이상하게 튐 (예: NaN, 0) | 송신 페이로드의 키 이름이 [2.2](#22-키-이름-변형-허용) 표에 있는지 확인. 매칭 안 되면 무시됨 |
| 멀티 모니터링 PC에 같은 값을 뿌리고 싶음 | 브로드캐스트 모드 사용 ([3.3](#33-다른-pc-브로드캐스트)) |
| 외부망에 노출이 걱정 | `lufs.host`를 `127.0.0.1`로 되돌리거나, 방화벽 Profile에서 `Public` 제외 |

---

## 8. 참고: 관련 설정

[config/settings.example.json](../config/settings.example.json)의 관련 키:

```json
{
  "lufs": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 49152
  },
  "rules": {
    "lufsEnabled": true,
    "lufsHighThreshold": -14,
    "lufsLowThreshold": -25,
    "lufsDurationSeconds": 15,
    "lufsStartupDelayMs": 60000,
    "lufsRecoveryMargin": 1,
    "lufsCooldownMs": 60000
  }
}
```
