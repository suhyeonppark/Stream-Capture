const { BrowserWindow } = require('electron');
const axios = require('axios');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// Google OAuth Authorization Code flow (desktop app).
// redirectUri는 Google Cloud Console에서 등록한 값과 일치해야 하며,
// desktop app 타입 클라이언트는 보통 http://127.0.0.1 또는 http://localhost 기반 loopback을 쓴다.
async function runGoogleOAuth({ clientId, clientSecret, redirectUri, scope = DEFAULT_SCOPE, parentWindow }) {
  if (!clientId) throw new Error('Client ID가 필요합니다.');
  if (!clientSecret) throw new Error('Client Secret이 필요합니다.');
  if (!redirectUri) throw new Error('Redirect URI가 필요합니다.');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',  // refresh_token 발급
    prompt: 'consent',       // 매번 동의 화면 → refresh_token 확실히 재발급
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  const win = new BrowserWindow({
    parent: parentWindow,
    width: 520,
    height: 760,
    title: 'Google 로그인',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:google-oauth',
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
      if (!win.isDestroyed()) win.destroy();
    };

    const handleNavigation = (event, navUrl) => {
      if (!navUrl || !navUrl.startsWith(redirectUri)) return;
      try { event.preventDefault?.(); } catch {}
      try {
        const parsed = new URL(navUrl);
        const c = parsed.searchParams.get('code');
        const err = parsed.searchParams.get('error');
        const errDesc = parsed.searchParams.get('error_description');
        if (err) finish(reject, new Error(`Google 인증 실패: ${err}${errDesc ? ' — ' + errDesc : ''}`));
        else if (c) finish(resolve, c);
        else finish(reject, new Error('인증 응답에 code가 없습니다.'));
      } catch (e) {
        finish(reject, e);
      }
    };

    win.webContents.on('will-redirect', handleNavigation);
    win.webContents.on('will-navigate', handleNavigation);
    win.on('closed', () => finish(reject, new Error('사용자가 인증 창을 닫았습니다.')));

    win.loadURL(authUrl).catch((e) => finish(reject, e));
  });

  const tokenRes = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  return {
    accessToken: tokenRes.data.access_token,
    refreshToken: tokenRes.data.refresh_token,
    expiresIn: tokenRes.data.expires_in,
    scope: tokenRes.data.scope,
    tokenType: tokenRes.data.token_type,
  };
}

async function refreshGoogleToken({ clientId, clientSecret, refreshToken }) {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return {
    accessToken: res.data.access_token,
    expiresIn: res.data.expires_in,
  };
}

module.exports = { runGoogleOAuth, refreshGoogleToken };
