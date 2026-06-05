// 룰 엔진: OBS / YouTube 상태 변화를 받아 사고 이벤트를 만들고 알림으로 디스패치.
//
// 최종 목표 이벤트:
//   - 방송 시작/종료 (OBS streaming state edge)
//   - 녹화 시작/종료 (OBS recording state edge)
//   - 오디오 무음 (OBS dBFS peak가 silenceDb 미만으로 N초간 지속)
//   - LUFS 레벨 과대/과소 (short-term LUFS가 정상 범위 밖으로 N초간 지속)
//   - YouTube 라이브 감지/종료

const DEFAULT_RULES = {
  audioSilenceSeconds: 5,
  audioSilenceDb: -65,
  audioSilenceStartupDelayMs: 60000,
  audioSilenceCooldownMs: 60000,
  audioPeakEnabled: false,
  audioPeakDb: -1,
  audioPeakCooldownMs: 5000,
  lufsEnabled: true,
  lufsHighThreshold: -14,
  lufsLowThreshold: -25,
  lufsDurationSeconds: 15,
  lufsStartupDelayMs: 60000,
  lufsRecoveryMargin: 1,
  lufsCooldownMs: 60000,
  bitrateMinKbps: 1500,
  bitrateStartupDelayMs: 60000,
  bitrateCooldownMs: 60000,
  droppedFramePctMax: 5.0,
  droppedFrameWindowSeconds: 30,
  droppedFrameMinFrames: 30,
  droppedFrameStartupDelayMs: 60000,
  droppedFrameCooldownMs: 300000,
  youtubeEventCooldownMs: 120000,
};

class RuleEngine {
  constructor({ notifier, onAlert, rules = {} }) {
    this.notifier = notifier;
    this.onAlert = onAlert;
    this.rules = { ...DEFAULT_RULES, ...rules };

    this.prevObs = null;
    this.prevYoutube = null;
    this.youtubeStableLive = false;
    this.streamingStartedAt = null;
    this.youtubeLiveDetectedAt = null;
    this.latestYoutube = null;
    this.prevDroppedFrames = null;
    this.prevTotalFrames = null;
    this.droppedFrameSamples = [];
    this.bitrateAlertActive = false;
    this.bitrateLastFiredAt = 0;
    this.droppedFrameAlertActive = false;
    this.droppedFrameLastFiredAt = 0;
    this.streamSession = null;
    this.completedStreamReport = null;

    this.silenceStartedAt = null;
    this.silenceFired = false;
    this.silenceLastFiredAt = 0;
    this.peakLastFiredAt = 0;
    this.audioFirstSeenAt = null; // 오디오 신호를 처음 수신한 시각 (송출 무관 무음 감지용 앵커)

    this.lufsCondition = null;
    this.lufsConditionStartedAt = null;
    this.lufsAlertState = 'normal';
    this.lufsLastFiredAt = 0;
    this.lufsSamples = [];
    this.lastAlertByKey = new Map();

    this.activeStageId = null; // 현재 시나리오 단계 ID
  }

  // 시나리오 단계 변경 시 호출. 알람을 허용하는 단계만 오디오/LUFS 체크를 수행한다.
  setActiveStage(stageId) {
    this.activeStageId = stageId ?? null;
  }

  isAlertStage() {
    // null이면 단계 미설정 → 기존 동작 유지 (알람 허용)
    if (this.activeStageId == null) return true;
    return ['start', 'sermon'].includes(this.activeStageId);
  }

  ingestObs(state) {
    const prev = this.prevObs;
    this.prevObs = state;

    if (!prev) {
      if (state.streaming) this.handleStreamStarted(state);
      if (state.recording) this.fire('OBS_RECORD_STARTED', { ts: state.ts });
    } else {
      if (prev.streaming !== state.streaming) {
        if (state.streaming) this.handleStreamStarted(state);
        else this.handleStreamStopped(state);
      }
      if (prev.recording !== state.recording) {
        this.fire(state.recording ? 'OBS_RECORD_STARTED' : 'OBS_RECORD_STOPPED', { ts: state.ts });
      }
    }

    this.accumulateObsSession(state);
    this.checkAudio(state);
    this.checkBitrate(state);
    this.checkDroppedFrames(state);
  }

