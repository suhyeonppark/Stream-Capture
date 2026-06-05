const { google } = require('googleapis');
const { refreshGoogleToken } = require('./oauth');

// YouTube Data API v3 클라이언트.
// 두 가지 모드:
//   - 'oauth':   OAuth2 자격증명 사용. liveBroadcasts/liveStreams 호출 가능 → healthStatus, configurationIssues.
//   - 'apiKey':  API 키만 사용. search.list 기반으로 채널의 현재 라이브를 탐색.
class YoutubeClient {
  constructor({ apiKey, oauth, onTokenRefresh }) {
    if (oauth?.clientId && (oauth?.accessToken || oauth?.refreshToken)) {
      const OAuth2 = google.auth.OAuth2;
      const client = new OAuth2(oauth.clientId, oauth.clientSecret, oauth.redirectUri);
      client.setCredentials({
        access_token: oauth.accessToken,
        refresh_token: oauth.refreshToken,
        expiry_date: oauth.expiryDate || undefined,
      });
      // googleapis가 access_token 만료 시 자동 갱신 → 'tokens' 이벤트로 노출.
      client.on('tokens', (tokens) => {
        if (tokens.access_token && onTokenRefresh) {
          onTokenRefresh({
            accessToken: tokens.access_token,
            expiryDate: tokens.expiry_date || 0,
            expiresIn: tokens.expiry_date ? Math.max(0, Math.floor((tokens.expiry_date - Date.now()) / 1000)) : 0,
          });
        }
      });
      this.oauthClient = client;
      this.yt = google.youtube({ version: 'v3', auth: client });
      this.mode = 'oauth';
    } else if (apiKey) {
      this.yt = google.youtube({ version: 'v3', auth: apiKey });
      this.mode = 'apiKey';
    } else {
      this.mode = 'none';
    }
  }

  // ── API 키 모드 ────────────────────────────────────────────────
  async findActiveLiveVideoId(channelId) {
    const res = await this.yt.search.list({
      part: ['id'],
      channelId,
      eventType: 'live',
      type: ['video'],
      maxResults: 1,
    });
    return res.data.items?.[0]?.id?.videoId || null;
  }

  async getVideoDetails(videoId) {
    const res = await this.yt.videos.list({
      part: ['snippet', 'liveStreamingDetails', 'status'],
      id: [videoId],
    });
    return res.data.items?.[0] || null;
  }

  // ── OAuth 모드 ────────────────────────────────────────────────
  async listActiveBroadcasts() {
    const res = await this.yt.liveBroadcasts.list({
      part: ['id', 'snippet', 'contentDetails', 'status'],
      maxResults: 5,
      mine: true,
    });
    return (res.data.items || []).filter((item) => item.status?.lifeCycleStatus === 'live');
  }

  async getLiveStream(streamId) {
    const res = await this.yt.liveStreams.list({
      part: ['id', 'status', 'cdn'],
      id: [streamId],
    });
    return res.data.items?.[0] || null;
  }
}

module.exports = YoutubeClient;
module.exports.refreshGoogleToken = refreshGoogleToken;
