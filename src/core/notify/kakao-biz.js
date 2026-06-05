const axios = require('axios');
const crypto = require('crypto');

function buildAuthorization(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function splitRecipients(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((phone) => phone.replace(/[^\d]/g, ''))
    .filter(Boolean);
}

class KakaoBizChannel {
  constructor({
    apiKey,
    apiSecret,
    pfId,
    templateId,
    from,
    recipients,
    variableName = '#{message}',
    disableSms = true,
  }) {
    this.name = 'kakaoBiz';
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.pfId = pfId;
    this.templateId = templateId;
    this.from = from;
    this.recipients = splitRecipients(recipients);
    this.variableName = variableName || '#{message}';
    this.disableSms = disableSms !== false;
  }

  async send(text) {
    this.assertReady();

    const messages = this.recipients.map((to) => ({
      to,
      from: this.from ? this.from.replace(/[^\d]/g, '') : '',
      type: 'ATA',
      text,
      kakaoOptions: {
        pfId: this.pfId,
        templateId: this.templateId,
        disableSms: this.disableSms,
        variables: {
          [this.variableName]: text,
        },
      },
    }));

    return axios.post(
      'https://api.solapi.com/messages/v4/send-many/detail',
      {
        messages,
        strict: false,
        allowDuplicates: false,
      },
      {
        headers: {
          Authorization: buildAuthorization(this.apiKey, this.apiSecret),
          'Content-Type': 'application/json',
        },
      },
    );
  }

  assertReady() {
    const missing = [];
    if (!this.apiKey) missing.push('API Key');
    if (!this.apiSecret) missing.push('API Secret');
    if (!this.pfId) missing.push('카카오 채널 연동 ID');
    if (!this.templateId) missing.push('알림톡 템플릿 ID');
    if (!this.recipients.length) missing.push('수신번호');
    if (missing.length) throw new Error(`SOLAPI 알림톡 설정이 부족합니다: ${missing.join(', ')}`);
  }
}

module.exports = KakaoBizChannel;
