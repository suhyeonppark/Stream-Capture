const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const ObsMonitor = require('../src/core/obs/monitor');
const YoutubeMonitor = require('../src/core/youtube/monitor');
const RuleEngine = require('../src/core/rules/engine');
const Notifier = require('../src/core/notify/notifier');
const { runKakaoOAuth } = require('../src/core/notify/kakao-oauth');
const { runGoogleOAuth } = require('../src/core/youtube/oauth');
const configStore = require('../src/config/store');

const DEFAULT_KAKAO_REDIRECT = 'https://localhost/oauth/kakao';
const DEFAULT_GOOGLE_REDIRECT = 'http://127.0.0.1/oauth/google';

let mainWindow;
let tray;
let isQuitting = false;
let obsMonitor;
let youtubeMonitor;
let ruleEngine;
let notifier;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Broadcast Health Checker',
    icon: path.join(__dirname, '..', 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

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
  tray.setToolTip('Broadcast Health Checker');
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

function pushState(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function setupMonitors() {
  // 기존 모니터 정리
  try { await obsMonitor?.stop(); } catch {}
  try { await youtubeMonitor?.stop(); } catch {}
  obsMonitor = null;
  youtubeMonitor = null;

  const settings = configStore.getAll();

  notifier = new Notifier(settings.notify);
  if (ruleEngine) {
    ruleEngine.rules = { ...ruleEngine.rules, ...settings.rules };
    ruleEngine.notifier = notifier;
  } else {
    ruleEngine = new RuleEngine({
      notifier,
      rules: settings.rules,
      onAlert: (alert) => pushState('alert:new', alert),
    });
  }

  obsMonitor = new ObsMonitor(settings.obs);
  obsMonitor.on('state', (s) => {
    ruleEngine.ingestObs(s);
    pushState('obs:state', s);
  });
  obsMonitor.on('error', (e) => pushState('obs:error', { message: e.message }));

  youtubeMonitor = new YoutubeMonitor(settings.youtube, {
    onTokenRefresh: ({ accessToken }) => {
      const cur = configStore.getAll();
      const newOauth = { ...cur.youtube.oauth, accessToken, tokenAcquiredAt: Date.now() };
      configStore.update({ youtube: { ...cur.youtube, oauth: newOauth } });
    },
  });
  youtubeMonitor.on('state', (s) => {
    ruleEngine.ingestYoutube(s);
    pushState('youtube:state', s);
  });
  youtubeMonitor.on('error', (e) => pushState('youtube:error', { message: e.message }));

  await obsMonitor.start();
  await youtubeMonitor.start();
}

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // 시작 시 저장된 자동시작 설정을 OS에 동기화
  const startupSettings = configStore.getAll().app || {};
  if (typeof startupSettings.autoStart === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: startupSettings.autoStart });
  }

  ipcMain.handle('config:get', () => configStore.getAll());
  ipcMain.handle('config:set', async (_, partial) => {
    configStore.update(partial);
    await setupMonitors();
    return configStore.getAll();
  });
  ipcMain.handle('notify:test', async (_, channel) => { await notifier?.test(channel); return { ok: true }; });

  ipcMain.handle('kakao:status', () => {
    const k = configStore.getAll().notify?.kakao || {};
    return {
      connected: !!(k.enabled && k.accessToken),
      restApiKey: k.restApiKey || '',
      redirectUri: k.redirectUri || DEFAULT_KAKAO_REDIRECT,
      mode: k.mode || 'memo',
      channelPublicId: k.channelPublicId || '',
    };
  });

  ipcMain.handle('kakao:oauth-start', async (_, { restApiKey, redirectUri, mode, channelPublicId }) => {
    const uri = redirectUri || DEFAULT_KAKAO_REDIRECT;
    const tokens = await runKakaoOAuth({ restApiKey, redirectUri: uri, parentWindow: mainWindow });

    const current = configStore.getAll();
    const newKakao = {
      ...current.notify.kakao,
      enabled: true,
      restApiKey,
      redirectUri: uri,
      mode: mode || 'memo',
      channelPublicId: channelPublicId || '',
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
      redirectUri: y.redirectUri || DEFAULT_GOOGLE_REDIRECT,
    };
  });

  ipcMain.handle('youtube:oauth-start', async (_, { clientId, clientSecret, redirectUri }) => {
    const uri = redirectUri || DEFAULT_GOOGLE_REDIRECT;
    const tokens = await runGoogleOAuth({ clientId, clientSecret, redirectUri: uri, parentWindow: mainWindow });
    const current = configStore.getAll();
    const newOauth = {
      ...current.youtube.oauth,
      clientId,
      clientSecret,
      redirectUri: uri,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenAcquiredAt: Date.now(),
      expiresIn: tokens.expiresIn,
    };
    configStore.update({ youtube: { ...current.youtube, oauth: newOauth } });
    await setupMonitors();
    return { ok: true };
  });

  ipcMain.handle('app:getStartup', () => ({
    autoStart: !!app.getLoginItemSettings().openAtLogin,
  }));

  ipcMain.handle('app:setAutoStart', (_, enabled) => {
    applyAutoStart(!!enabled);
    return { ok: true, autoStart: !!enabled };
  });

  ipcMain.handle('window:hide', () => mainWindow?.hide());

  ipcMain.handle('youtube:disconnect', async () => {
    const current = configStore.getAll();
    const newOauth = { ...current.youtube.oauth, accessToken: '', refreshToken: '', tokenAcquiredAt: 0, expiresIn: 0 };
    configStore.update({ youtube: { ...current.youtube, oauth: newOauth } });
    await setupMonitors();
    return { ok: true };
  });

  try {
    await setupMonitors();
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
  await obsMonitor?.stop();
  await youtubeMonitor?.stop();
  tray?.destroy();
});
