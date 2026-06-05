const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');

// userData 경로(%APPDATA%\<name>)를 결정하므로 다른 모듈 require보다 먼저 호출해야 함
app.setName('Stream Watcher');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');

const ObsMonitor = require('../src/core/obs/monitor');
const YoutubeMonitor = require('../src/core/youtube/monitor');
const YoutubeClient = require('../src/core/youtube/client');
const LufsReceiver = require('../src/core/lufs/receiver');
const RuleEngine = require('../src/core/rules/engine');
const Notifier = require('../src/core/notify/notifier');
const MobileServer = require('../src/core/mobile/server');
const { runKakaoOAuth } = require('../src/core/notify/kakao-oauth');
const { runGoogleOAuth } = require('../src/core/youtube/oauth');
const configStore = require('../src/config/store');
const packageJson = require('../package.json');

const DEFAULT_KAKAO_REDIRECT = 'https://localhost/oauth/kakao';
const DEFAULT_GOOGLE_REDIRECT = 'http://127.0.0.1:53682/oauth/google';
const DEFAULT_GOOGLE_LOCALHOST_REDIRECT = 'http://localhost:53682/oauth/google';
const LEGACY_GOOGLE_REDIRECT = 'http://127.0.0.1/oauth/google';
const APP_USER_MODEL_ID = 'com.streamwatcher.broadcasthealthchecker';

let mainWindow;
let tray;
let isQuitting = false;
let obsMonitor;
let youtubeMonitor;
let lufsReceiver;
let ruleEngine;
let notifier;
let mobileServer;
let telegramChatPollTimer;
let youtubeLoginStarted = false;
let youtubeLoginPromise = null;
let latestObsState = null;
let latestYoutubeState = null;
let latestLufsState = null;
let latestAudioState = null;
let activeMobileAlerts = [];
let recentMobileAlerts = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1280,
    minHeight: 820,
    title: 'Stream Watcher',
    icon: path.join(__dirname, '..', 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 닫기 → 트레이로 숨기기 (사용자가 트레이에서 종료해야 진짜 종료).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const isDarwin = process.platform === 'darwin';
  const iconFile = isDarwin ? 'tray-icon-mac.png' : 'tray-icon.png';
  const iconPath = path.join(__dirname, '..', 'assets', iconFile);
  const image = nativeImage.createFromPath(iconPath);
  if (isDarwin) image.setTemplateImage(true); // adapts to light/dark menu bar
  tray = new Tray(image);
  tray.setToolTip('방송 상태 모니터링');
  rebuildTrayMenu();
  tray.on('click', toggleWindow);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? '대시보드 숨기기' : '대시보드 열기',
      click: toggleWindow,
    },
    { type: 'separator' },
    {
      label: '시스템 시작 시 자동 실행',
      type: 'checkbox',
      checked: !!app.getLoginItemSettings().openAtLogin,
      click: (item) => applyAutoStart(item.checked),
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => quitApp(),
    },
  ]);
  tray.setContextMenu(menu);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  rebuildTrayMenu();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function applyAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  const cur = configStore.getAll();
  configStore.update({ app: { ...(cur.app || {}), autoStart: !!enabled } });
  rebuildTrayMenu();
}

function normalizeGoogleRedirectUri(uri) {
  if (!uri || uri === LEGACY_GOOGLE_REDIRECT) return DEFAULT_GOOGLE_REDIRECT;
  if (uri === 'http://localhost' || uri === 'http://localhost/') return DEFAULT_GOOGLE_REDIRECT;
  if (uri === DEFAULT_GOOGLE_LOCALHOST_REDIRECT) return DEFAULT_GOOGLE_REDIRECT;
  if (uri === 'http://127.0.0.1' || uri === 'http://127.0.0.1/') return DEFAULT_GOOGLE_REDIRECT;
  return uri;
}

function readGoogleClientJson(filePath) {
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);
  const client = json.installed || json.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error('Client ID/Secret을 찾을 수 없는 JSON입니다.');
  }
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUri: normalizeGoogleRedirectUri(client.redirect_uris?.[0] || DEFAULT_GOOGLE_REDIRECT),
  };
}

function normalizeSettings(settings) {
  const obs = settings.obs || {};
  const youtube = settings.youtube || {};
  const lufs = settings.lufs || {};
  const mobile = settings.mobile || {};
  const scenario = settings.scenario || {};
  const rules = settings.rules || {};
  const defaultRules = RuleEngine.DEFAULT_RULES || {};
  const numberRule = (key) => {
    const value = Number(rules[key]);
    return Number.isFinite(value) ? value : defaultRules[key];
  };
  const booleanRule = (key) => {
    return typeof rules[key] === 'boolean' ? rules[key] : defaultRules[key];
  };
  return {
    ...settings,
    obs: {
      ...obs,
      host: !obs.host || obs.host === 'NaN' ? '127.0.0.1' : obs.host,
      port: Number.isFinite(Number(obs.port)) ? Number(obs.port) : 4455,
      pollIntervalMs: Number.isFinite(Number(obs.pollIntervalMs)) ? Number(obs.pollIntervalMs) : 1000,
    },
    youtube: {
      ...youtube,
      oauth: {
        ...(youtube.oauth || {}),
        redirectUri: normalizeGoogleRedirectUri(youtube.oauth?.redirectUri),
      },
    },
    lufs: {
      ...lufs,
      host: !lufs.host || lufs.host === 'NaN' ? '0.0.0.0' : lufs.host,
      port: Number.isFinite(Number(lufs.port)) ? Number(lufs.port) : 49152,
    },
    mobile: {
      ...mobile,
      enabled: typeof mobile.enabled === 'boolean' ? mobile.enabled : true,
      host: !mobile.host || mobile.host === 'NaN' ? '0.0.0.0' : mobile.host,
      port: Number.isFinite(Number(mobile.port)) ? Number(mobile.port) : 53683,
      discoveryEnabled: typeof mobile.discoveryEnabled === 'boolean' ? mobile.discoveryEnabled : true,
      serverId: mobile.serverId || createId('server'),
      pairingPin: mobile.pairingPin || '',
      pairingPinExpiresAt: Number.isFinite(Number(mobile.pairingPinExpiresAt)) ? Number(mobile.pairingPinExpiresAt) : 0,
      devices: Array.isArray(mobile.devices) ? mobile.devices : [],
      token: mobile.token || '',
    },
    scenario: normalizeScenarioSettings(scenario),
    rules: {
      ...rules,
      audioSilenceSeconds: numberRule('audioSilenceSeconds'),
      audioSilenceDb: numberRule('audioSilenceDb'),
      audioSilenceStartupDelayMs: numberRule('audioSilenceStartupDelayMs'),
      audioSilenceCooldownMs: numberRule('audioSilenceCooldownMs'),
      audioPeakEnabled: booleanRule('audioPeakEnabled'),
      audioPeakDb: numberRule('audioPeakDb'),
      audioPeakCooldownMs: numberRule('audioPeakCooldownMs'),
      lufsEnabled: booleanRule('lufsEnabled'),
      lufsHighThreshold: numberRule('lufsHighThreshold'),
      lufsLowThreshold: numberRule('lufsLowThreshold'),
      lufsDurationSeconds: numberRule('lufsDurationSeconds'),
      lufsStartupDelayMs: numberRule('lufsStartupDelayMs'),
      lufsRecoveryMargin: numberRule('lufsRecoveryMargin'),
      lufsCooldownMs: numberRule('lufsCooldownMs'),
      bitrateMinKbps: numberRule('bitrateMinKbps'),
      bitrateStartupDelayMs: numberRule('bitrateStartupDelayMs'),
      bitrateCooldownMs: numberRule('bitrateCooldownMs'),
      droppedFramePctMax: !Number.isFinite(Number(rules.droppedFramePctMax)) || Number(rules.droppedFramePctMax) <= 1
        ? 5
        : Number(rules.droppedFramePctMax),
      droppedFrameWindowSeconds: Number.isFinite(Number(rules.droppedFrameWindowSeconds))
        ? Number(rules.droppedFrameWindowSeconds)
        : 30,
      droppedFrameMinFrames: Number.isFinite(Number(rules.droppedFrameMinFrames))
        ? Number(rules.droppedFrameMinFrames)
        : 30,
      droppedFrameCooldownMs: !Number.isFinite(Number(rules.droppedFrameCooldownMs)) || Number(rules.droppedFrameCooldownMs) <= 60000
        ? 300000
        : Number(rules.droppedFrameCooldownMs),
      droppedFrameStartupDelayMs: numberRule('droppedFrameStartupDelayMs'),
    },
  };
}