  ingestLufs(state) {
    if (!this.rules.lufsEnabled) return;
    if (state.shortTerm == null || !Number.isFinite(state.shortTerm)) return;
    if (!this.isAlertStage()) {
      this.resetLufsCondition();
      this.lufsSamples = [];
      return;
    }

    const active = this.prevObs?.streaming || this.prevObs?.recording;
    if (!active) {
      this.resetLufsCondition();
      this.lufsSamples = [];
      return;
    }
    const now = state.ts ?? Date.now();
    if (!this.isAfterYoutubeLiveDelay(now, this.rules.lufsStartupDelayMs ?? 60000)) {
      this.resetLufsCondition();
      this.lufsSamples = [];
      return;
    }

    this.checkLufs(state);
    this.accumulateLufsSession(state);
  }

  ingestYoutube(state) {
    const prev = this.prevYoutube;
    this.prevYoutube = state;

    const now = state.ts ?? Date.now();
    const wasStableLive = this.youtubeStableLive;
    if (state.live && !wasStableLive) {
      this.youtubeStableLive = true;
      this.youtubeLiveDetectedAt = now;
      this.completedStreamReport = null;
      this.resetQualityStates();
      this.fire('YOUTUBE_LIVE_DETECTED', {
        ts: now,
        url: state.url,
      }, { dedupeMs: Number(this.rules.youtubeEventCooldownMs || 0), dedupeKey: `YOUTUBE_LIVE_DETECTED:${state.url || state.videoId || ''}` });
    } else if (!state.live && wasStableLive) {
      this.youtubeStableLive = false;
      this.youtubeLiveDetectedAt = null;
      this.resetQualityStates();
      this.fire('YOUTUBE_LIVE_ENDED', {
        ts: now,
        url: state.url || this.latestYoutube?.url,
        report: this.completedStreamReport,
      }, { dedupeMs: Number(this.rules.youtubeEventCooldownMs || 0), dedupeKey: `YOUTUBE_LIVE_ENDED:${this.latestYoutube?.url || state.url || state.videoId || ''}` });
      this.completedStreamReport = null;
    }

    if (state.live && state.url) this.latestYoutube = state;
    else if (!state.live) this.latestYoutube = null;
    this.accumulateYoutubeSession(state);

    // healthStatus 전이: 정상(good/ok) ↔ 비정상(bad/noData)
    if (prev && state.live && this.isAfterYoutubeLiveDelay(now, 60000)) {
      const wasBad = isHealthBad(prev.healthStatus);
      const isBad = isHealthBad(state.healthStatus);
      if (!wasBad && isBad) {
        this.fire('YOUTUBE_HEALTH_BAD', { ts: state.ts, healthStatus: state.healthStatus, url: state.url });
      } else if (wasBad && !isBad && state.healthStatus) {
        this.fire('YOUTUBE_HEALTH_RECOVERED', { ts: state.ts, healthStatus: state.healthStatus });
      }
    }

    // 새로 등장한 error 심각도의 configuration issue
    if (state.live && this.isAfterYoutubeLiveDelay(now, 60000)) {
      const prevTypes = new Set(((prev?.configurationIssues) || []).filter((i) => i.severity === 'error').map((i) => i.type));
      for (const issue of state.configurationIssues || []) {
        if (issue.severity === 'error' && !prevTypes.has(issue.type)) {
          this.fire('YOUTUBE_CONFIG_ISSUE', {
            ts: state.ts,
            issueType: issue.type,
            reason: issue.reason || issue.description || '',
          });
        }
      }
    }
  }

  handleStreamStarted(state) {
    this.streamingStartedAt = state.ts ?? Date.now();
    this.completedStreamReport = null;
    this.resetQualityStates();
    this.streamSession = this.createStreamSession(state);
    this.fire('OBS_STREAM_STARTED', { ts: state.ts }, { dedupeMs: 10000 });
  }

