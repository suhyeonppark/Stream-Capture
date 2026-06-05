const EventEmitter = require('events');
const YoutubeClient = require('./client');

// YouTube Live 플랫폼이 실제로 방송을 받고 있는지 감시.
// OAuth 모드: liveBroadcasts + liveStreams + videos → healthStatus, configurationIssues, 시청자 수까지.
// API 키 모드: search.list로 현재 라이브 videoId 탐색 후 videos.list로 상세.
class YoutubeMonitor extends EventEmitter {
  constructor(settings, callbacks = {}) {
    super();
    this.settings = settings;
    this.callbacks = callbacks;
    this.client = new YoutubeClient({
      apiKey: settings.apiKey,
      oauth: settings.oauth,
      onTokenRefresh: callbacks.onTokenRefresh,
    });
    this.timer = null;
    this.currentVideoId = null;
    this.lastLive = false;
    this.lastState = null;
    this.liveMissCount = 0;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    if (this.client.mode === 'none') {
      this.emit('error', new Error('YouTube 자격증명이 없습니다. OAuth 연결 또는 API 키 + 채널 ID를 설정하세요.'));
      return;
    }
    if (this.client.mode === 'apiKey' && !this.settings.channelId) {
      this.emit('error', new Error('API 키 모드에는 channelId가 필요합니다.'));
      return;
    }
    await this.poll();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  async poll() {
    try {
      if (this.client.mode === 'oauth') await this.pollOAuth();
      else await this.pollApiKey();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.scheduleNextPoll();
    }
  }

  scheduleNextPoll() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), this.getPollIntervalMs());
  }

  getPollIntervalMs() {
    const configured = Number(this.settings.pollIntervalMs) || 15000;
    if (this.client.mode === 'oauth') {
      return this.lastLive ? Math.max(configured, 15000) : Math.max(configured, 30000);
    }
    return this.lastLive ? Math.max(configured, 60000) : Math.max(configured, 300000);
  }

  async pollOAuth() {
    const broadcasts = await this.client.listActiveBroadcasts();
    if (!broadcasts.length) {
      if (this.lastLive && this.liveMissCount < 2) {
        this.liveMissCount += 1;
        if (this.lastState) this.emit('state', { ...this.lastState, ts: Date.now(), live: true, livePendingEnd: true });
        return;
      }
      const state = { ts: Date.now(), live: false, mode: 'oauth' };
      this.emit('state', state);
      this.lastState = state;
      this.currentVideoId = null;
      this.lastLive = false;
      this.liveMissCount = 0;
      return;
    }

    const b = broadcasts[0];
    const videoId = b.id;
    const streamId = b.contentDetails?.boundStreamId || null;

    let healthStatus = null;
    let healthLastUpdate = null;
    let configurationIssues = [];
    let streamStatus = null;
    if (streamId) {
      const stream = await this.client.getLiveStream(streamId);
      const h = stream?.status?.healthStatus;
      streamStatus = stream?.status?.streamStatus || null;
      healthStatus = h?.status || null;
      healthLastUpdate = h?.lastUpdateTimeSeconds || null;
      configurationIssues = h?.configurationIssues || [];
    }

    // 시청자 수는 videos.list가 필요 (liveBroadcasts에는 statistics가 없음)
    let concurrentViewers = null;
    let activeLiveChatId = null;
    try {
      const details = await this.client.getVideoDetails(videoId);
      concurrentViewers = Number(details?.liveStreamingDetails?.concurrentViewers || 0);
      activeLiveChatId = details?.liveStreamingDetails?.activeLiveChatId || null;
    } catch {}

    this.currentVideoId = videoId;
    this.lastLive = true;
    this.liveMissCount = 0;
    const state = {
      ts: Date.now(),
      mode: 'oauth',
      live: true,
      videoId,
      url: `https://youtu.be/${videoId}`,
      title: b.snippet?.title,
      broadcastStatus: b.status?.lifeCycleStatus,  // testing, live, complete, ...
      streamStatus,
      healthStatus,
      healthLastUpdate,
      configurationIssues,
      concurrentViewers,
      activeLiveChatId,
    };
    this.lastState = state;
    this.emit('state', state);
  }

  async pollApiKey() {
    const videoId = await this.client.findActiveLiveVideoId(this.settings.channelId);
    if (!videoId) {
      if (this.lastLive && this.liveMissCount < 2) {
        this.liveMissCount += 1;
        if (this.lastState) this.emit('state', { ...this.lastState, ts: Date.now(), live: true, livePendingEnd: true });
        return;
      }
      const state = { ts: Date.now(), live: false, mode: 'apiKey' };
      this.emit('state', state);
      this.lastState = state;
      this.currentVideoId = null;
      this.lastLive = false;
      this.liveMissCount = 0;
      return;
    }

    const details = await this.client.getVideoDetails(videoId);
    if (!details) return;

    this.currentVideoId = videoId;
    this.lastLive = true;
    this.liveMissCount = 0;
    const state = {
      ts: Date.now(),
      mode: 'apiKey',
      live: true,
      videoId,
      url: `https://youtu.be/${videoId}`,
      title: details.snippet?.title,
      concurrentViewers: Number(details.liveStreamingDetails?.concurrentViewers || 0),
      activeLiveChatId: details.liveStreamingDetails?.activeLiveChatId || null,
      broadcastStatus: details.snippet?.liveBroadcastContent,
    };
    this.lastState = state;
    this.emit('state', state);
  }
}

module.exports = YoutubeMonitor;
