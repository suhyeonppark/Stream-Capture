const http = require('http');
const { shell } = require('electron');
const axios = require('axios');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// Google OAuth Authorization Code flow for desktop apps.
// Google sign-in can fail inside embedded Electron windows, so use the system
// browser and catch the loopback redirect with a tiny local HTTP server.
async function runGoogleOAuth({ clientId, clientSecret, redirectUri, scope = DEFAULT_SCOPE }) {
  if (!clientId) throw new Error('Client ID가 필요합니다.');
  if (!clientSecret) throw new Error('Client Secret이 필요합니다.');
  if (!redirectUri) throw new Error('Redirect URI가 필요합니다.');

  const redirect = new URL(redirectUri);
  if (redirect.hostname !== '127.0.0.1' && redirect.hostname !== 'localhost') {
    throw new Error('Redirect URI는 http://127.0.0.1:포트/경로 형태여야 합니다.');
  }
  if (!redirect.port) {
    throw new Error('Redirect URI에는 포트가 필요합니다. 예: http://127.0.0.1:53682/oauth/google');
  }

  const server = http.createServer();
  const codePromise = waitForOAuthCode(server, redirect);

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error('Google 로그인 콜백 포트가 이미 사용 중입니다. 열려 있는 로그인 창을 완료하거나 프로그램을 완전히 종료한 뒤 다시 시도하세요.'));
        return;
      }
      reject(err);
    });
    server.listen(Number(redirect.port), redirect.hostname, resolve);
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  });

  try {
    await shell.openExternal(`${AUTH_URL}?${params.toString()}`);
    const code = await codePromise;
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
  } finally {
    server.close();
  }
}

function waitForOAuthCode(server, redirect) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Google 인증 시간이 초과되었습니다.'));
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
      try {
        const reqUrl = new URL(req.url, `${redirect.protocol}//${redirect.host}`);
        if (reqUrl.pathname !== redirect.pathname) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const err = reqUrl.searchParams.get('error');
        const errDesc = reqUrl.searchParams.get('error_description');
        const code = reqUrl.searchParams.get('code');

        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Google authentication failed.</h1><p>You can close this window.</p>');
          clearTimeout(timeout);
          reject(new Error(`Google 인증 실패: ${err}${errDesc ? ' - ' + errDesc : ''}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Missing authorization code.</h1>');
          clearTimeout(timeout);
          reject(new Error('인증 응답에 code가 없습니다.'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Google authentication complete.</h1><p>You can close this window and return to Stream Capture.</p>');
        clearTimeout(timeout);
        resolve(code);
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  });
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