  handleStreamStopped(state) {
    this.accumulateObsSession(state);
    const report = this.finishStreamSession(state);
    this.streamingStartedAt = null;
    this.completedStreamReport = report;
    this.resetQualityStates();
    this.fire('OBS_STREAM_STOPPED', { ts: state.ts }, { dedupeMs: 10000 });
    if (report) this.fire('OBS_STREAM_REPORT', { ts: state.ts, report }, { dedupeMs: 10000 });
  }

  createStreamSession(state) {
    const now = state.ts ?? Date.now();
    const session = {
      startedAt: now,
      endedAt: null,
      url: this.latestYoutube?.url || null,
      lufs: [],
      viewersSum: 0,
      viewerSamples: 0,
      maxViewers: null,
      cpuSum: 0,
      cpuSamples: 0,
      maxCpu: null,
      startDroppedFrames: state.droppedFrames ?? 0,
      lastDroppedFrames: state.droppedFrames ?? 0,
      startRenderSkippedFrames: state.renderSkippedFrames ?? 0,
      lastRenderSkippedFrames: state.renderSkippedFrames ?? 0,
      startTotalFrames: state.totalFrames ?? 0,
      lastTotalFrames: state.totalFrames ?? 0,
    };
    if (Number.isFinite(this.latestYoutube?.concurrentViewers)) {
      session.viewersSum = this.latestYoutube.concurrentViewers;
      session.viewerSamples = 1;
      session.maxViewers = this.latestYoutube.concurrentViewers;
    }
    return session;
  }

  accumulateObsSession(state) {
    if (!this.streamSession || !state.streaming) return;
    if (Number.isFinite(state.cpuUsage)) {
      this.streamSession.cpuSum += state.cpuUsage;
      this.streamSession.cpuSamples += 1;
      this.streamSession.maxCpu = this.streamSession.maxCpu == null ? state.cpuUsage : Math.max(this.streamSession.maxCpu, state.cpuUsage);
    }
    if (state.droppedFrames != null) this.streamSession.lastDroppedFrames = state.droppedFrames;
    if (state.renderSkippedFrames != null) this.streamSession.lastRenderSkippedFrames = state.renderSkippedFrames;
    if (state.totalFrames != null) this.streamSession.lastTotalFrames = state.totalFrames;
  }

  accumulateLufsSession(state) {
    if (!this.streamSession || !this.prevObs?.streaming) return;
    if (Number.isFinite(state.shortTerm)) this.streamSession.lufs.push(state.shortTerm);
  }

  accumulateYoutubeSession(state) {
    if (!this.streamSession || !state.live) return;
    if (state.url) this.streamSession.url = state.url;
    if (Number.isFinite(state.concurrentViewers)) {
      this.streamSession.viewersSum += state.concurrentViewers;
      this.streamSession.viewerSamples += 1;
      this.streamSession.maxViewers = this.streamSession.maxViewers == null
        ? state.concurrentViewers
        : Math.max(this.streamSession.maxViewers, state.concurrentViewers);
    }
  }

  finishStreamSession(state) {
    if (!this.streamSession) return null;
    const session = this.streamSession;
    session.endedAt = state.ts ?? Date.now();
    this.streamSession = null;

    const durationMs = Math.max(0, session.endedAt - session.startedAt);
    const droppedFrames = Math.max(0, (session.lastDroppedFrames ?? 0) - (session.startDroppedFrames ?? 0));
    const skippedFrames = Math.max(0, (session.lastRenderSkippedFrames ?? 0) - (session.startRenderSkippedFrames ?? 0));
    const totalFrames = Math.max(0, (session.lastTotalFrames ?? 0) - (session.startTotalFrames ?? 0));
    const droppedPct = totalFrames ? (droppedFrames / totalFrames) * 100 : 0;

    return {
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs,
      url: session.url,
      averageLufs: round1(average(session.lufs)),
      viewerSamples: session.viewerSamples,
      cumulativeViewers: session.viewersSum,
      averageViewers: session.viewerSamples ? round1(session.viewersSum / session.viewerSamples) : null,
      maxViewers: session.maxViewers,
      droppedFrames,
      droppedPct: round1(droppedPct),
      skippedFrames,
      averageCpu: session.cpuSamples ? round1(session.cpuSum / session.cpuSamples) : null,
      maxCpu: session.maxCpu == null ? null : round1(session.maxCpu),
    };
  }