function pushState(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function toMobileStatus() {
  const now = Date.now();
  const mobileSettings = configStore.getAll().mobile || {};
  const serverIp = mobileServer?.getLocalIp?.() || '127.0.0.1';
  const activeAlerts = activeMobileAlerts.map((a) => ({ ...a }));
  const summary = buildMobileSummary(activeAlerts);

  return {
    schemaVersion: 1,
    app: {
      name: 'Stream Watcher',
      siteName: mobileSettings.siteName || '나눔교회 송출 모니터링',
      version: packageJson.version || '0.1.0',
    },
    connection: {
      serverIp,
      connected: true,
      lastUpdatedAt: Math.max(
        latestObsState?.ts || 0,
        latestYoutubeState?.ts || 0,
        latestLufsState?.ts || 0,
        now,
      ),
    },
    summary,
    obs: buildMobileObsState(),
    youtube: buildMobileYoutubeState(),
    audio: buildMobileAudioState(),
    lufs: buildMobileLufsState(),
    scenario: getScenarioMobileState(),
    activeAlert: activeAlerts[0] || null,
    activeAlerts,
    recentAlerts: recentMobileAlerts.slice(0, 20),
  };
}

function getScenarioMobileState() {
  const scenario = normalizeScenarioSettings(configStore.getAll().scenario || {});
  const stages = scenario.stages.map((stage, index) => ({
    index,
    id: stage.id || `stage-${index}`,
    title: stage.title || `단계 ${index + 1}`,
    note: stage.note || '',
    notify: !!stage.notify,
  }));
  const currentStageIndex = clampStageIndex(scenario.currentStageIndex, stages.length);
  return {
    currentStageIndex,
    currentStageChangedAt: scenario.currentStageChangedAt || 0,
    currentStage: stages[currentStageIndex] || null,
    stages,
  };
}

function setScenarioStageIndex(index, source = 'desktop') {
  const current = configStore.getAll();
  const scenario = normalizeScenarioSettings(current.scenario || {});
  const currentStageIndex = clampStageIndex(index, scenario.stages.length);
  const nextScenario = {
    ...scenario,
    currentStageIndex,
    currentStageChangedAt: Date.now(),
  };
  configStore.update({ scenario: nextScenario });
  const payload = {
    ok: true,
    source,
    scenario: getScenarioMobileState(),
  };
  pushState('scenario:changed', payload);
  mobileServer?.broadcast?.('scenario', payload.scenario);
  mobileServer?.broadcastStatus?.();

  // 단계 변경 시 OBS/YouTube 상태 체크 후 알람 발송 (알림 딜레이 후 실행)
  const stage = scenario.stages[currentStageIndex];

  // 단계 변경 시 이전 시나리오 체크 알람 초기화
  activeMobileAlerts = activeMobileAlerts.filter((a) => a.type !== 'SCENARIO_CHECK_FAILED');

  // 룰 엔진에 현재 스테이지 ID 전달 (예배준비/마무리는 오디오·LUFS 알람 비활성)
  ruleEngine?.setActiveStage?.(stage?.id ?? null);
  if (stage && stage.notify !== false) {
    const delayMs = Math.max(0, Number(scenario.alertDelayMs) || 5000);
    setTimeout(() => checkScenarioAndAlert(stage), delayMs);
  }

  return payload;
}

function checkScenarioAndAlert(stage) {
  const obs = buildMobileObsState();
  const youtube = buildMobileYoutubeState();
  const stageTitle = stage.title || '현재 단계';
  const checks = stage.checks || {};

  const alerts = [];
  if (!obs.streaming) {
    alerts.push('[긴급] OBS 송출이 꺼져 있습니다.');
  }
  if (!youtube.live) {
    alerts.push('[오류] YouTube 라이브가 아직 감지되지 않았습니다.');
  }
  // 녹화 체크
  if (checks.recording?.enabled) {
    const expectedRecording = checks.recording.expected !== false;
    if (!!obs.recording !== expectedRecording) {
      alerts.push(expectedRecording
        ? '[오류] 녹화가 켜져 있어야 합니다.'
        : '[오류] 녹화가 꺼져 있어야 합니다.');
    }
  }

  for (const message of alerts) {
    const alert = { type: 'SCENARIO_CHECK_FAILED', ts: Date.now(), message };
    handleMobileAlert(alert);
    pushState('alert:new', alert);
    notifier?.dispatch(alert).catch(() => {});
  }
}

function normalizeScenarioSettings(scenario = {}) {
  const stages = Array.isArray(scenario.stages) && scenario.stages.length
    ? scenario.stages
    : configStore.get('scenario')?.stages || [];
  return {
    ...scenario,
    currentStageIndex: clampStageIndex(scenario.currentStageIndex, stages.length),
    currentStageChangedAt: Number.isFinite(Number(scenario.currentStageChangedAt))
      ? Number(scenario.currentStageChangedAt)
      : 0,
    alertDelayMs: Number.isFinite(Number(scenario.alertDelayMs)) ? Number(scenario.alertDelayMs) : 5000,
    stages,
  };
}

function clampStageIndex(index, length) {
  const max = Math.max(0, Number(length || 0) - 1);
  const n = Number(index);
  return Math.max(0, Math.min(max, Number.isFinite(n) ? Math.round(n) : 0));
}

function getMobileInfo() {
  const settings = normalizeSettings(configStore.getAll());
  const mobile = settings.mobile || {};
  const now = Date.now();
  const pinActive = !!(mobile.pairingPin && Number(mobile.pairingPinExpiresAt || 0) > now);
  return {
    enabled: !!mobile.enabled,
    discoveryEnabled: !!mobile.discoveryEnabled,
    running: !!mobileServer?.isRunning?.(),
    serviceType: MobileServer.SERVICE_TYPE,
    serverId: mobile.serverId,
    requiresPin: true,
    pairingPin: pinActive ? mobile.pairingPin : '',
    pairingPinExpiresAt: pinActive ? mobile.pairingPinExpiresAt : 0,
    url: mobileServer?.getPublicUrl?.() || null,
    localIp: mobileServer?.getLocalIp?.() || '127.0.0.1',
    port: mobile.port,
    deviceCount: Array.isArray(mobile.devices) ? mobile.devices.length : 0,
    devices: sanitizeMobileDevices(mobile.devices || []),
  };
}

function getMobileDiscoveryInfo() {
  const info = getMobileInfo();
  return {
    version: packageJson.version || '0.1.0',
    schemaVersion: 1,
    serverId: info.serverId,
    requiresPin: true,
  };
}

function pairMobileDevice(payload = {}) {
  const current = normalizeSettings(configStore.getAll());
  const mobile = current.mobile || {};
  const now = Date.now();
  const pin = String(payload.pin || '').trim();
  if (!mobile.pairingPin || Number(mobile.pairingPinExpiresAt || 0) <= now) {
    return { ok: false, error: 'pin_expired', message: 'PIN이 만료되었습니다.' };
  }
  if (pin !== String(mobile.pairingPin)) {
    return { ok: false, error: 'invalid_pin', message: 'PIN이 올바르지 않습니다.' };
  }

  const token = createToken();
  const device = {
    id: createId('device'),
    name: String(payload.deviceName || payload.clientId || '모바일 기기').slice(0, 80),
    clientId: String(payload.clientId || '').slice(0, 120),
    token,
    pairedAt: now,
    lastSeenAt: now,
  };
  const devices = [...(mobile.devices || []), device];
  configStore.update({
    mobile: {
      ...mobile,
      pairingPin: '',
      pairingPinExpiresAt: 0,
      devices,
    },
  });
  pushState('config:changed', normalizeSettings(configStore.getAll()));
  mobileServer?.broadcast?.('paired', { device: sanitizeMobileDevice(device), serverId: mobile.serverId });
  return {
    ok: true,
    token,
    serverId: mobile.serverId,
    device: sanitizeMobileDevice(device),
  };
}

function isMobileTokenAuthorized(token) {
  const current = configStore.getAll();
  const devices = current.mobile?.devices || [];
  const match = devices.find((device) => device.token && safeEqual(device.token, token));
  if (!match) return false;
  match.lastSeenAt = Date.now();
  configStore.update({ mobile: { ...current.mobile, devices } });
  return true;
}

function hasPairedMobileDevices() {
  return !!(configStore.getAll().mobile?.devices || []).length;
}

function generateMobilePairingPin() {
  const current = normalizeSettings(configStore.getAll());
  const pin = String(crypto.randomInt(100000, 1000000));
  const mobile = {
    ...(current.mobile || {}),
    serverId: current.mobile?.serverId || createId('server'),
    pairingPin: pin,
    pairingPinExpiresAt: Date.now() + 10 * 60 * 1000,
  };
  configStore.update({ mobile });
  return getMobileInfo();
}

function clearMobileDevices() {
  const current = normalizeSettings(configStore.getAll());
  configStore.update({
    mobile: {
      ...(current.mobile || {}),
      devices: [],
      pairingPin: '',
      pairingPinExpiresAt: 0,
    },
  });
  mobileServer?.broadcast?.('devicesCleared', { ts: Date.now() });
  return getMobileInfo();
}

function sanitizeMobileDevices(devices) {
  return devices.map(sanitizeMobileDevice);
}

function sanitizeMobileDevice(device) {
  return {
    id: device.id,
    name: device.name || '모바일 기기',
    clientId: device.clientId || '',
    pairedAt: device.pairedAt || 0,
    lastSeenAt: device.lastSeenAt || 0,
  };
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function severityRank(level) {
  return level === 'critical' ? 3 : level === 'warn' ? 2 : level === 'info' ? 1 : 0;
}

function buildMobileSummary(activeAlerts) {
  if (activeAlerts && activeAlerts.length) {
    const top = activeAlerts.reduce((a, b) => (severityRank(b.level) > severityRank(a.level) ? b : a));
    const extra = activeAlerts.length - 1;
    return {
      level: top.level,
      title: extra > 0 ? `${top.title} 외 ${extra}건` : top.title,
      message: top.message || '',
    };
  }

  const obs = buildMobileObsState();
  const youtube = buildMobileYoutubeState();
  if (!obs.connected && !youtube.connected) {
    return {
      level: 'offline',
      title: '연결 대기 중',
      message: '상태 수신 대기 중',
    };
  }

  if (!obs.streaming && !youtube.live) {
    return {
      level: 'inactive',
      title: '송출 중지',
      message: 'OBS 중지, YouTube 오프라인',
    };
  }

  if (!obs.streaming || !youtube.live) {
    return {
      level: 'warn',
      title: '송출 상태 확인 필요',
      message: obs.streaming ? 'YouTube 오프라인' : 'OBS 송출 중지',
    };
  }

  return {
    level: 'ok',
    title: '정상',
    message: '모든 항목 정상',
  };
}

function buildMobileObsState() {
  const s = latestObsState || {};
  // obsConnected: false 는 emitOfflineState() 가 세팅하는 필드.
  // error 이벤트 직후 state 이벤트가 덮어써서 error 필드가 사라지는 경우에도
  // obsConnected: false 로 연결 끊김을 정확히 감지한다.
  const connected = !!latestObsState && !s.error && s.obsConnected !== false;
  return {
    connected,
    // 연결이 끊겼거나(error) 상태가 없으면 이전 streaming 값을 그대로 쓰지 않고 false 처리
    streaming: connected && !!s.streaming,
    recording: !!s.recording,
    scene: s.scene || s.currentProgramSceneName || null,
    sources: Array.isArray(s.sources) ? s.sources : [],
    bitrateKbps: numericOrNull(s.bitrateKbps),
    droppedFrames: numericOrNull(s.droppedFrames),
    droppedFramePct: numericOrNull(s.droppedFramePct),
    renderSkippedFrames: numericOrNull(s.renderSkippedFrames),
    cpuUsage: numericOrNull(s.cpuUsage),
    memoryUsageMb: numericOrNull(s.memoryUsageMb),
    updatedAt: s.ts || null,
  };
}

function buildMobileYoutubeState() {
  const s = latestYoutubeState || {};
  const connected = !!latestYoutubeState && !s.error;
  return {
    connected,
    // 연결이 끊겼거나(error) 상태가 없으면 이전 live 값(stale)을 쓰지 않고 false 처리
    live: connected && !!s.live,
    title: s.title || null,
    url: s.url || null,
    broadcastStatus: s.broadcastStatus || null,
    streamStatus: s.streamStatus || null,
    healthStatus: s.healthStatus || null,
    configurationIssueCount: Array.isArray(s.configurationIssues) ? s.configurationIssues.length : 0,
    concurrentViewers: numericOrNull(s.concurrentViewers),
    updatedAt: s.ts || null,
  };
}

function buildMobileAudioState() {
  const obs = latestObsState || {};
  const connected = !!latestObsState && !obs.error && obs.obsConnected !== false;
  const hasMeters = connected && Array.isArray(obs.audioMeters) && latestAudioState;
  const audioAlert = activeAlertBySource('audio');
  const peakDb = hasMeters ? numericOrNull(latestAudioState?.peakDb) : null;
  // 알림 딜레이와 무관하게 현재 피크값이 무음 기준 이하면 즉시 '무음'으로 표시
  const silenceDb = (configStore.getAll().rules || {}).audioSilenceDb ?? -65;
  const isSilentNow = peakDb !== null && peakDb < silenceDb;
  return {
    connected,
    status: audioAlert ? audioAlert.level : (hasMeters ? 'ok' : 'inactive'),
    peakDb,
    silent: hasMeters && (isSilentNow || (!!audioAlert && audioAlert.type === 'OBS_AUDIO_SILENCE')),
    updatedAt: hasMeters ? latestAudioState.ts : (connected ? obs.ts || null : null),
  };
}

function buildMobileLufsState() {
  const s = latestLufsState || {};
  const connected = !!latestLufsState && !s.error;
  const hasReading = connected && (
    Number.isFinite(Number(s.momentary)) ||
    Number.isFinite(Number(s.shortTerm)) ||
    Number.isFinite(Number(s.integrated))
  );
  const lufsAlert = activeAlertBySource('lufs');
  return {
    connected,
    status: lufsAlert ? lufsAlert.level : (hasReading ? 'ok' : 'inactive'),
    momentary: hasReading ? numericOrNull(s.momentary) : null,
    shortTerm: hasReading ? numericOrNull(s.shortTerm) : null,
    integrated: hasReading ? numericOrNull(s.integrated) : null,
    updatedAt: hasReading ? s.ts || null : null,
  };
}

function handleMobileAlert(alert) {
  const normalized = normalizeMobileAlert(alert);
  recentMobileAlerts.unshift(normalized);
  if (recentMobileAlerts.length > 100) recentMobileAlerts.length = 100;

  if (normalized.level === 'warn' || normalized.level === 'critical') {
    // SCENARIO_CHECK_FAILED는 제목(오류 내용)이 다른 것끼리 공존 가능 — 같은 제목만 교체
    if (normalized.type === 'SCENARIO_CHECK_FAILED') {
      activeMobileAlerts = activeMobileAlerts.filter(
        (a) => !(a.type === normalized.type && a.title === normalized.title),
      );
    } else {
      // 그 외 타입은 기존대로 같은 타입 하나만 유지
      activeMobileAlerts = activeMobileAlerts.filter((a) => a.type !== normalized.type);
    }
    activeMobileAlerts.push(normalized);
    if (activeMobileAlerts.length > 20) activeMobileAlerts.shift();
  } else if (isRecoveryAlert(normalized.type)) {
    // 복구 알림이면 대응되는 활성 알림만 스택에서 제거
    const clears = recoveryClears(normalized.type);
    activeMobileAlerts = activeMobileAlerts.filter((a) => !clears.includes(a.type));
  }
  mobileServer?.broadcast?.('alert', normalized);
  mobileServer?.broadcastStatus?.();
}

function activeAlertBySource(source) {
  return activeMobileAlerts.find((a) => a.source === source) || null;
}

function recoveryClears(type) {
  switch (type) {
    case 'LUFS_RECOVERED': return ['LUFS_TOO_LOUD', 'LUFS_TOO_QUIET'];
    case 'OBS_BITRATE_RECOVERED': return ['OBS_BITRATE_LOW'];
    case 'OBS_DROPPED_FRAMES_RECOVERED': return ['OBS_DROPPED_FRAMES_HIGH'];
    case 'YOUTUBE_HEALTH_RECOVERED': return ['YOUTUBE_HEALTH_BAD'];
    case 'YOUTUBE_LIVE_ENDED': return ['YOUTUBE_HEALTH_BAD', 'YOUTUBE_CONFIG_ISSUE'];
    case 'OBS_STREAM_STOPPED':
      return ['OBS_BITRATE_LOW', 'OBS_DROPPED_FRAMES_HIGH', 'OBS_AUDIO_SILENCE', 'OBS_AUDIO_PEAK'];
    default: return [];
  }
}

function normalizeMobileAlert(alert) {
  const type = alert?.type || 'UNKNOWN';
  const ts = alert?.ts || Date.now();
  return {
    id: `${type}_${ts}`,
    type,
    level: getMobileAlertLevel(type, alert),
    title: getMobileAlertTitle(type, alert),
    message: getMobileAlertMessage(type, alert),
    source: getMobileAlertSource(type),
    acknowledged: false,
    createdAt: ts,
    acknowledgedAt: null,
  };
}

function acknowledgeMobileAlert(payload = {}) {
  if (!activeMobileAlerts.length) return { ok: true, alertId: null, acknowledged: false };

  const acknowledgedAt = Date.now();
  const id = payload.alertId || null;
  const acknowledgedIds = [];

  // 확인 처리: activeMobileAlerts에서 삭제하지 않고 acknowledged 만 표시.
  // 실제 문제가 해결될 때(복구 이벤트/상태 정상화) 서버 측에서 삭제한다.
  if (id) {
    const target = activeMobileAlerts.find((a) => a.id === id);
    if (!target) return { ok: false, error: 'alert_mismatch' };
    target.acknowledged = true;
    target.acknowledgedAt = acknowledgedAt;
    acknowledgedIds.push(id);
  } else {
    for (const a of activeMobileAlerts) {
      a.acknowledged = true;
      a.acknowledgedAt = acknowledgedAt;
      acknowledgedIds.push(a.id);
    }
  }

  recentMobileAlerts = recentMobileAlerts.map((alert) => (
    acknowledgedIds.includes(alert.id)
      ? { ...alert, acknowledged: true, acknowledgedAt }
      : alert
  ));
  mobileServer?.broadcast?.('ack', { alertId: id, acknowledged: true, acknowledgedAt });
  mobileServer?.broadcastStatus?.();
  return { ok: true, alertId: id, acknowledged: true, acknowledgedAt };
}

function getMobileAlertLevel(type, alert) {
  if (type === 'SCENARIO_CHECK_FAILED') {
    const msg = String(alert?.message || '');
    if (msg.startsWith('[긴급]')) return 'critical';
    if (msg.startsWith('[오류]')) return 'warn';
  }
  if ([
    'OBS_AUDIO_SILENCE',
    'OBS_BITRATE_LOW',
    'OBS_DROPPED_FRAMES_HIGH',
    'YOUTUBE_HEALTH_BAD',
    'YOUTUBE_CONFIG_ISSUE',
  ].includes(type)) return 'critical';
  if (['OBS_AUDIO_PEAK', 'LUFS_TOO_LOUD', 'LUFS_TOO_QUIET'].includes(type)) return 'warn';
  return 'info';
}

function getMobileAlertSource(type) {
  if (type.startsWith('OBS_AUDIO')) return 'audio';
  if (type.startsWith('LUFS')) return 'lufs';
  if (type.startsWith('YOUTUBE')) return 'youtube';
  if (type.startsWith('OBS')) return 'obs';
  if (type.startsWith('SCENARIO')) return 'scenario';
  return 'system';
}

function getMobileAlertTitle(type, alert) {
  const map = {
    OBS_STREAM_STARTED: '송출 시작',
    OBS_STREAM_STOPPED: '송출 종료',
    OBS_RECORD_STARTED: '녹화 시작',
    OBS_RECORD_STOPPED: '녹화 종료',
    OBS_AUDIO_SILENCE: '오디오 무음',
    OBS_AUDIO_PEAK: '오디오 피크',
    LUFS_TOO_LOUD: 'LUFS 초과',
    LUFS_TOO_QUIET: 'LUFS 부족',
    LUFS_RECOVERED: 'LUFS 정상 복구',
    OBS_BITRATE_LOW: '비트레이트 낮음',
    OBS_BITRATE_RECOVERED: '비트레이트 정상 복구',
    OBS_DROPPED_FRAMES_HIGH: '드롭 프레임 높음',
    OBS_DROPPED_FRAMES_RECOVERED: '드롭 프레임 정상 복구',
    YOUTUBE_LIVE_DETECTED: '유튜브 라이브 시작',
    YOUTUBE_LIVE_ENDED: '유튜브 라이브 종료',
    YOUTUBE_HEALTH_BAD: '유튜브 스트림 이상',
    YOUTUBE_HEALTH_RECOVERED: '유튜브 스트림 정상 복구',
    YOUTUBE_CONFIG_ISSUE: '유튜브 설정 이슈',
  };
  if (type === 'SCENARIO_CHECK_FAILED' && alert?.message) return alert.message;
  return map[type] || type;
}

function getMobileAlertMessage(type, alert) {
  if (type === 'OBS_AUDIO_SILENCE') return '오디오 신호가 없습니다';
  if (type === 'OBS_AUDIO_PEAK') return '오디오 피크 발생';
  if (type === 'OBS_BITRATE_LOW') return `현재 ${alert?.bitrateKbps ?? '-'} kbps`;
  if (type === 'OBS_DROPPED_FRAMES_HIGH') return `드롭 ${alert?.droppedPct ?? '-'}%`;
  if (type === 'LUFS_TOO_LOUD' || type === 'LUFS_TOO_QUIET') return `${alert?.shortTermLufs ?? '-'} LUFS`;
  if (type === 'YOUTUBE_HEALTH_BAD') return alert?.healthStatus || '스트림 헬스 이상';
  if (type === 'YOUTUBE_CONFIG_ISSUE') return alert?.issueType || '설정 이슈';
  // 단순 이벤트/복구 알림은 제목만으로 충분 → 부제목 비움(로그 중복 방지)
  return '';
}

function isRecoveryAlert(type) {
  return [
    'LUFS_RECOVERED',
    'OBS_BITRATE_RECOVERED',
    'OBS_DROPPED_FRAMES_RECOVERED',
    'YOUTUBE_HEALTH_RECOVERED',
    'YOUTUBE_LIVE_ENDED',
    'OBS_STREAM_STOPPED',
  ].includes(type);
}

function updateLatestAudioState(obsState) {
  if (!Array.isArray(obsState?.audioMeters)) return;
  const peakDb = RuleEngine.maxPeakDbAcrossInputs(obsState.audioMeters);
  const roundedPeakDb = Number.isFinite(peakDb) ? Math.round(peakDb * 10) / 10 : null;
  latestAudioState = {
    peakDb: roundedPeakDb,
    ts: obsState.ts || Date.now(),
  };

  const rules = configStore.getAll().rules || {};
  const audioAlert = activeAlertBySource('audio');
  if (!audioAlert || !Number.isFinite(roundedPeakDb)) return;
  if (audioAlert.type === 'OBS_AUDIO_SILENCE' && roundedPeakDb >= Number(rules.audioSilenceDb ?? -65)) {
    activeMobileAlerts = activeMobileAlerts.filter((a) => a.id !== audioAlert.id);
    mobileServer?.broadcastStatus?.();
  }
  if (audioAlert.type === 'OBS_AUDIO_PEAK' && roundedPeakDb < Number(rules.audioPeakDb ?? -1)) {
    activeMobileAlerts = activeMobileAlerts.filter((a) => a.id !== audioAlert.id);
    mobileServer?.broadcastStatus?.();
  }
}

function numericOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

async function fetchTelegramPrivateChats(botToken) {
  if (!botToken) throw new Error('Bot Token을 입력하세요.');
  const res = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
    validateStatus: () => true,
  });
  if (!res.data?.ok) throw new Error(res.data?.description || 'Telegram 업데이트 조회 실패');
  return res.data.result
    .map((item) => item.message?.chat || item.channel_post?.chat)
    .filter((chat) => chat?.type === 'private')
    .reduce((acc, chat) => {
      if (!acc.some((item) => item.id === chat.id)) acc.push(chat);
      return acc;
    }, []);
}

