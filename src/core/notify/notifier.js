const KakaoChannel = require('./kakao');
const KakaoBizChannel = require('./kakao-biz');
const DiscordChannel = require('./discord');
const TelegramChannel = require('./telegram');

const MESSAGES = {
  OBS_STREAM_STARTED: 'OBS 송출이 시작되었습니다.',
  OBS_STREAM_STOPPED: 'OBS 송출이 종료되었습니다.',
  OBS_STREAM_OFF: 'OBS 송출이 꺼져 있습니다. 송출을 시작하세요.',
  OBS_STREAM_REPORT: '방송 리포트',
  OBS_RECORD_STARTED: '녹화가 시작되었습니다.',
  OBS_RECORD_STOPPED: '녹화가 종료되었습니다.',
  OBS_AUDIO_SILENCE: '오디오가 신호가 감지되지 않습니다. 오디오 상태를 확인하세요.',
  OBS_AUDIO_PEAK: '오디오 피크가 감지되었습니다. 오디오 상태를 확인하세요.',
  OBS_BITRATE_LOW: 'OBS 비트레이트가 기준보다 낮습니다.',
  OBS_BITRATE_RECOVERED: 'OBS 비트레이트가 정상 범위로 복구되었습니다.',
  OBS_DROPPED_FRAMES_HIGH: 'OBS 드롭 프레임 비율이 높습니다.',
  OBS_DROPPED_FRAMES_RECOVERED: 'OBS 드롭 프레임 비율이 정상으로 복구되었습니다.',
  LUFS_TOO_LOUD: '-14 LUFS를 초과했습니다. 스트리밍 레벨을 조절해주세요.',
  LUFS_TOO_QUIET: '-25 LUFS에 도달하지 못했습니다. 스트리밍 레벨을 조절해주세요.',
  LUFS_RECOVERED: '적정 LUFS로 복구되었습니다.',
  YOUTUBE_LIVE_DETECTED: 'YouTube 라이브 방송이 시작되었습니다.',
  YOUTUBE_LIVE_ENDED: 'YouTube 라이브 방송이 종료되었습니다.',
  YOUTUBE_OFFLINE: 'YouTube 라이브가 감지되지 않습니다. 라이브 상태를 확인하세요.',
  YOUTUBE_HEALTH_BAD: 'YouTube 스트림 헬스 이상이 감지되었습니다.',
  YOUTUBE_HEALTH_RECOVERED: 'YouTube 스트림 헬스가 정상으로 복구되었습니다.',
  YOUTUBE_CONFIG_ISSUE: 'YouTube 스트림 설정 이슈가 발생했습니다.',
};

const SEVERITY_BY_TYPE = {
  OBS_AUDIO_SILENCE: '[긴급]',
  OBS_STREAM_OFF: '[긴급]',
  YOUTUBE_OFFLINE: '[오류]',
  OBS_AUDIO_PEAK: '[오류]',
  OBS_BITRATE_LOW: '[오류]',
  OBS_DROPPED_FRAMES_HIGH: '[오류]',
  LUFS_TOO_LOUD: '[오류]',
  LUFS_TOO_QUIET: '[오류]',
  YOUTUBE_HEALTH_BAD: '[오류]',
  YOUTUBE_CONFIG_ISSUE: '[오류]',
  OBS_STREAM_STARTED: '[알림]',
  OBS_STREAM_STOPPED: '[알림]',
  OBS_RECORD_STARTED: '[알림]',
  OBS_RECORD_STOPPED: '[알림]',
  OBS_BITRATE_RECOVERED: '[알림]',
  OBS_DROPPED_FRAMES_RECOVERED: '[알림]',
  LUFS_RECOVERED: '[알림]',
  YOUTUBE_LIVE_DETECTED: '[알림]',
  YOUTUBE_LIVE_ENDED: '[알림]',
  YOUTUBE_HEALTH_RECOVERED: '[알림]',
};

class Notifier {
  constructor(settings) {
    this.channels = [];
    if (settings.kakao?.enabled) this.channels.push(new KakaoChannel(settings.kakao));
    if (settings.kakaoBiz?.enabled) this.channels.push(new KakaoBizChannel(settings.kakaoBiz));
    if (settings.discord?.enabled) this.channels.push(new DiscordChannel(settings.discord));
    if (settings.telegram?.enabled) this.channels.push(new TelegramChannel(settings.telegram));
  }

  async dispatch(alert) {
    const text = this.format(alert);
    if (!text) return;
    await Promise.allSettled(this.channels.map((ch) => ch.send(text)));
  }

  async test(channelName) {
    const ch = this.channels.find((c) => c.name === channelName);
    if (!ch) throw new Error(`알림 채널을 찾을 수 없습니다: ${channelName}`);
    const result = await ch.send('[테스트] Stream Capture 알림 채널 연결 확인');
    return { ok: true, ...result };
  }

  format(alert) {
    if (alert.type === 'OBS_STREAM_REPORT') return null;
    if (alert.type === 'SCENARIO_CHECK_FAILED' && alert.message) {
      const time = new Date(alert.ts || Date.now()).toLocaleString('ko-KR');
      return `[${time}] ${alert.message}`;
    }
    if (alert.type === 'YOUTUBE_LIVE_ENDED' && alert.report) return this.formatYoutubeEndReport(alert);

    const base = MESSAGES[alert.type] || alert.type;
    const time = new Date(alert.ts || Date.now()).toLocaleString('ko-KR');
    const sev = SEVERITY_BY_TYPE[alert.type];
    const prefix = sev ? `${sev} ` : '';
    const includeUrl = alert.type === 'YOUTUBE_LIVE_DETECTED' && alert.url;
    const extra = includeUrl ? `\n${alert.url}` : '';
    return `[${time}] ${prefix}${base}${extra}`;
  }

  formatYoutubeEndReport(alert) {
    return this.formatReport('YouTube 라이브 방송이 종료되었습니다.', alert, '[알림]');
  }

  formatStreamReport(alert) {
    return this.formatReport('방송 리포트', alert, '[알림]');
  }

  formatReport(title, alert, severity) {
    const report = alert.report || {};
    const time = new Date(alert.ts || Date.now()).toLocaleString('ko-KR');
    const prefix = severity ? `${severity} ` : '';
    const lines = [
      `[${time}] ${prefix}${title}`,
      `방송 시간: ${formatDuration(report.durationMs)}`,
      `평균 LUFS: ${formatValue(report.averageLufs, ' LUFS')}`,
      `시청자 누적: ${formatValue(report.cumulativeViewers, '명')}`,
      `평균 시청자: ${formatValue(report.averageViewers, '명')}`,
      `최다 시청자: ${formatValue(report.maxViewers, '명')}`,
      `프레임 드랍: ${formatValue(report.droppedFrames, '프레임')} (${formatValue(report.droppedPct, '%')})`,
      `스킵 프레임: ${formatValue(report.skippedFrames, '프레임')}`,
      `CPU 평균/최대: ${formatValue(report.averageCpu, '%')} / ${formatValue(report.maxCpu, '%')}`,
    ];
    if (report.url) lines.push(report.url);
    return lines.join('\n');
  }
}

function formatValue(value, suffix = '') {
  return value == null ? '-' : `${value}${suffix}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h) return `${h}시간 ${m}분 ${s}초`;
  if (m) return `${m}분 ${s}초`;
  return `${s}초`;
}

module.exports = Notifier;