  // 오디오 메터에서 최대 peak를 뽑아 무음/피크를 판정.
  // 송출/녹화 여부와 무관하게, OBS 오디오 신호가 들어오면 무음을 감지한다.
  checkAudio(state) {
    if (!state.audioMeters || !state.audioMeters.length) {
      // 오디오 신호가 끊기면 앵커/카운터 초기화.
      this.audioFirstSeenAt = null;
      this.silenceStartedAt = null;
      this.silenceFired = false;
      return;
    }
    if (!this.isAlertStage()) {
      this.silenceStartedAt = null;
      this.silenceFired = false;
      return;
    }

    const now = state.ts ?? Date.now();
    if (this.audioFirstSeenAt == null) this.audioFirstSeenAt = now;

    // 시작 직후 오탐을 막기 위한 딜레이.
    // 스트림/라이브 시작 시점이 있으면 그걸, 없으면 오디오 최초 수신 시점을 기준으로 한다.
    const anchor = this.streamingStartedAt
      ?? this.youtubeLiveDetectedAt
      ?? this.audioFirstSeenAt;
    if (now - anchor < Number(this.rules.audioSilenceStartupDelayMs || 0)) {
      this.silenceStartedAt = null;
      this.silenceFired = false;
      return;
    }

    const maxPeakDb = maxPeakDbAcrossInputs(state.audioMeters);

    // 피크
    if (this.rules.audioPeakEnabled && maxPeakDb >= this.rules.audioPeakDb) {
      if (now - this.peakLastFiredAt > this.rules.audioPeakCooldownMs) {
        this.peakLastFiredAt = now;
        this.fire('OBS_AUDIO_PEAK', { ts: now, peakDb: round1(maxPeakDb) });
      }
    }

    // 무음
    if (maxPeakDb < this.rules.audioSilenceDb) {
      if (this.silenceStartedAt === null) {
        this.silenceStartedAt = now;
      } else if (now - this.silenceStartedAt >= this.rules.audioSilenceSeconds * 1000) {
        const cooldown = Number(this.rules.audioSilenceCooldownMs || 0);
        // 쿨다운마다 재발동 (silenceFired로 막지 않음)
        if (!this.silenceLastFiredAt || now - this.silenceLastFiredAt >= cooldown) {
          this.silenceFired = true;
          this.silenceLastFiredAt = now;
          this.fire('OBS_AUDIO_SILENCE', {
            ts: now,
            durationMs: now - this.silenceStartedAt,
            peakDb: round1(maxPeakDb),
          });
        }
      }
    } else {
      this.silenceStartedAt = null;
      this.silenceFired = false;
    }
  }

