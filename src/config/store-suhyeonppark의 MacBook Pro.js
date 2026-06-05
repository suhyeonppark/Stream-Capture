const Store = require('electron-store');

const defaults = {
  app: {
    autoStart: false,
    minimizeToTrayOnClose: true,
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
    pollIntervalMs: 180000, // API 키 모드: search.list는 100쿼터/호출, 하루 10,000 쿼터 → 최소 3분 간격
    oauth: {
      clientId: '',
      clientSecret: '',
      redirectUri: 'http://127.0.0.1/oauth/google',
      accessToken: '',
      refreshToken: '',
      tokenAcquiredAt: 0,
      expiresIn: 0,
    },
  },
  notify: {
    kakao: {
      enabled: false,
      mode: 'memo',           // 'memo' | 'channel'
      channelPublicId: '',    // 채널 모드 시 채널 공개 ID (예: _xmknSd)
      accessToken: '',
      refreshToken: '',
      restApiKey: '',
      redirectUri: 'https://localhost/oauth/kakao',
      tokenAcquiredAt: 0,
      expiresIn: 0,
    },
    discord: {
      enabled: false,
      webhookUrl: '',
    },
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
    },
  },
  rules: {
    audioSilenceSeconds: 3,
    audioSilenceDb: -50,
    audioPeakDb: -1,
    audioPeakCooldownMs: 5000,
    bitrateMinKbps: 1500,
    droppedFramePctMax: 1.0,
  },
};

const store = new Store({ defaults, name: 'broadcast-health-checker' });

module.exports = {
  getAll: () => store.store,
  get: (key) => store.get(key),
  set: (key, value) => store.set(key, value),
  update: (partial) => {
    for (const [k, v] of Object.entries(partial)) {
      store.set(k, v);
    }
    return store.store;
  },
};
