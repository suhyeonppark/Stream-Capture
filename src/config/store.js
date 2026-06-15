const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const Store = require('electron-store');

const defaults = {
  app: {
    autoStart: false,
    minimizeToTrayOnClose: true,
  },
  mobile: {
    enabled: true,
    host: '0.0.0.0',
    port: 53683,
    discoveryEnabled: true,
    serverId: '',
    pairingPin: '',
    pairingPinExpiresAt: 0,
    devices: [],
    token: '',
  },
  obs: {
    host: '127.0.0.1',
    port: 4455,
    password: '',
    pollIntervalMs: 1000,
  },
  youtube: {
    apiKey: '',
    channelId: '',
    pollIntervalMs: 15000,
    oauth: {
      clientId: '',
      clientSecret: '',
      redirectUri: 'http://127.0.0.1:53682/oauth/google',
      accessToken: '',
      refreshToken: '',
      tokenAcquiredAt: 0,
      expiresIn: 0,
      expiryDate: 0,
      clientJsonPath: '',
    },
  },
  lufs: {
    enabled: true,
    host: '0.0.0.0',
    port: 49152,
  },
  scenario: {
    currentStageIndex: 0,
    currentStageChangedAt: 0,
    stages: [
      { id: 'standby', title: '예배 준비', note: '방송 시작 전 준비 상태를 확인합니다.', notify: false, checks: { scene: { enabled: true, expected: '예배준비' }, audio: { enabled: false, expected: '' }, recording: { enabled: false, expected: false } } },
      { id: 'start', title: '예배 시작', notify: true, checks: { scene: { enabled: true, expected: '' }, audio: { enabled: true, expected: '' }, recording: { enabled: false, expected: false } } },
      { id: 'sermon', title: '설교', note: '설교 녹화가 켜져 있고 오디오 소스가 올바른지 확인합니다.', notify: true, checks: { scene: { enabled: true, expected: '' }, audio: { enabled: true, expected: '' }, recording: { enabled: true, expected: true } } },
      { id: 'closing', title: '마무리', note: '마무리 단계의 송출 상태와 녹화 상태를 확인합니다.', notify: true, checks: { scene: { enabled: false, expected: '' }, audio: { enabled: false, expected: '' }, recording: { enabled: false, expected: false } } },
    ],
    alertDelayMs: 5000,
  },
  notify: {
    kakao: {
      enabled: false,
      accessToken: '',
      refreshToken: '',
      restApiKey: '',
      redirectUri: 'https://localhost/oauth/kakao',
      tokenAcquiredAt: 0,
      expiresIn: 0,
    },
    kakaoBiz: {
      enabled: false,
      apiKey: '',
      apiSecret: '',
      pfId: '',
      templateId: '',
      from: '',
      recipients: '',
      variableName: '#{message}',
      disableSms: true,
    },
    discord: {
      enabled: false,
      webhookUrl: '',
    },
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
      chatIds: '',
      autoDiscover: true,
    },
  },
  rules: {
    audioSilenceSeconds: 5,
    audioSilenceDb: -65,
    audioSilenceStartupDelayMs: 60000,
    audioSilenceCooldownMs: 60000,
    audioPeakEnabled: false,
    audioPeakDb: -1,
    audioPeakCooldownMs: 5000,
    lufsEnabled: true,
    lufsHighThreshold: -14,
    lufsLowThreshold: -25,
    lufsDurationSeconds: 15,
    lufsStartupDelayMs: 60000,
    lufsRecoveryMargin: 1,
    lufsCooldownMs: 60000,
    bitrateMinKbps: 1500,
    bitrateStartupDelayMs: 60000,
    bitrateCooldownMs: 60000,
    droppedFramePctMax: 5.0,
    droppedFrameWindowSeconds: 30,
    droppedFrameMinFrames: 30,
    droppedFrameStartupDelayMs: 60000,
    droppedFrameCooldownMs: 300000,
  },
};

// 앱 이름이 바뀌면(productName/app name) 설정 폴더·파일명도 바뀌므로,
// 직전 이름들('Stream Watcher', 'Stream Mon')의 설정을 새 'Stream Capture'로 1회 복사해 보존한다.
function migrateLegacyConfig() {
  try {
    const newFile = path.join(app.getPath('userData'), 'Stream Capture.json');
    if (fs.existsSync(newFile)) return; // 이미 마이그레이션됨
    const appData = app.getPath('appData');
    const candidates = [
      // 직전 이름: Stream Watcher
      path.join(appData, 'Stream Watcher', 'Stream Watcher.json'),
      path.join(appData, '방송 상태 모니터링', 'Stream Watcher.json'),
      path.join(appData, 'broadcast-health-checker', 'Stream Watcher.json'),
      // 그 이전 이름: Stream Mon
      path.join(appData, 'STREAM MON', 'Stream Mon.json'),
      path.join(appData, 'Stream Mon', 'Stream Mon.json'),
      path.join(appData, 'broadcast-health-checker', 'Stream Mon.json'),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) return;
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.copyFileSync(src, newFile);
  } catch {}
}

migrateLegacyConfig();

const store = new Store({ defaults, name: 'Stream Capture' });

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// 중첩 객체는 재귀 병합, 배열/원시값/null은 그대로 교체.
// (electron-store의 set은 키를 통째로 덮어쓰기 때문에, 부분 저장 시
//  youtube.oauth 토큰·mobile.devices·notify 토큰 등 폼에 없는 필드가 사라지는 것을 막는다.)
function deepMerge(target, source) {
  if (!isPlainObject(source)) return source;
  const base = isPlainObject(target) ? target : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(source)) {
    out[k] = isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

module.exports = {
  getAll: () => store.store,
  get: (key) => store.get(key),
  set: (key, value) => store.set(key, value),
  update: (partial) => {
    for (const [k, v] of Object.entries(partial)) {
      store.set(k, deepMerge(store.get(k), v));
    }
    return store.store;
  },
};
