const axios = require('axios');

// 카카오 알림 채널.
// mode === 'channel': 카카오 비즈니스 채널 구독자에게 발송.
// mode === 'memo'   : 나에게 보내기 (기본).
class KakaoChannel {
  constructor({ accessToken, refreshToken, restApiKey, mode, channelPublicId }) {
    this.name = 'kakao';
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.restApiKey = restApiKey;
    this.mode = mode || 'memo';
    this.channelPublicId = channelPublicId || '';
  }

  async send(text) {
    try {
      return await this.post(text);
    } catch (err) {
      if (err.response?.status === 401 && this.refreshToken) {
        await this.refresh();
        return this.post(text);
      }
      throw err;
    }
  }

  async post(text) {
    if (this.mode === 'channel' && this.channelPublicId) {
      return this.postChannel(text);
    }
    return this.postMemo(text);
  }

  async postMemo(text) {
    const url = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
    const template = {
      object_type: 'text',
      text,
      link: { web_url: 'https://developers.kakao.com', mobile_web_url: 'https://developers.kakao.com' },
      button_title: '확인',
    };
    return axios.post(url, new URLSearchParams({ template_object: JSON.stringify(template) }).toString(), {
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async postChannel(text) {
    const url = `https://kapi.kakao.com/v1/api/talk/channels/${encodeURIComponent(this.channelPublicId)}/message`;
    const template = {
      object_type: 'text',
      text,
      link: { web_url: 'https://developers.kakao.com', mobile_web_url: 'https://developers.kakao.com' },
    };
    return axios.post(url, new URLSearchParams({ template_object: JSON.stringify(template) }).toString(), {
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async refresh() {
    const res = await axios.post(
      'https://kauth.kakao.com/oauth/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.restApiKey,
        refresh_token: this.refreshToken,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    this.accessToken = res.data.access_token;
    if (res.data.refresh_token) this.refreshToken = res.data.refresh_token;
  }
}

module.exports = KakaoChannel;