  checkLufs(state) {
    const now = state.ts ?? Date.now();
    const high = Number(this.rules.lufsHighThreshold);
    const low = Number(this.rules.lufsLowThreshold);
    const margin = Math.max(0, Number(this.rules.lufsRecoveryMargin) || 0);
    const durationMs = Math.max(1, Number(this.rules.lufsDurationSeconds) || 15) * 1000;
    this.lufsSamples.push({ ts: now, value: state.shortTerm });
    // 버퍼를 2배로 유지해서 느린 샘플링(2초 간격)에도 durationMs 스팬을 확보한다.
    this.lufsSamples = this.lufsSamples.filter((sample) => now - sample.ts <= durationMs * 2);
    if (this.lufsSamples.length < 2) return;
    // 가장 오래된 샘플이 durationMs 이전 것이어야 충분한 데이터가 쌓인 것
    if (now - this.lufsSamples[0].ts < durationMs) return;
    // 실제 판정은 최근 durationMs 이내의 샘플 평균으로만
    const cutoff = now - durationMs;
    const value = average(this.lufsSamples.filter((s) => s.ts >= cutoff).map((s) => s.value));
    if (value == null) return;

    let condition = 'normal';
    if (this.lufsAlertState === 'high' || this.lufsAlertState === 'low') {
      if (value >= high) {
        condition = 'high';
      } else if (value <= low) {
        condition = 'low';
      } else {
        condition = value < high - margin && value > low + margin ? 'recovered' : this.lufsAlertState;
      }
    } else if (value >= high) {
      condition = 'high';
    } else if (value <= low) {
      condition = 'low';
    }

    if (condition === 'normal') {
      this.resetLufsCondition();
      return;
    }

    if (condition === 'recovered') {
      if (this.lufsAlertState !== 'normal') {
        this.lufsAlertState = 'normal';
        this.resetLufsCondition();
        this.fire('LUFS_RECOVERED', { ts: now, shortTermLufs: round1(value) });
        this.resetLufsSamples(now);
      }
      return;
    }

    // 같은 상태라도 쿨다운이 지나면 재발동 (부족/과다 상태 지속 중 반복 알림)
    const cooldown = Number(this.rules.lufsCooldownMs || 0);
    if (this.lufsLastFiredAt && now - this.lufsLastFiredAt < cooldown) return;

    this.lufsAlertState = condition;
    this.lufsLastFiredAt = now;
    this.fire(condition === 'high' ? 'LUFS_TOO_LOUD' : 'LUFS_TOO_QUIET', {
      ts: now,
      shortTermLufs: round1(value),
      thresholdLufs: condition === 'high' ? high : low,
    });
    this.resetLufsSamples(now);
  }

  resetLufsCondition() {
    this.lufsCondition = null;
    this.lufsConditionStartedAt = null;
  }

  resetLufsSamples(now = Date.now()) {
    const lastValue = this.lufsSamples.length ? this.lufsSamples[this.lufsSamples.length - 1].value : null;
    this.lufsSamples = [{ ts: now, value: lastValue }].filter((sample) => sample.value != null);
  }

  resetQualityStates() {
    this.silenceStartedAt = null;
    this.silenceFired = false;
    this.bitrateAlertActive = false;
    this.droppedFrameAlertActive = false;
    this.droppedFrameSamples = [];
    this.prevDroppedFrames = null;
    this.prevTotalFrames = null;
    this.resetLufsCondition();
    this.lufsSamples = [];
    this.lufsAlertState = 'normal';
  }

  checkBitrate(state) {
    if (!state.streaming) {
      this.bitrateAlertActive = false;
      return;
    }
    if (state.bitrateKbps == null) return;

    const now = state.ts ?? Date.now();
    if (!this.isAfterYoutubeLiveDelay(now, this.rules.bitrateStartupDelayMs)) return;
    const min = Number(this.rules.bitrateMinKbps || 0);
    if (min <= 0) return;

    if (state.bitrateKbps < min) {
      if (!this.bitrateAlertActive && (!this.bitrateLastFiredAt || now - this.bitrateLastFiredAt >= Number(this.rules.bitrateCooldownMs || 0))) {
        this.bitrateAlertActive = true;
        this.bitrateLastFiredAt = now;
        this.fire('OBS_BITRATE_LOW', { ts: now, bitrateKbps: state.bitrateKbps, thresholdKbps: min });
      }
    } else if (this.bitrateAlertActive) {
      this.bitrateAlertActive = false;
      this.fire('OBS_BITRATE_RECOVERED', { ts: now, bitrateKbps: state.bitrateKbps });
    }
  }

