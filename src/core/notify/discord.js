const axios = require('axios');

class DiscordChannel {
  constructor({ webhookUrl }) {
    this.name = 'discord';
    this.webhookUrl = webhookUrl;
  }

  async send(content) {
    return axios.post(this.webhookUrl, { content });
  }
}

module.exports = DiscordChannel;
