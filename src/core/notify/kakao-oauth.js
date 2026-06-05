const { BrowserWindow } = require('electron');
const axios = require('axios');

const AUTH_URL = 'https://kauth.kakao.com/oauth/authorize';
const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';

// 카카오 OAuth Authorization Code flow.
// redirectUri는 Kakao Developers Console의 앱 설정에 사전 등록되어 있어야 한다.
// 권장 값: https://localhost/oauth/kakao (브라우저로 로드되지는 않고, intercept만 한다)
async function runKakaoOAuth({ restApiKey, redirectUri, parentWindow }) {
  if (!restApiKey) throw new Error('REST API 키가 필요합니다.');
  if (!redirectUri) throw new Error('Redirect URI가 필요합니다.');

  const params = new URLSearchParams({
    client_id: restApiKey,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'talk_message,talk_channel',
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  const win = new BrowserWindow({
    parent: parentWindow,
    width: 480,
    height: 760,
    title: '카카오 로그인',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:kakao-oauth',
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
        if (err) finish(reject, new Error(`Kakao 인증 실패: ${err}${errDesc ? ' — ' + errDesc : ''}`));
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
      client_id: restApiKey,
      redirect_uri: redirectUri,
      code,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  return {
    accessToken: tokenRes.data.access_token,
    refreshToken: tokenRes.data.refresh_token,
    expiresIn: tokenRes.data.expires_in,
    refreshTokenExpiresIn: tokenRes.data.refresh_token_expires_in,
    scope: tokenRes.data.scope,
  };
}

module.exports = { runKakaoOAuth };
