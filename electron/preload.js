const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  testNotify: (channel) => ipcRenderer.invoke('notify:test', channel),
  telegramChats: (botToken) => ipcRenderer.invoke('telegram:chats', botToken),
  obsSources: () => ipcRenderer.invoke('obs:sources'),
  obsScenes: () => ipcRenderer.invoke('obs:scenes'),
  obsAudioInputs: () => ipcRenderer.invoke('obs:audio-inputs'),
  sendScenarioAlert: (payload) => ipcRenderer.invoke('scenario:alert', payload),
  setScenarioStage: (payload) => ipcRenderer.invoke('scenario:set-stage', payload),

  kakaoStatus: () => ipcRenderer.invoke('kakao:status'),
  kakaoConnect: (params) => ipcRenderer.invoke('kakao:oauth-start', params),
  kakaoDisconnect: () => ipcRenderer.invoke('kakao:disconnect'),

  youtubeOauthStatus: () => ipcRenderer.invoke('youtube:oauth-status'),
  youtubeOauthConnect: (params) => ipcRenderer.invoke('youtube:oauth-start', params),
  youtubeOauthImportClient: () => ipcRenderer.invoke('youtube:oauth-import-client'),
  youtubeOauthDisconnect: () => ipcRenderer.invoke('youtube:disconnect'),
  youtubeDiagnose: () => ipcRenderer.invoke('youtube:diagnose'),

  getStartup: () => ipcRenderer.invoke('app:getStartup'),
  setAutoStart: (enabled) => ipcRenderer.invoke('app:setAutoStart', enabled),
  mobileStatus: () => ipcRenderer.invoke('mobile:status'),
  mobileGeneratePin: () => ipcRenderer.invoke('mobile:generate-pin'),
  mobileClearDevices: () => ipcRenderer.invoke('mobile:clear-devices'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),

  onObsState: (cb) => ipcRenderer.on('obs:state', (_, s) => cb(s)),
  onYoutubeState: (cb) => ipcRenderer.on('youtube:state', (_, s) => cb(s)),
  onLufsState: (cb) => ipcRenderer.on('lufs:state', (_, s) => cb(s)),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_, cfg) => cb(cfg)),
  onScenarioChanged: (cb) => ipcRenderer.on('scenario:changed', (_, payload) => cb(payload)),
  onAlert: (cb) => ipcRenderer.on('alert:new', (_, a) => cb(a)),
  onObsError: (cb) => ipcRenderer.on('obs:error', (_, e) => cb(e)),
  onYoutubeError: (cb) => ipcRenderer.on('youtube:error', (_, e) => cb(e)),
  onLufsError: (cb) => ipcRenderer.on('lufs:error', (_, e) => cb(e)),
  onBootError: (cb) => ipcRenderer.on('boot:error', (_, e) => cb(e)),
});