function parseChatIds(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeTelegramChatIds(currentValue, chats) {
  const ids = parseChatIds(currentValue);
  for (const chat of chats) {
    const id = String(chat.id);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.join('\n');
}

function stopTelegramChatPoller() {
  if (telegramChatPollTimer) clearInterval(telegramChatPollTimer);
  telegramChatPollTimer = null;
}

function startTelegramChatPoller(settings) {
  stopTelegramChatPoller();
  const tg = settings.notify?.telegram || {};
  if (!tg.enabled || !tg.autoDiscover || !tg.botToken) return;

  const poll = async () => {
    try {
      const chats = await fetchTelegramPrivateChats(tg.botToken);
      if (!chats.length) return;

      const current = configStore.getAll();
      const telegram = current.notify?.telegram || {};
      const mergedChatIds = mergeTelegramChatIds(telegram.chatIds || telegram.chatId, chats);
      if (mergedChatIds === (telegram.chatIds || '')) return;

      const notify = {
        ...current.notify,
        telegram: {
          ...telegram,
          chatIds: mergedChatIds,
        },
      };
      configStore.update({ notify });
      notifier = new Notifier(notify);
      pushState('config:changed', configStore.getAll());
    } catch (err) {
      pushState('telegram:error', { message: err.message });
    }
  };

  poll();
  telegramChatPollTimer = setInterval(poll, 30000);
}

async function setupMonitors() {
  // 기존 모니터 정리
  try { await obsMonitor?.stop(); } catch {}
  try { await youtubeMonitor?.stop(); } catch {}
  try { await lufsReceiver?.stop(); } catch {}
  try { await mobileServer?.stop(); } catch {}
  stopTelegramChatPoller();
  obsMonitor = null;
  youtubeMonitor = null;
  lufsReceiver = null;
  // 이전 상태 초기화 — 초기화 없이 새 모니터를 시작하면 첫 상태가 오기 전까지
  // 낡은 streaming=true 값이 그대로 노출되어 모바일에 잘못된 녹색이 표시됨
  latestObsState = null;
  latestYoutubeState = null;
  latestLufsState = null;
  latestAudioState = null;

  const settings = normalizeSettings(configStore.getAll());
  configStore.update({ obs: settings.obs, youtube: settings.youtube, lufs: settings.lufs, mobile: settings.mobile, scenario: settings.scenario, rules: settings.rules });

  notifier = new Notifier(settings.notify);
  if (ruleEngine) {
    ruleEngine.rules = { ...ruleEngine.rules, ...settings.rules };
    ruleEngine.notifier = notifier;
  } else {
    ruleEngine = new RuleEngine({
      notifier,
      rules: settings.rules,
      onAlert: (alert) => {
        handleMobileAlert(alert);
        pushState('alert:new', alert);
      },
    });
  }
  // 저장된 현재 스테이지 ID로 룰 엔진 초기화
  const savedScenario = normalizeScenarioSettings(settings.scenario || {});
  const savedStage = savedScenario.stages?.[savedScenario.currentStageIndex];
  ruleEngine.setActiveStage?.(savedStage?.id ?? null);

  mobileServer = mobileServer || new MobileServer({
    getStatus: toMobileStatus,
    getScenario: getScenarioMobileState,
    onAck: acknowledgeMobileAlert,
    onPair: pairMobileDevice,
    onScenarioStage: (payload) => setScenarioStageIndex(payload?.stageIndex, 'mobile'),
    isAuthorized: isMobileTokenAuthorized,
    hasPairedDevices: hasPairedMobileDevices,
    getDiscoveryInfo: getMobileDiscoveryInfo,
  });
  try {
    await mobileServer.start(settings.mobile || {});
  } catch (err) {
    pushState('mobile:error', { message: err.message || String(err) });
  }

  obsMonitor = new ObsMonitor(settings.obs);
  obsMonitor.on('state', (s) => {
    latestObsState = s;
    updateLatestAudioState(s);
    ruleEngine.ingestObs(s);
    pushState('obs:state', s);
    mobileServer?.broadcastStatus?.();
  });
  obsMonitor.on('error', (e) => {
    latestObsState = { ...(latestObsState || {}), error: e.message, ts: Date.now() };
    pushState('obs:error', { message: e.message });
  });

  youtubeMonitor = new YoutubeMonitor(settings.youtube, {
    onTokenRefresh: ({ accessToken, expiresIn, expiryDate }) => {
      const cur = configStore.getAll();
      const newOauth = {
        ...cur.youtube.oauth,
        accessToken,
        tokenAcquiredAt: Date.now(),
        expiresIn: expiresIn || cur.youtube.oauth?.expiresIn || 0,
        expiryDate: expiryDate || cur.youtube.oauth?.expiryDate || 0,
      };
      configStore.update({ youtube: { ...cur.youtube, oauth: newOauth } });
    },
  });
  youtubeMonitor.on('state', (s) => {
    latestYoutubeState = s;
    ruleEngine.ingestYoutube(s);
    pushState('youtube:state', s);
    mobileServer?.broadcastStatus?.();
  });
  youtubeMonitor.on('error', (e) => {
    latestYoutubeState = { ...(latestYoutubeState || {}), error: e.message, ts: Date.now() };
    pushState('youtube:error', { message: e.message });
  });

  if (settings.lufs?.enabled) {
    lufsReceiver = new LufsReceiver(settings.lufs);
    lufsReceiver.on('state', (s) => {
      latestLufsState = s;
      ruleEngine.ingestLufs(s);
      pushState('lufs:state', s);
      mobileServer?.broadcastStatus?.();
    });
    lufsReceiver.on('ready', (s) => {
      latestLufsState = { ...s, ready: true, ts: Date.now() };
      pushState('lufs:state', latestLufsState);
      mobileServer?.broadcastStatus?.();
    });
    lufsReceiver.on('error', (e) => {
      latestLufsState = { ...(latestLufsState || {}), error: e.message, ts: Date.now() };
      pushState('lufs:error', { message: e.message });
    });
    lufsReceiver.start();
  }

  await obsMonitor.start();
  await youtubeMonitor.start();
  startTelegramChatPoller(settings);
}

async function maybeStartYoutubeLogin() {
  const current = normalizeSettings(configStore.getAll());
  let oauth = current.youtube?.oauth || {};
  if ((!oauth.clientId || !oauth.clientSecret) && oauth.clientJsonPath) {
    try {
      const imported = readGoogleClientJson(oauth.clientJsonPath);
      oauth = {
        ...oauth,
        clientId: imported.clientId,
        clientSecret: imported.clientSecret,
        redirectUri: imported.redirectUri,
      };
      configStore.update({ youtube: { ...current.youtube, oauth } });
    } catch (err) {
      pushState('youtube:error', { message: `OAuth JSON 읽기 실패: ${err.message}` });
      return;
    }
  }

  if (!oauth.clientId || !oauth.clientSecret || oauth.refreshToken) return;

  await startYoutubeOAuth({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    redirectUri: oauth.redirectUri,
    reason: 'startup',
  });
}

async function startYoutubeOAuth({ clientId, clientSecret, redirectUri, reason = 'manual' }) {
  if (youtubeLoginPromise) return youtubeLoginPromise;
  youtubeLoginStarted = true;
  youtubeLoginPromise = (async () => {
    const current = normalizeSettings(configStore.getAll());
    const oauth = current.youtube?.oauth || {};
    const uri = normalizeGoogleRedirectUri(redirectUri || oauth.redirectUri);
    if (!clientId || !clientSecret) throw new Error('Client ID/Secret이 필요합니다.');

    if (reason === 'manual' && oauth.refreshToken && oauth.clientId === clientId && oauth.clientSecret === clientSecret) {
      await setupMonitors();
      return { ok: true, alreadyConnected: true };
    }

    const tokens = await runGoogleOAuth({
      clientId,
      clientSecret,
      redirectUri: uri,
      parentWindow: mainWindow,
    });
    const acquiredAt = Date.now();
    const newOauth = {
      ...oauth,
      clientId,
      clientSecret,
      redirectUri: uri,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || oauth.refreshToken || '',
      tokenAcquiredAt: acquiredAt,
      expiresIn: tokens.expiresIn,
      expiryDate: acquiredAt + (Number(tokens.expiresIn || 0) * 1000),
    };
    configStore.update({ youtube: { ...current.youtube, oauth: newOauth } });
    await setupMonitors();
    return { ok: true };
  })();

  try {
    return await youtubeLoginPromise;
  } catch (err) {
    pushState('youtube:error', { message: err.message || String(err) });
    throw err;
  } finally {
    youtubeLoginStarted = false;
    youtubeLoginPromise = null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
  createWindow();
  createTray();

  // 시작 시 저장된 자동시작 설정을 OS에 동기화
  const startupSettings = configStore.getAll().app || {};
  if (typeof startupSettings.autoStart === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: startupSettings.autoStart });
  }

  ipcMain.handle('config:get', () => {
    const settings = normalizeSettings(configStore.getAll());
    configStore.update({ obs: settings.obs, youtube: settings.youtube, lufs: settings.lufs, mobile: settings.mobile, scenario: settings.scenario, rules: settings.rules });
    return settings;
  });
  ipcMain.handle('config:set', async (_, partial) => {
    if (partial?.scenario) {
      const current = normalizeSettings(configStore.getAll());
      partial = {
        ...partial,
        scenario: normalizeScenarioSettings({
          ...(current.scenario || {}),
          ...(partial.scenario || {}),
        }),
      };
    }
    configStore.update(partial);
    const settings = normalizeSettings(configStore.getAll());
    configStore.update({ obs: settings.obs, youtube: settings.youtube, lufs: settings.lufs, mobile: settings.mobile, scenario: settings.scenario, rules: settings.rules });
    await setupMonitors();
    return normalizeSettings(configStore.getAll());
  });
  ipcMain.handle('notify:test', async (_, channel) => {
    try {
      notifier = new Notifier(configStore.getAll().notify);
      return await notifier.test(channel);
    } catch (err) {
      const description = err.response?.data?.description || err.message || String(err);
      throw new Error(description);
    }
  });
  ipcMain.handle('telegram:chats', async (_, botToken) => {
    return fetchTelegramPrivateChats(botToken);
  });
  const fetchObsSources = async () => {
    const result = await obsMonitor?.client?.call('GetInputList');
    return (result?.inputs || []).map((input) => input.inputName).filter(Boolean);
  };
  ipcMain.handle('obs:sources', fetchObsSources);
  ipcMain.handle('obs:scenes', fetchObsSources);
  ipcMain.handle('obs:audio-inputs', async () => {
    const result = await obsMonitor?.client?.call('GetInputList');
    return (result?.inputs || [])
      .filter((input) => /audio|wasapi|alsa|pulse|coreaudio|input_capture/i.test(input.inputKind || ''))
      .map((input) => input.inputName)
      .filter(Boolean);
  });
  ipcMain.handle('scenario:alert', async (_, payload) => {
    const alert = {
      type: 'SCENARIO_CHECK_FAILED',
      ts: Date.now(),
      message: String(payload?.message || '').slice(0, 1000),
    };
    if (!alert.message) return { ok: false };
    handleMobileAlert(alert);
    pushState('alert:new', alert);
    notifier = notifier || new Notifier(configStore.getAll().notify);
    await notifier.dispatch(alert);
    return { ok: true };
  });
  ipcMain.handle('scenario:set-stage', async (_, payload) => {
    return setScenarioStageIndex(payload?.stageIndex, 'desktop');
  });

  ipcMain.handle('kakao:status', () => {
    const k = configStore.getAll().notify?.kakao || {};
    return {
      connected: !!(k.enabled && k.accessToken),
      restApiKey: k.restApiKey || '',
      redirectUri: k.redirectUri || DEFAULT_KAKAO_REDIRECT,
    };
  });

  ipcMain.handle('kakao:oauth-start', async (_, { restApiKey, redirectUri }) => {
    const uri = redirectUri || DEFAULT_KAKAO_REDIRECT;
    const tokens = await runKakaoOAuth({ restApiKey, redirectUri: uri, parentWindow: mainWindow });

    const current = configStore.getAll();
    const newKakao = {
      ...current.notify.kakao,
      enabled: true,
      restApiKey,
      redirectUri: uri,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenAcquiredAt: Date.now(),
      expiresIn: tokens.expiresIn,
    };
    const merged = { ...current.notify, kakao: newKakao };
    configStore.update({ notify: merged });
    notifier = new Notifier(merged);
    return { ok: true };
  });

  ipcMain.handle('kakao:disconnect', () => {
    const current = configStore.getAll();
    const newKakao = { ...current.notify.kakao, enabled: false, accessToken: '', refreshToken: '' };
    const merged = { ...current.notify, kakao: newKakao };
    configStore.update({ notify: merged });
    notifier = new Notifier(merged);
    return { ok: true };
  });

  ipcMain.handle('youtube:oauth-status', () => {
    const y = configStore.getAll().youtube?.oauth || {};
    return {
      connected: !!(y.clientId && y.accessToken && y.refreshToken),
      clientId: y.clientId || '',
      clientSecret: y.clientSecret || '',
      redirectUri: normalizeGoogleRedirectUri(y.redirectUri),
      tokenAcquiredAt: y.tokenAcquiredAt || 0,
      expiresIn: y.expiresIn || 0,
      expiryDate: y.expiryDate || 0,
    };
  });

  ipcMain.handle('youtube:diagnose', async () => {
    const settings = configStore.getAll().youtube || {};
    try {
      const client = new YoutubeClient({ apiKey: settings.apiKey, oauth: settings.oauth });
      if (client.mode === 'none') {
        return { ok: false, mode: 'none', message: 'OAuth 또는 API 키 설정이 없습니다.' };
      }
      if (client.mode === 'oauth') {
        const broadcasts = await client.listActiveBroadcasts();
        return {
          ok: true,
          mode: 'oauth',
          message: `OAuth 정상 · 활성 방송 ${broadcasts.length}개`,
        };
      }
      if (!settings.channelId) {
        return { ok: false, mode: 'apiKey', message: 'API 키 모드에는 채널 ID가 필요합니다.' };
      }
      const videoId = await client.findActiveLiveVideoId(settings.channelId);
      return {
        ok: true,
        mode: 'apiKey',
        message: videoId ? `API 키 정상 · 라이브 ${videoId}` : 'API 키 정상 · 현재 라이브 없음',
      };
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message || String(err);
      return { ok: false, message: detail };
    }
  });

  ipcMain.handle('youtube:oauth-start', async (_, { clientId, clientSecret, redirectUri }) => {
    try {
      return await startYoutubeOAuth({ clientId, clientSecret, redirectUri, reason: 'manual' });
    } catch (err) {
      const description = err.response?.data?.error_description || err.response?.data?.error || err.message || String(err);
      throw new Error(description);
    }
  });

  ipcMain.handle('youtube:oauth-import-client', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Google OAuth client_secret JSON 선택',
      filters: [{ name: 'Google OAuth Client JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false };

    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const json = JSON.parse(raw);
    const client = json.installed || json.web;
    if (!client?.client_id || !client?.client_secret) {
      throw new Error('Client ID/Secret을 찾을 수 없는 JSON입니다.');
    }

    const current = normalizeSettings(configStore.getAll());
    const oauth = {
      ...(current.youtube.oauth || {}),
      clientId: client.client_id,
      clientSecret: client.client_secret,
      redirectUri: normalizeGoogleRedirectUri(client.redirect_uris?.[0] || current.youtube.oauth?.redirectUri || DEFAULT_GOOGLE_REDIRECT),
      clientJsonPath: result.filePaths[0],
    };
    configStore.update({ youtube: { ...current.youtube, oauth } });
    return { ok: true, clientId: oauth.clientId, clientSecret: oauth.clientSecret, redirectUri: oauth.redirectUri };
  });

  ipcMain.handle('app:getStartup', () => ({
    autoStart: !!app.getLoginItemSettings().openAtLogin,
  }));

  ipcMain.handle('app:setAutoStart', (_, enabled) => {
    applyAutoStart(!!enabled);
    return { ok: true, autoStart: !!enabled };
  });

  ipcMain.handle('mobile:status', () => getMobileInfo());
  ipcMain.handle('mobile:generate-pin', () => generateMobilePairingPin());
  ipcMain.handle('mobile:clear-devices', () => clearMobileDevices());

  ipcMain.handle('window:hide', () => mainWindow?.hide());

  ipcMain.handle('youtube:disconnect', async () => {
    const current = configStore.getAll();
    const newOauth = { ...current.youtube.oauth, accessToken: '', refreshToken: '', tokenAcquiredAt: 0, expiresIn: 0, expiryDate: 0 };
    configStore.update({ youtube: { ...current.youtube, oauth: newOauth } });
    await setupMonitors();
    return { ok: true };
  });

  try {
    await setupMonitors();
    setTimeout(() => maybeStartYoutubeLogin().catch(() => {}), 300);
  } catch (err) {
    pushState('boot:error', { message: err.message });
  }
});

// 트레이 상주 모드: 모든 창이 닫혀도 앱은 살아 있다.
app.on('window-all-closed', () => {
  // intentionally do nothing; quit via tray
});

// macOS: dock 아이콘 클릭 시 숨겨진 창을 다시 표시
app.on('activate', () => {
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  stopTelegramChatPoller();
  await mobileServer?.stop();
  await obsMonitor?.stop();
  await youtubeMonitor?.stop();
  await lufsReceiver?.stop();
  tray?.destroy();
});
