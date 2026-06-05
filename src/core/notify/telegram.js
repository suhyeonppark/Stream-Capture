const axios = require('axios');

class TelegramChannel {
  constructor({ botToken, chatId, chatIds }) {
    this.name = 'telegram';
    this.botToken = botToken;
    this.chatIds = TelegramChannel.normalizeChatIds(chatIds || chatId);
  }

  static normalizeChatIds(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    return String(value || '')
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async send(text) {
    if (!this.botToken) {
      throw new Error('Telegram Bot Token을 입력하세요.');
    }
    if (!this.chatIds.length) {
      throw new Error('Telegram Chat ID를 하나 이상 입력하세요.');
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const results = await Promise.all(
      this.chatIds.map(async (chatId) => {
        try {
          const res = await axios.post(
            url,
            { chat_id: chatId, text },
            { validateStatus: () => true },
          );
          return {
            chatId,
            ok: !!res.data?.ok,
            status: res.status,
            description: res.data?.description,
          };
        } catch (err) {
          return {
            chatId,
            ok: false,
            status: err.response?.status,
            description: err.response?.data?.description || err.message,
          };
        }
      }),
    );
    const failed = results.filter((result) => !result.ok);
    if (failed.length) {
      const sent = results.length - failed.length;
      const details = failed.slice(0, 3)
        .map((result) => `${result.chatId}: ${result.description || `HTTP ${result.status}`}`)
        .join(' / ');
      throw new Error(`Telegram 전송 실패 (성공 ${sent}, 실패 ${failed.length}/${this.chatIds.length}) ${details}`);
    }
    return { ok: true, sent: results.length, total: this.chatIds.length };
  }
}

module.exports = TelegramChannel;
