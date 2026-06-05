const EventEmitter = require('events');
const ObsClient = require('./client');

// OBS 송출 PC의 상태를 폴링 + 이벤트 구독으로 수집.
// 외부에는 통합된 'state' 이벤트로 노출한다.
class ObsMonitor extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.client = new ObsClient(settings);
    this.timer = null;
    this.reconnectTimer = null;
    this.lastState = null;
    this.lastStreamBytesSample = null;
    this.offlineEmitted = false;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    try {
      await this.client.connect();
      this.offlineEmitted = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    } catch (err) {
      this.emit('error', err);
      this.emitOfflineState();
      this.scheduleReconnect();
      return;
    }

    this.client.on('ConnectionClosed', () => {
      if (this.stopped) return;
      this.emit('error', new Error('OBS WebSocket 연결이 끊겼습니다.'));
      this.emitOfflineState();
      this.scheduleReconnect();
    });

    // OBS WebSocket v5: high-volume meter 이벤트. 약 10Hz로 들어옴.
    this.client.on('InputVolumeMeters', (data) => {
      if (this.offlineEmitted) return;
      if (!this.lastState || typeof this.lastState.streaming !== 'boolean') return;
      this.lastState = { ...this.lastState, audioMeters: data.inputs, ts: Date.now() };
      this.emit('state', this.lastState);
    });

    this.timer = setInterval(() => this.poll(), this.settings.pollIntervalMs);
    await this.poll();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.timer = null;
    this.reconnectTimer = null;
    await this.client.disconnect();
  }

  async poll() {
    if (this.stopped) return;
    try {
      const [streamStatus, recordStatus, stats, scene] = await Promise.all([
        this.client.call('GetStreamStatus'),
        this.client.call('GetRecordStatus'),
        this.client.call('GetStats'),
        this.client.call('GetCurrentProgramScene'),
      ]);
      const now = Date.now();
      const bitrateKbps = this.calculateBitrateKbps(streamStatus, now);
      const currentSceneName = scene.currentProgramSceneName;
      const currentSceneSources = await this.getCurrentSceneSources(currentSceneName);

      this.lastState = {
        ts: now,
        streaming: streamStatus.outputActive,
        recording: recordStatus.outputActive,
        bitrateKbps,
        cpuUsage: stats.cpuUsage,
        memoryUsageMb: stats.memoryUsage,
        droppedFrames: stats.outputSkippedFrames || 0,
        totalFrames: stats.outputTotalFrames || 0,
        renderSkippedFrames: stats.renderSkippedFrames || 0,
        scene: currentSceneName,
        sources: currentSceneSources,
        audioMeters: this.lastState?.audioMeters || [],
      };

      this.emit('state', this.lastState);
    } catch (err) {
      if (this.stopped) return;
      this.emit('error', err);
      this.emitOfflineState();
      this.scheduleReconnect();
    }
  }

  async getCurrentSceneSources(sceneName) {
    if (!sceneName) return [];
    try {
      const result = await this.client.call('GetSceneItemList', { sceneName });
      return (result?.sceneItems || [])
        .map((item) => item.sourceName)
        .filter(Boolean);
    } catch {
      return this.lastState?.sources || [];
    }
  }

  calculateBitrateKbps(streamStatus, now) {
    if (!streamStatus.outputActive) {
      this.lastStreamBytesSample = null;
      return 0;
    }

    const bytes = Number(streamStatus.outputBytes);
    if (!Number.isFinite(bytes)) return this.lastState?.bitrateKbps ?? null;

    const prev = this.lastStreamBytesSample;
    this.lastStreamBytesSample = { bytes, ts: now };
    if (!prev || bytes < prev.bytes || now <= prev.ts) return this.lastState?.bitrateKbps ?? null;

    const elapsedSeconds = (now - prev.ts) / 1000;
    if (elapsedSeconds <= 0) return this.lastState?.bitrateKbps ?? null;
    return Math.max(0, Math.round(((bytes - prev.bytes) * 8) / elapsedSeconds / 1000));
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.client.disconnect(); } catch {}
      this.client = new ObsClient(this.settings);
      await this.start();
    }, 3000);
  }

  emitOfflineState() {
    if (this.offlineEmitted) return;
    const prev = this.lastState || {};
    this.offlineEmitted = true;
    this.lastStreamBytesSample = null;
    this.lastState = {
      ...prev,
      ts: Date.now(),
      obsConnected: false,
      streaming: false,
      recording: false,
      bitrateKbps: 0,
      audioMeters: [],
      sources: [],
    };
    this.emit('state', this.lastState);
  }
}

module.exports = ObsMonitor;