  checkDroppedFrames(state) {
    if (!state.streaming) {
      this.droppedFrameAlertActive = false;
      this.prevDroppedFrames = state.droppedFrames ?? null;
      this.prevTotalFrames = state.totalFrames ?? null;
      this.droppedFrameSamples = [];
      return;
    }
    if (state.droppedFrames == null || state.totalFrames == null) return;

    const now = state.ts ?? Date.now();
    if (!this.isAfterYoutubeLiveDelay(now, this.rules.droppedFrameStartupDelayMs)) {
      this.prevDroppedFrames = state.droppedFrames;
      this.prevTotalFrames = state.totalFrames;
      this.droppedFrameSamples = [{ ts: now, droppedFrames: state.droppedFrames, totalFrames: state.totalFrames }];
      return;
    }

    const windowMs = Math.max(1, Number(this.rules.droppedFrameWindowSeconds) || 30) * 1000;
    this.droppedFrameSamples.push({ ts: now, droppedFrames: state.droppedFrames, totalFrames: state.totalFrames });
    this.droppedFrameSamples = this.droppedFrameSamples.filter((sample) => now - sample.ts <= windowMs * 2);
    const baseline = this.droppedFrameSamples.find((sample) => now - sample.ts >= windowMs) || this.droppedFrameSamples[0];

    this.prevDroppedFrames = state.droppedFrames;
    this.prevTotalFrames = state.totalFrames;
    if (!baseline || now - baseline.ts < windowMs) return;

    const droppedDelta = Math.max(0, state.droppedFrames - baseline.droppedFrames);
    const totalDelta = Math.max(0, state.totalFrames - baseline.totalFrames);
    if (!totalDelta) return;

    const droppedPct = (droppedDelta / totalDelta) * 100;
    const maxPct = Number(this.rules.droppedFramePctMax || 0);
    const minFrames = Math.max(0, Number(this.rules.droppedFrameMinFrames) || 0);
    if (maxPct <= 0) return;

    if (droppedDelta >= minFrames && droppedPct > maxPct) {
      if (!this.droppedFrameAlertActive && (!this.droppedFrameLastFiredAt || now - this.droppedFrameLastFiredAt >= Number(this.rules.droppedFrameCooldownMs || 0))) {
        this.droppedFrameAlertActive = true;
        this.droppedFrameLastFiredAt = now;
        this.fire('OBS_DROPPED_FRAMES_HIGH', {
          ts: now,
          droppedPct: round1(droppedPct),
          droppedFrames: droppedDelta,
          thresholdPct: maxPct,
        });
      }
    } else if (this.droppedFrameAlertActive && droppedPct <= maxPct / 2) {
      this.droppedFrameAlertActive = false;
      this.fire('OBS_DROPPED_FRAMES_RECOVERED', { ts: now, droppedPct: round1(droppedPct) });
    }
  }

  isAfterYoutubeLiveDelay(now, delayMs) {
    // OBS 스트리밍 또는 YouTube Live 중 가장 최근 시작 기준으로 딜레이 계산.
    // YouTube 없이 OBS만 스트리밍 중인 경우에도 딜레이 후 알림이 작동해야 한다.
    const anchors = [];
    if (this.youtubeLiveDetectedAt && this.youtubeStableLive && this.prevYoutube?.live) {
      anchors.push(this.youtubeLiveDetectedAt);
    }
    if (this.streamingStartedAt) anchors.push(this.streamingStartedAt);
    if (!anchors.length) return false;
    return now - Math.max(...anchors) >= Number(delayMs || 0);
  }

  fire(type, payload, options = {}) {
    const now = payload?.ts ?? Date.now();
    const dedupeMs = Number(options.dedupeMs || 0);
    const dedupeKey = options.dedupeKey || type;
    if (dedupeMs > 0) {
      const lastAt = this.lastAlertByKey.get(dedupeKey) || 0;
      if (lastAt && now - lastAt < dedupeMs) return;
      this.lastAlertByKey.set(dedupeKey, now);
    }
    const alert = { type, ...payload };
    this.onAlert?.(alert);
    this.notifier?.dispatch(alert);
  }
}

function isHealthBad(status) {
  return status === 'bad' || status === 'noData';
}

function maxPeakDbAcrossInputs(inputs) {
  let maxMul = 0;
  for (const input of inputs) {
    const levels = input.inputLevelsMul || [];
    for (const ch of levels) {
      const peak = ch?.[1] ?? 0;
      if (peak > maxMul) maxMul = peak;
    }
  }
  return maxMul > 0 ? 20 * Math.log10(maxMul) : -Infinity;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

module.exports = RuleEngine;
module.exports.DEFAULT_RULES = DEFAULT_RULES;
module.exports.maxPeakDbAcrossInputs = maxPeakDbAcrossInputs;
